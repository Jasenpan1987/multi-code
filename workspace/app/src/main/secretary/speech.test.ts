// The speech client against a faked fetch, plus two cases against a real local
// socket so the timeout and connection-refused paths are Node's own errors rather
// than ones a fake chose to throw.

import http from "http";
import type { AddressInfo } from "net";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BRIEFING_INSTRUCTIONS,
  SPEECH_TIMEOUT_MS,
  normalizeServerUrl,
  synthesize,
  testServer,
} from "./speech";

const KEY = "sk-test-0123456789abcdef";
const server = { url: "https://tts.example.com", key: KEY };

// A minimal valid WAV: RIFF header, fmt chunk, empty data chunk.
function wav(): Buffer {
  const b = Buffer.alloc(44);
  b.write("RIFF", 0, "latin1");
  b.writeUInt32LE(36, 4);
  b.write("WAVE", 8, "latin1");
  b.write("fmt ", 12, "latin1");
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(24000, 24);
  b.writeUInt32LE(48000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36, "latin1");
  b.writeUInt32LE(0, 40);
  return b;
}

type Route = (init: RequestInit) => Response | Promise<Response>;

// Answers by path; records every call. A path with no route is a 404.
function fakeFetch(routes: Record<string, Route>) {
  return vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const route = routes[url.pathname];
    return route ? route(init) : new Response("not found", { status: 404 });
  });
}

const authOf = (init: RequestInit | undefined) =>
  (init?.headers as Record<string, string> | undefined)?.Authorization;

const audio = () =>
  new Response(new Uint8Array(wav()), { status: 200, headers: { "content-type": "audio/wav" } });
const healthy = () => new Response("{}", { status: 200 });

// Never answers; rejects with the signal's reason when it aborts, as fetch does.
const hang: Route = (init) =>
  new Promise((_resolve, reject) => {
    init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
  });

