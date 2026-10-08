#!/usr/bin/env node
// Is the speech server up, and is each model on it healthy?
//
//   npm run server:health      the two /health endpoints, a few seconds, no keys needed
//   npm run server:check       also a real round trip: the TTS speaks a sentence and the
//                              ASR transcribes it, with each key, plus a keyless request
//                              that must be refused
//
// Plain Node 20+, no dependencies, so it can be copied into another project as is. Keys are
// read from ~/.config/qwen-tts/key and ~/.config/asr/key and only ever sent as headers:
// never printed. Exit code 0 when everything checked is healthy, 1 otherwise.
//
// Override the addresses with TTS_URL / ASR_URL, the key files with TTS_KEY_FILE /
// ASR_KEY_FILE. Servers: deploy/tts-server/ and deploy/asr-server/.

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const deep = process.argv.includes("--deep");
const servers = [
  {
    name: "TTS (text to speech)",
    url: (process.env.TTS_URL ?? "https://tts.jasenpan.com").replace(/\/+$/, ""),
    keyFile: process.env.TTS_KEY_FILE ?? join(homedir(), ".config/qwen-tts/key"),
  },
  {
    name: "ASR (speech to text)",
    url: (process.env.ASR_URL ?? "https://asr.jasenpan.com").replace(/\/+$/, ""),
    keyFile: process.env.ASR_KEY_FILE ?? join(homedir(), ".config/asr/key"),
  },
];
const SENTENCE = "This is a health check of the speech server.";

let healthy = true;
const say = (ok, line) => {
  if (!ok) healthy = false;
  console.log(`  ${ok ? "✓" : "✗"} ${line}`);
};

// What a failed request most likely means for this setup: an EC2 instance behind an
// Elastic IP with Caddy in front of the model servers.
function explain(err) {
  // A timeout is a DOMException whose `code` is the number 23, so its name decides.
  const timedOut = err?.name === "TimeoutError" || err?.name === "AbortError";
  const code = timedOut ? "TimeoutError" : (err?.cause?.code ?? err?.code ?? err?.name);
  switch (code) {
    case "ENOTFOUND":
      return "the name doesn't resolve: check the DNS record";
    case "ECONNREFUSED":
      return "the machine answers but nothing listens on HTTPS: is Caddy running?";
    case "UND_ERR_CONNECT_TIMEOUT":
    case "TimeoutError":
    case "AbortError":
      return "no answer: the instance is most likely stopped";
    default:
      if (String(code).includes("CERT") || String(err?.cause?.message).includes("certificate")) {
        return `certificate problem (${code}): Caddy may still be getting one`;
      }
      return `unreachable (${code ?? err?.message ?? err})`;
  }
}

async function timed(fn) {
  const started = performance.now();
  const result = await fn();
  return [result, ((performance.now() - started) / 1000).toFixed(2)];
}

async function readKey(file) {
  try {
    return (await readFile(file, "utf8")).trim();
  } catch {
    return null;
  }
}

async function health(server) {
  try {
    const [res, s] = await timed(() =>
      fetch(`${server.url}/health`, { signal: AbortSignal.timeout(8_000) })
    );
    if (res.status === 200) {
      say(true, `healthy (${s} s)`);
      return true;
    }
    if (res.status === 502 || res.status === 503) {
      say(false, `HTTP ${res.status}: the machine is up but the model isn't answering yet (allow 2-5 minutes after a start; otherwise check its container)`);
    } else {
      say(false, `HTTP ${res.status} from /health`);
    }
  } catch (err) {
    say(false, explain(err));
  }
  return false;
}

async function synthesize(tts, key) {
  const res = await fetch(`${tts.url}/v1/audio/speech`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ input: SENTENCE, voice: "serena", response_format: "wav" }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = Buffer.from(await res.arrayBuffer());
  return { status: res.status, body };
}

async function transcribe(asr, key, wav) {
  const form = new FormData();
  form.append("file", new Blob([wav], { type: "audio/wav" }), "check.wav");
  form.append("model", "Qwen/Qwen3-ASR-1.7B");
  form.append("response_format", "json");
  const res = await fetch(`${asr.url}/v1/audio/transcriptions`, {
    method: "POST",
    headers: key ? { Authorization: `Bearer ${key}` } : {},
    body: form,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  return { status: res.status, text };
}

async function roundTrip(tts, asr) {
  const ttsKey = await readKey(tts.keyFile);
  const asrKey = await readKey(asr.keyFile);
  if (!ttsKey) return say(false, `no TTS key at ${tts.keyFile}`);
  if (!asrKey) return say(false, `no ASR key at ${asr.keyFile}`);

  let wav;
  try {
    const [{ status, body }, s] = await timed(() => synthesize(tts, ttsKey));
    const isWav = body.length > 12 && body.toString("latin1", 0, 4) === "RIFF";
    if (status === 401) return say(false, "TTS rejected its key (HTTP 401)");
    if (status !== 200 || !isWav) return say(false, `TTS answered HTTP ${status}, ${isWav ? "audio" : "not audio"}`);
    say(true, `TTS spoke the test sentence (${(body.length / 48_000).toFixed(1)} s of audio in ${s} s)`);
    wav = body;
  } catch (err) {
    return say(false, `TTS request failed: ${explain(err)}`);
  }

  try {
    const keyless = await transcribe(asr, null, wav);
    say(keyless.status === 401, keyless.status === 401
      ? "ASR refuses a request without a key (HTTP 401)"
      : `ASR answered a request without a key with HTTP ${keyless.status}: it should be 401`);

    const [{ status, text }, s] = await timed(() => transcribe(asr, asrKey, wav));
    if (status === 401) return say(false, "ASR rejected its key (HTTP 401)");
    if (status !== 200) return say(false, `ASR answered HTTP ${status}`);
    const heard = JSON.parse(text).text ?? "";
    const right = /health\s*check/i.test(heard);
    say(right, `ASR heard "${heard}" (${s} s)${right ? "" : ": expected the test sentence"}`);
  } catch (err) {
    say(false, `ASR request failed: ${explain(err)}`);
  }
}

console.log(`Speech server ${deep ? "full check" : "health"}, ${new Date().toLocaleString()}`);
const up = [];
for (const server of servers) {
  console.log(`${server.name}  ${server.url}`);
  up.push(await health(server));
}
if (deep) {
  console.log("Round trip");
  if (up.every(Boolean)) await roundTrip(servers[0], servers[1]);
  else say(false, "skipped: both servers have to be healthy first");
}
console.log(healthy ? "All healthy." : "Something is wrong: see the ✗ lines above.");
process.exit(healthy ? 0 : 1);
