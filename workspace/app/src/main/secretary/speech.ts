// The secretary's voice: one HTTP call to a speech server. Two kinds, told apart by
// the address alone, so Settings stays one address and one key:
//
// - A server with the OpenAI speech API shape (`POST /v1/audio/speech`, bearer key),
//   such as the one in deploy/tts-server/. Any server built from there works, not
//   only ours; another engine of the same shape doesn't, since the request names the
//   Serena voice and carries Qwen-style tone instructions (G-004).
// - Cloudflare Workers AI's MeloTTS, addressed by the model's own REST URL
//   (CLOUDFLARE_EXAMPLE) with a Workers AI API token as the key. It is told the
//   language, has one voice per language and takes no tone instructions. Its free
//   daily allocation covers far more briefs than a day brings
//   (docs/timeline/2026-11-05_cloudflare-tts-research.md).
//
// Nothing here imports electron: the caller passes the server it read from userData
// (settings-store's `loadSpeechServer`), so this runs in tests and from a plain node
// script. Nothing here throws and nothing here logs. A failure is a reason string,
// and that string can reach the renderer, so the key is scrubbed out of it.
//
// An empty address means no server: the functions return at once and make no
// request (Story 7: with no server, the secretary is text only).

import type { BriefLanguage, SpeechTestResult } from "../../shared/types";

export interface SpeechServer {
  // Base address, e.g. https://tts.example.com. "" means none.
  url: string;
  // Bearer key; "" when none is saved, in which case no Authorization is sent.
  key: string;
}

export type SynthesizeResult =
  | { ok: true; wav: Buffer }
  | { ok: false; reason: string };

export interface SpeechOptions {
  fetch?: typeof fetch;
  // Replaces both timeouts below. Tests use it so a timeout takes milliseconds.
  timeoutMs?: number;
  // Cancels the request early: the orchestrator aborts a brief's speech when a
  // newer event replaces it or Secretary Mode goes off. Resolves "aborted".
  signal?: AbortSignal;
}

// Story 7: "in time" is 30 seconds for the audio of one brief. Synthesis runs at
// about 0.4 s per second of audio (docs/timeline/2026-10-08_brief-writer-spike.md),
// so this covers a brief of a minute and more; the first figure, 15 s, failed most
// real briefs.
export const SPEECH_TIMEOUT_MS = 30_000;
// /health only shows the server is there. Ours answers in well under a second; a
// stopped instance behind its Elastic IP never answers at all, so don't wait long.
export const HEALTH_TIMEOUT_MS = 5_000;

export const VOICE = "serena";

// The casual-briefing tone, the strings the voice was picked with in
// deploy/tts-server/voice-samples.sh.
export const BRIEFING_INSTRUCTIONS: Record<BriefLanguage, string> = {
  Chinese: "用自然、轻松的口语语气，像同事当面跟你汇报工作。",
  English:
    "Speak in a natural, relaxed conversational tone, like a colleague briefing you in person.",
};

const TEST_SENTENCE = "Hi, this is your secretary. The speech server is working.";

// Cloudflare's API host; an address on it is a Workers AI model, never an
// OpenAI-shaped server.
const CLOUDFLARE_HOST = "api.cloudflare.com";
export const CLOUDFLARE_MODEL = "@cf/myshell-ai/melotts";
export const CLOUDFLARE_EXAMPLE = `https://api.cloudflare.com/client/v4/accounts/<account id>/ai/run/${CLOUDFLARE_MODEL}`;
// MeloTTS's Chinese voice also reads the English terms in a Chinese brief.
export const CLOUDFLARE_LANG: Record<BriefLanguage, string> = { Chinese: "zh", English: "en" };

type Engine =
  | { kind: "openai"; speech: URL; health: URL }
  | { kind: "cloudflare"; speech: URL };

// Trims, and drops trailing slashes and a trailing /v1: OpenAI-style clients take a
// base URL ending in /v1, so that is what people paste, and the paths below add it.
// Only scheme, host and path are kept: a query or fragment pasted along with the
// address would otherwise swallow the routes added to it. An address that doesn't
// parse is kept as typed, so Test can say what is wrong with it.
export function normalizeServerUrl(raw: string): string {
  const trimmed = raw.trim();
  const tidy = (path: string) => path.replace(/\/+$/, "").replace(/\/v1$/i, "");
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return tidy(trimmed);
  }
  return `${url.protocol}//${url.host}${tidy(url.pathname)}`;
}

// The origin a saved key belongs to, or null for no usable address. A key is only
// ever sent to the server it was saved for: see settings-store's setSpeechServer.
export function serverOrigin(raw: string): string | null {
  try {
    const { origin } = new URL(normalizeServerUrl(raw));
    return origin === "null" ? null : origin;
  } catch {
    return null;
  }
}

// Plain http would carry the key and the brief unencrypted, so it is only allowed
// to this computer, for a server run locally.
function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "[::1]" || /^127(\.\d+){3}$/.test(hostname);
}