describe("synthesize", () => {
  it("posts the brief with Serena, the language, its tone and the key, and returns the wav", async () => {
    const f = fakeFetch({ "/v1/audio/speech": audio });
    const res = await synthesize(server, "MSK 那边做完了。", "Chinese", { fetch: f });

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.wav.equals(wav())).toBe(true);
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0];
    expect(String(url)).toBe("https://tts.example.com/v1/audio/speech");
    expect(init?.method).toBe("POST");
    expect(authOf(init)).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(String(init?.body))).toEqual({
      input: "MSK 那边做完了。",
      voice: "serena",
      language: "Chinese",
      instructions: BRIEFING_INSTRUCTIONS.Chinese,
      response_format: "wav",
    });
  });

  it("uses the English tone for an English brief", async () => {
    const f = fakeFetch({ "/v1/audio/speech": audio });
    await synthesize(server, "MSK just finished.", "English", { fetch: f });
    const body = JSON.parse(String(f.mock.calls[0][1]?.body));
    expect(body.language).toBe("English");
    expect(body.instructions).toBe(BRIEFING_INSTRUCTIONS.English);
    expect(body.instructions).toMatch(/colleague briefing you/);
  });

  it("makes no request at all when no server is set", async () => {
    const f = fakeFetch({ "/v1/audio/speech": audio });
    const res = await synthesize({ url: "", key: KEY }, "hello", "English", { fetch: f });
    expect(res).toEqual({ ok: false, reason: "no speech server set" });
    expect(f).not.toHaveBeenCalled();
    // Whitespace is no address either.
    await synthesize({ url: "   ", key: "" }, "hello", "English", { fetch: f });
    expect(f).not.toHaveBeenCalled();
  });

  it("refuses a non-http address without a request", async () => {
    const f = fakeFetch({});
    for (const url of ["ftp://tts.example.com", "tts dot example", "file:///etc/passwd"]) {
      const res = await synthesize({ url, key: KEY }, "hello", "English", { fetch: f });
      expect(res).toEqual({ ok: false, reason: "not an http(s) address" });
    }
    expect(f).not.toHaveBeenCalled();
  });

  it("reports a rejected key on 401 and 403", async () => {
    for (const status of [401, 403]) {
      const f = fakeFetch({
        "/v1/audio/speech": () => new Response('{"error":"Unauthorized"}', { status }),
      });
      const res = await synthesize(server, "hello", "English", { fetch: f });
      expect(res).toEqual({ ok: false, reason: `key rejected (HTTP ${status})` });
    }
  });

  it("sends no Authorization without a key, and says so on a 401", async () => {
    const f = fakeFetch({ "/v1/audio/speech": () => new Response("", { status: 401 }) });
    const res = await synthesize({ url: server.url, key: "" }, "hello", "English", { fetch: f });
    expect(authOf(f.mock.calls[0][1])).toBeUndefined();
    expect(res).toEqual({
      ok: false,
      reason: "the server wants a key and none is set (HTTP 401)",
    });
  });

  it("times out", async () => {
    const f = fakeFetch({ "/v1/audio/speech": hang });
    const res = await synthesize(server, "hello", "English", { fetch: f, timeoutMs: 20 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/^timed out after/);
  });

  it("stops when the caller aborts, and says aborted rather than timed out", async () => {
    const f = fakeFetch({ "/v1/audio/speech": hang });
    const cancel = new AbortController();
    const pending = synthesize(server, "hello", "English", { fetch: f, signal: cancel.signal });
    cancel.abort();
    expect(await pending).toEqual({ ok: false, reason: "aborted" });

    // Already aborted: no request at all.
    const g = fakeFetch({ "/v1/audio/speech": audio });
    const res = await synthesize(server, "hello", "English", { fetch: g, signal: cancel.signal });
    expect(res).toEqual({ ok: false, reason: "aborted" });
    expect(g).not.toHaveBeenCalled();
  });

  it("waits 30 seconds by default (Story 7)", () => {
    expect(SPEECH_TIMEOUT_MS).toBe(30_000);
  });

  it("rejects a 200 whose body isn't audio", async () => {
    const f = fakeFetch({
      "/v1/audio/speech": () =>
        new Response("<html>captive portal</html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    });
    const res = await synthesize(server, "hello", "English", { fetch: f });
    expect(res).toEqual({ ok: false, reason: "not audio (text/html, 27 bytes)" });
  });

  it("doesn't take a content type's word for it", async () => {
    const f = fakeFetch({
      "/v1/audio/speech": () =>
        new Response("nope", { status: 200, headers: { "content-type": "audio/wav" } }),
    });
    const res = await synthesize(server, "hello", "English", { fetch: f });
    expect(res.ok).toBe(false);
  });

  it("quotes the server's error message on other failures", async () => {
    const f = fakeFetch({
      "/v1/audio/speech": () =>
        new Response(JSON.stringify({ error: { message: "Unknown voice: serena" } }), {
          status: 400,
        }),
    });
    const res = await synthesize(server, "hello", "English", { fetch: f });
    expect(res).toEqual({ ok: false, reason: "HTTP 400: Unknown voice: serena" });
  });

  it("reports an unreachable server by its cause", async () => {
    const f = vi.fn(async () => {
      throw new TypeError("fetch failed", { cause: { code: "ENOTFOUND" } });
    });
    const res = await synthesize(server, "hello", "English", { fetch: f });
    expect(res).toEqual({ ok: false, reason: "unreachable (ENOTFOUND)" });
  });

  it("never returns the key, even when the server echoes it", async () => {
    const f = fakeFetch({
      "/v1/audio/speech": (init) =>
        new Response(
          `bad request, you sent ${(init.headers as Record<string, string>).Authorization}`,
          { status: 400 }
        ),
    });
    const res = await synthesize(server, "hello", "English", { fetch: f });
    expect(res.ok).toBe(false);
    expect(JSON.stringify(res)).not.toContain(KEY);
    expect(JSON.stringify(res)).toContain("[key]");
  });

  it("tolerates a pasted /v1 base URL and trailing slashes", async () => {
    const f = fakeFetch({ "/v1/audio/speech": audio });
    const res = await synthesize({ url: " https://tts.example.com/v1/ ", key: KEY }, "hi", "English", {
      fetch: f,
    });
    expect(res.ok).toBe(true);
    expect(String(f.mock.calls[0][0])).toBe("https://tts.example.com/v1/audio/speech");
  });
});

describe("testServer", () => {
  it("passes when /health answers and a sentence comes back as audio", async () => {
    const f = fakeFetch({ "/health": healthy, "/v1/audio/speech": audio });
    const res = await testServer(server, { fetch: f });
    expect(res.ok).toBe(true);
    expect(f.mock.calls.map(([u]) => new URL(String(u)).pathname)).toEqual([
      "/health",
      "/v1/audio/speech",
    ]);
    // The key goes only where it's needed.
    expect(authOf(f.mock.calls[0][1])).toBeUndefined();
  });

  it("says text only, with no request, when no server is set", async () => {
    const f = fakeFetch({});
    const res = await testServer({ url: "", key: KEY }, { fetch: f });
    expect(res).toEqual({
      ok: false,
      step: "address",
      reason: "no speech server set, briefs are text only",
    });
    expect(f).not.toHaveBeenCalled();
  });

  it("fails at health when the server is unreachable, and goes no further", async () => {
    const f = vi.fn(async () => {
      throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
    });
    const res = await testServer(server, { fetch: f });
    expect(res).toEqual({ ok: false, step: "health", reason: "unreachable (ECONNREFUSED)" });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("fails at health on a timeout", async () => {
    const f = fakeFetch({ "/health": hang });
    const res = await testServer(server, { fetch: f, timeoutMs: 20 });
    expect(res).toMatchObject({ ok: false, step: "health" });
    if (!res.ok) expect(res.reason).toMatch(/^timed out/);
  });

  it("fails at health when the proxy is up and the model isn't", async () => {
    const f = fakeFetch({ "/health": () => new Response("Bad Gateway", { status: 502 }) });
    const res = await testServer(server, { fetch: f });
    expect(res).toEqual({ ok: false, step: "health", reason: "server not ready (HTTP 502)" });
  });

  it("goes on to synthesis when a server has no /health route", async () => {
    const f = fakeFetch({ "/v1/audio/speech": audio });
    const res = await testServer(server, { fetch: f });
    expect(res.ok).toBe(true);
  });

  it("fails at speech with a rejected key", async () => {
    const f = fakeFetch({
      "/health": healthy,
      "/v1/audio/speech": () => new Response("", { status: 401 }),
    });
    const res = await testServer(server, { fetch: f });
    expect(res).toEqual({ ok: false, step: "speech", reason: "key rejected (HTTP 401)" });
  });

  it("fails at speech on a timeout", async () => {
    const f = fakeFetch({ "/health": healthy, "/v1/audio/speech": hang });
    const res = await testServer(server, { fetch: f, timeoutMs: 20 });
    expect(res).toMatchObject({ ok: false, step: "speech" });
    if (!res.ok) expect(res.reason).toMatch(/^timed out/);
  });

  it("fails at speech when the answer isn't audio", async () => {
    const f = fakeFetch({
      "/health": healthy,
      "/v1/audio/speech": () => new Response("{}", { status: 200 }),
    });
    const res = await testServer(server, { fetch: f });
    expect(res).toMatchObject({ ok: false, step: "speech" });
    if (!res.ok) expect(res.reason).toMatch(/^not audio/);
  });
});

describe("against a real socket", () => {
  let listening: http.Server | null = null;
  afterEach(async () => {
    const s = listening;
    listening = null;
    if (s) await new Promise((r) => s.close(r));
  });

  it("times out on a server that accepts and never answers", async () => {
    listening = http.createServer(() => {
      // Hold the request open.
    });
    await new Promise<void>((r) => listening!.listen(0, "127.0.0.1", r));
    const { port } = listening.address() as AddressInfo;
    const started = Date.now();
    const res = await synthesize({ url: `http://127.0.0.1:${port}`, key: KEY }, "hi", "English", {
      timeoutMs: 100,
    });
    expect(res).toEqual({ ok: false, reason: "timed out after 0.1 s" });
    expect(Date.now() - started).toBeLessThan(2000);
    listening.closeAllConnections();
  });

  it("reports a closed port as unreachable", async () => {
    const probe = http.createServer();
    await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
    const { port } = probe.address() as AddressInfo;
    await new Promise((r) => probe.close(r));
    const res = await testServer({ url: `http://127.0.0.1:${port}`, key: KEY });
    expect(res).toEqual({ ok: false, step: "health", reason: "unreachable (ECONNREFUSED)" });
  });
});

describe("normalizeServerUrl", () => {
  it.each([
    ["https://tts.example.com", "https://tts.example.com"],
    ["  https://tts.example.com/  ", "https://tts.example.com"],
    ["https://tts.example.com/v1", "https://tts.example.com"],
    ["https://tts.example.com/v1/", "https://tts.example.com"],
    ["https://example.com/tts/", "https://example.com/tts"],
    ["", ""],
  ])("%j -> %j", (raw, want) => {
    expect(normalizeServerUrl(raw)).toBe(want);
  });
});