// The kind of server an address is and the URLs to call, or why there are none.
function engineOf(base: string): Engine | string {
  let url: URL;
  try {
    url = new URL(normalizeServerUrl(base));
  } catch {
    return "not a web address";
  }
  if (url.protocol === "http:" && !isLoopback(url.hostname)) {
    return "needs an https address: plain http would send the key unencrypted";
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return "not an http(s) address";

  if (url.hostname === CLOUDFLARE_HOST) {
    let path = url.pathname;
    try {
      path = decodeURIComponent(path);
    } catch {
      // A stray % stays as typed, and the match below says what is wrong.
    }
    const model = /^\/client\/v4\/accounts\/[^/]+\/ai\/run\/(.+)$/.exec(path)?.[1];
    if (!model) return `needs the model's full address: ${CLOUDFLARE_EXAMPLE}`;
    if (model !== CLOUDFLARE_MODEL) return `only ${CLOUDFLARE_MODEL} is supported on Cloudflare`;
    // Called as matched, so a pasted %40 and a typed @ reach the same URL.
    url.pathname = path;
    return { kind: "cloudflare", speech: url };
  }

  const at = (route: string) => {
    const routed = new URL(url);
    routed.pathname = routed.pathname.replace(/\/+$/, "") + route;
    return routed;
  };
  return { kind: "openai", speech: at("/v1/audio/speech"), health: at("/health") };
}

// `language` picks the tone instruction only on an OpenAI-shaped server. That server
// is not told the language: it detects it itself (`Auto`), which the builder chose on
// 2026-10-08 for Chinese briefs full of English terms, and kept after an A/B listen of
// 11 real briefs. MeloTTS has no detection, so Cloudflare is told it.
export async function synthesize(
  server: SpeechServer,
  text: string,
  language: BriefLanguage,
  options: SpeechOptions = {}
): Promise<SynthesizeResult> {
  if (!server.url.trim()) return { ok: false, reason: "no speech server set" };
  const engine = engineOf(server.url);
  if (typeof engine === "string") return { ok: false, reason: engine };
  if (!text.trim()) return { ok: false, reason: "nothing to say" };

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (server.key) headers.Authorization = `Bearer ${server.key}`;
  const payload =
    engine.kind === "cloudflare"
      ? { prompt: text, lang: CLOUDFLARE_LANG[language] }
      : {
          input: text,
          voice: VOICE,
          instructions: BRIEFING_INSTRUCTIONS[language],
          response_format: "wav",
        };
  const got = await request(
    engine.speech,
    { method: "POST", headers, body: JSON.stringify(payload) },
    options.timeoutMs ?? SPEECH_TIMEOUT_MS,
    options.fetch ?? fetch,
    options.signal
  );
  if (!got.ok) return { ok: false, reason: scrub(got.reason, server.key) };

  const { status, contentType, body } = got;
  if (status >= 300 && status < 400) {
    return { ok: false, reason: redirectReason(status, got.location) };
  }
  if (status === 401 || status === 403) {
    // Cloudflare answers a wrong account ID in the address with the same 401
    // "Authentication error" as a wrong token (measured 2026-11-05).
    const rejected =
      engine.kind === "cloudflare"
        ? `key rejected, or the account ID in the address is wrong (HTTP ${status})`
        : `key rejected (HTTP ${status})`;
    return {
      ok: false,
      reason: server.key ? rejected : `the server wants a key and none is set (HTTP ${status})`,
    };
  }
  if (status < 200 || status >= 300) {
    return { ok: false, reason: `HTTP ${status}${errorDetail(body, server.key)}` };
  }
  const audio = engine.kind === "cloudflare" ? cloudflareAudio(body) : body;
  if (!audio || !isWav(audio)) {
    const what =
      audio && audio !== body
        ? `the audio isn't WAV (${audio.length} bytes)`
        : `not audio (${contentType || "no content type"}, ${body.length} bytes)`;
    return { ok: false, reason: scrub(what, server.key) };
  }
  return { ok: true, wav: audio };
}

// Workers AI wraps a model's answer: `{"result": {"audio": "<base64>"}, "success": true}`.
// MeloTTS's audio is WAV (44.1 kHz, mono, 16-bit), though its schema says MP3
// (measured 2026-11-05); the caller checks the header either way. A body that is
// already audio is taken as it is.
function cloudflareAudio(body: Buffer): Buffer | null {
  if (isWav(body)) return body;
  try {
    const audio = JSON.parse(body.toString("utf8"))?.result?.audio;
    return typeof audio === "string" ? Buffer.from(audio, "base64") : null;
  } catch {
    return null;
  }
}

// The Test button: is anything there (/health), then does a one-sentence synthesis
// come back as audio with this key. Stops at the first step that fails. Cloudflare
// has no /health of its own (any path there wants the token), so its test is the
// synthesis alone.
export async function testServer(
  server: SpeechServer,
  options: SpeechOptions = {}
): Promise<SpeechTestResult> {
  const started = Date.now();
  if (!server.url.trim()) {
    return { ok: false, step: "address", reason: "no speech server set, briefs are text only" };
  }
  const engine = engineOf(server.url);
  if (typeof engine === "string") return { ok: false, step: "address", reason: engine };

  if (engine.kind === "openai") {
    // No key on /health: it's public on ours, and the key goes nowhere it isn't needed.
    const got = await request(
      engine.health,
      { method: "GET" },
      options.timeoutMs ?? HEALTH_TIMEOUT_MS,
      options.fetch ?? fetch
    );
    if (!got.ok) return { ok: false, step: "health", reason: scrub(got.reason, server.key) };
    // Below 500, something answered; a server without a /health route (404) may still
    // speak, and synthesis is the real test. 5xx is the proxy up with the model not
    // (Caddy's 502), or vLLM still loading.
    if (got.status >= 500) {
      return { ok: false, step: "health", reason: `server not ready (HTTP ${got.status})` };
    }
  }

  const spoken = await synthesize(server, TEST_SENTENCE, "English", options);
  if (!spoken.ok) return { ok: false, step: "speech", reason: spoken.reason };
  return { ok: true, ms: Date.now() - started };
}

type Got =
  | { ok: true; status: number; contentType: string; location: string; body: Buffer }
  | { ok: false; reason: string };

// The timeout covers the whole exchange, body included: the signal aborts a body
// read still in progress too. So does the caller's `cancel`, if given.
async function request(
  url: URL,
  init: RequestInit,
  timeoutMs: number,
  fetchImpl: typeof fetch,
  cancel?: AbortSignal
): Promise<Got> {
  if (cancel?.aborted) return { ok: false, reason: "aborted" };
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = cancel ? AbortSignal.any([cancel, timeout]) : timeout;
  try {
    // Redirects are not followed: the address was checked (https, or this
    // computer), and a redirect could send the brief somewhere that wasn't, such
    // as plain http. Node drops the key on a cross-origin hop, but not the brief.
    const res = await fetchImpl(url, { ...init, signal, redirect: "manual" });
    const body = Buffer.from(await res.arrayBuffer());
    return {
      ok: true,
      status: res.status,
      contentType: res.headers.get("content-type") ?? "",
      location: res.headers.get("location") ?? "",
      body,
    };
  } catch (err) {
    if (cancel?.aborted) return { ok: false, reason: "aborted" };
    return { ok: false, reason: failureReason(err, timeoutMs) };
  }
}

function failureReason(err: unknown, timeoutMs: number): string {
  const e = err as { name?: string; message?: string; cause?: { code?: string; message?: string } };
  if (e?.name === "TimeoutError" || e?.name === "AbortError") {
    return `timed out after ${Math.round(timeoutMs / 100) / 10} s`;
  }
  // Node's fetch says only "fetch failed"; the cause has the useful part.
  const detail = e?.cause?.code ?? e?.cause?.message ?? e?.message ?? String(err);
  return `unreachable (${detail})`;
}

// Says where it pointed, by origin only, so the builder can set that address.
function redirectReason(status: number, location: string): string {
  let where = "";
  try {
    where = ` to ${new URL(location).origin}`;
  } catch {
    // A relative or missing Location: just say it redirected.
  }
  return `the server redirected (HTTP ${status})${where}; set the address it redirects to`;
}

// The server's own words for an error, shortened: vLLM answers
// `{"error": {"message": …}}`, FastAPI-style servers `{"detail": …}`, Cloudflare
// `{"errors": [{"code": …, "message": …}]}`. The key is
// scrubbed out before shortening: cut first, and a key straddling the cut would
// leave its first half behind where the scrub can no longer recognise it.
function errorDetail(body: Buffer, key: string): string {
  const text = body.toString("utf8").trim();
  if (!text) return "";
  let detail = text;
  try {
    const data = JSON.parse(text);
    const found =
      data?.error?.message ?? data?.detail ?? data?.message ?? data?.errors?.[0]?.message ?? data?.error;
    if (typeof found === "string") detail = found;
  } catch {
    // Not JSON: the text as it is.
  }
  detail = scrub(detail, key).replace(/\s+/g, " ");
  return `: ${detail.length > 160 ? `${detail.slice(0, 160)}…` : detail}`;
}

// We ask for WAV, and the player is handed WAV: check the RIFF/WAVE header rather
// than trust a content type.
function isWav(body: Buffer): boolean {
  return (
    body.length > 12 &&
    body.toString("latin1", 0, 4) === "RIFF" &&
    body.toString("latin1", 8, 12) === "WAVE"
  );
}

// A server could echo the Authorization header into an error body, and Node's
// fetch quotes a malformed header value in its message.
function scrub(reason: string, key: string): string {
  return key ? reason.split(key).join("[key]") : reason;
}
