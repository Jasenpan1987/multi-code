// Multi-Code's one connection to the user's shared OpenCode 2 service: its event
// stream, the snapshot reads that re-sync after a reconnect, and the dialog replies.
//
// The facts it rests on are in docs/timeline/2026-10-20_opencode-v2-source-reading.md
// ("Shared service", "Event stream", "Answering dialogs through the API"), read from
// OpenCode v2.0.32: the registration file and auth follow
// packages/client/src/service-probe.ts, the stream and its stall rule
// packages/server/src/handlers/event.ts and packages/client/src/solid/connection.ts.
//
// The service belongs to the user. This module only reads from it and answers its
// dialogs; it never starts, stops or replaces it, and talks only to the loopback
// address its registration names. The service's password never leaves this module:
// it goes into the Authorization header and nowhere else, and every log line and
// status reason is scrubbed of it in case a lower layer quoted it.

import fs from "fs";
import os from "os";
import path from "path";
import type { AnswerResult } from "./types";
import { debugTrace } from "../debug-trace";

// One frame of `GET /api/event`, as the service sent it. `data` is the event's payload
// (`sessionID` and the rest); `location` is absent on most session events.
export interface ServiceEvent {
  type: string;
  data: Record<string, unknown>;
  location?: { directory: string };
}

export type ServiceStatus =
  | { state: "connecting" }
  | { state: "connected" }
  // No registration, the service refused us, or the stream keeps dropping. `reason`
  // is one line for a log or the alerts-off bar, never carrying the password.
  | { state: "unreachable"; reason: string };

// What a subscriber hears. `onResync` follows every (re)connect, including a new
// service replacing the old one: events missed meanwhile are gone, so re-read state
// from the snapshot.
export interface ServiceListener {
  onEvent(event: ServiceEvent): void;
  onResync(): void;
  onStatus(status: ServiceStatus): void;
}

// `GET /api/session/:id`, the fields Multi-Code reads.
export interface ServiceSession {
  id: string;
  parentID?: string;
  directory?: string;
  outcome?: "succeeded" | "failed" | "interrupted";
}

// A pending permission request (`permission.asked` data, `GET …/permission` items).
export interface PermissionRequest {
  id: string;
  sessionID: string;
  action: string;
  resources: string[];
  save?: string[];
  metadata?: Record<string, unknown>;
  message?: string;
}

// A pending form (`form.created` data's `form`, `GET …/form` items). The question
// tool's forms have `metadata.kind === "question"` and fields `q0…`.
export interface FormField {
  key: string;
  type: string;
  title?: string;
  description?: string;
  options?: { value: string; label: string; description?: string }[];
  custom?: boolean;
}

export interface FormInfo {
  id: string;
  sessionID: string;
  title?: string;
  metadata?: Record<string, unknown>;
  fields: FormField[];
}

export interface OpencodeService {
  // The connection opens with the first subscriber and closes after the last one
  // leaves. Returns the unsubscribe.
  subscribe(listener: ServiceListener): () => void;
  status(): ServiceStatus;
  // Sessions with a turn running (`GET /api/session/active`). Null when unreachable.
  activeSessions(): Promise<Set<string> | null>;
  // Null when unknown to the service or unreachable.
  session(sessionId: string): Promise<ServiceSession | null>;
  pendingPermissions(sessionId: string): Promise<PermissionRequest[] | null>;
  pendingForms(sessionId: string): Promise<FormInfo[] | null>;
  replyPermission(
    sessionId: string,
    requestId: string,
    decision: "once" | "always" | "reject",
    message?: string
  ): Promise<AnswerResult>;
  replyForm(
    sessionId: string,
    formId: string,
    answer: Record<string, string | string[]>
  ): Promise<AnswerResult>;
  cancelForm(sessionId: string, formId: string, message?: string): Promise<AnswerResult>;
}

export interface ServiceTiming {
  // A snapshot read or a reply, body included.
  requestMs: number;
  // From opening the stream to its `server.connected`, which the service sends first
  // and at once.
  connectMs: number;
  // No bytes for this long on a connected stream and it is taken to be dead. The
  // service writes a heartbeat comment every 15 s; 45 s is the official client's
  // own idle timeout (connection.ts `defaultIdleTimeout`).
  stallMs: number;
  // Reconnect delay, doubling per failed attempt up to the max.
  backoffMinMs: number;
  backoffMaxMs: number;
  // A stream that stayed up this long starts the backoff over when it drops; one
  // that drops sooner keeps doubling, so a service that accepts and then cuts every
  // stream isn't hammered.
  stableMs: number;
  // How often the registration is re-read while subscribed, to notice a replaced
  // service (and one that just started) without waiting out a backoff.
  registrationPollMs: number;
  // `unreachable` is reported once the stream has been down this long without a
  // break: from the first subscribe, or from the moment a connected stream was lost.
  // PRD Story 9's bar threshold, so the attention can show the bar as soon as it
  // hears `unreachable`. Shorter outages stay `connecting`: a TUI starting the
  // service, or a version replacement, takes a few seconds and isn't worth a bar.
  unreachableAfterMs: number;
}

export const DEFAULT_TIMING: ServiceTiming = {
  requestMs: 5_000,
  connectMs: 5_000,
  stallMs: 45_000,
  backoffMinMs: 500,
  backoffMaxMs: 10_000,
  stableMs: 10_000,
  registrationPollMs: 5_000,
  unreachableAfterMs: 15_000,
};

export interface ServiceOptions {
  // Where XDG_STATE_HOME is read, at every lookup. process.env by default.
  env?: Record<string, string | undefined>;
  // The home directory the default state path falls back to. os.homedir() by default.
  home?: string;
  fetch?: typeof fetch;
  timing?: Partial<ServiceTiming>;
}

// The registration file of the default channel, which the official installer's
// builds use (`service-config.ts` `filename`). `||`, not `??`: OpenCode's CLI, which
// writes the file, takes an empty XDG_STATE_HOME as unset (util/global-roots.ts).
export function registrationPath(
  env: Record<string, string | undefined> = process.env,
  home: string = os.homedir()
): string {
  const state = env.XDG_STATE_HOME || path.join(home, ".local", "state");
  return path.join(state, "opencode", "service.json");
}

// Its fields, as OpenCode's `Service.Info` schema has them. `id` is a fresh UUID per
// service process.
interface Registration {
  id?: string;
  version?: string;
  url: string;
  pid: number;
  password?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function parseRegistration(text: string): Registration | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(raw)) return null;
  const { id, version, url, pid, password } = raw;
  if (typeof url !== "string" || typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
    return null;
  }
  if (!optionalString(id) || !optionalString(version) || !optionalString(password)) return null;
  return { id, version, url, pid, password };
}

// What tells one service process from the next: the fields OpenCode's own `same()`
// compares (service-probe.ts). Never logged: the url could carry anything.
function identityOf(reg: Registration): string {
  return JSON.stringify([reg.id ?? null, reg.version ?? null, reg.url, reg.pid]);
}

// The service listens on 127.0.0.1 by default. Anything else in the registration,
// another host, https, or credentials in the URL, is not something we send the
// password to.
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

function loopbackOrigin(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" || !LOOPBACK_HOSTS.has(parsed.hostname)) return null;
  if (parsed.username || parsed.password) return null;
  return parsed.origin;
}

interface Endpoint {
  origin: string;
  // Absent when the registration has no password, as OpenCode's client does.
  authorization?: string;
  identity: string;
  reg: Registration;
}

// Why the registration gave us nothing to talk to. `identity` is set when there was
// a registration (refused for its address), so the poll doesn't retry it until it
// changes; null when there was none to read.
interface Refused {
  reason: string;
  identity: string | null;
}

// Every password this process has read, and the header value it becomes. Scrubbed
// from anything we say: Node's fetch quotes header values in some of its errors.
const secrets = new Set<string>();

function remember(password: string, authorization: string) {
  if (!password) return;
  secrets.add(password);
  secrets.add(authorization.slice("Basic ".length));
}

function scrub(text: string): string {
  let out = text;
  for (const secret of secrets) out = out.split(secret).join("[redacted]");
  return out;
}

function log(msg: string) {
  debugTrace(`[opencode-service] ${scrub(msg)}`);
}

// A stream ended for a reason we can name; its message is the status reason.
class Ended extends Error {}

// Why we cut a stream ourselves, as the abort's reason. `closed`: the last
// subscriber left. `replaced`: a new registration, reconnect at once. `stalled`:
// silence, treated as a failure.
class Cut {
  constructor(
    readonly kind: "closed" | "replaced" | "stalled",
    readonly reason: string
  ) {}
}

function httpReason(status: number): string {
  if (status === 401) return "the service refused the password in its registration (HTTP 401)";
  if (status === 503) return "the service is starting or stopping (HTTP 503)";
  return `the service answered HTTP ${status}`;
}

// Codes only, never a message: a message can quote a URL or a header.
function networkReason(err: unknown): string {
  if (err instanceof Ended) return err.message;
  const e = err as { name?: string; code?: unknown; cause?: { code?: unknown } } | null;
  if (e?.name === "TimeoutError") return "the service didn't answer in time";
  const code = e?.cause?.code ?? e?.code;
  return typeof code === "string" ? `connection failed (${code})` : "connection failed";
}

// The official client fails a stream whose pending frame passes 16 MB
// (promise/generated/client.ts `maxSseEventBytes`); so do we, rather than buffer
// without end.
const MAX_FRAME_CHARS = 16 * 1024 * 1024;

// Server-sent events, per the WHATWG parsing rules for the parts the service uses:
// lines end in LF, CRLF or CR, a blank line ends a frame, `:` starts a comment, and
// a frame's `data:` lines join with LF. Other fields (`event:`, `id:`, `retry:`)
// are ignored; the service sends none. Text may be split anywhere between pushes,
// a CRLF included.
export class SseParser {
  private line = "";
  private data: string[] = [];
  private dataChars = 0;
  // The previous push ended in CR: a LF opening this one belongs to it.
  private afterCr = false;

  constructor(
    private readonly onFrame: (data: string) => void,
    private readonly maxChars = MAX_FRAME_CHARS
  ) {}

  push(text: string) {
    if (text === "") return;
    let start = 0;
    if (this.afterCr && text.charCodeAt(0) === 10) start = 1;
    this.afterCr = false;
    for (let i = start; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c !== 10 && c !== 13) continue;
      this.line += text.slice(start, i);
      this.endLine();
      if (c === 13) {
        if (i + 1 === text.length) this.afterCr = true;
        else if (text.charCodeAt(i + 1) === 10) i++;
      }
      start = i + 1;
    }
    this.line += text.slice(start);
    if (this.line.length + this.dataChars > this.maxChars) {
      throw new Ended("the service sent an oversized event");
    }
  }

  private endLine() {
    const line = this.line;
    this.line = "";
    if (line === "") {
      if (this.data.length === 0) return;
      const data = this.data.join("\n");
      this.data = [];
      this.dataChars = 0;
      this.onFrame(data);
      return;
    }
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    if (field !== "data") return;
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    this.data.push(value);
    this.dataChars += value.length + 1;
  }
}

function toServiceEvent(raw: unknown): ServiceEvent | null {
  if (!isRecord(raw) || typeof raw.type !== "string") return null;
  const data = raw.data === undefined ? {} : raw.data;
  if (!isRecord(data)) return null;
  const event: ServiceEvent = { type: raw.type, data };
  const location = raw.location;
  if (isRecord(location) && typeof location.directory === "string") {
    event.location = { directory: location.directory };
  }
  return event;
}

// A permission request from `permission.asked` data or a `GET …/permission` item,
// with the fields the contract names. Null when the shape isn't the one measured.
export function toPermissionRequest(raw: unknown): PermissionRequest | null {
  if (!isRecord(raw)) return null;
  const { id, sessionID, action, resources, save, metadata, message } = raw;
  if (typeof id !== "string" || typeof sessionID !== "string" || typeof action !== "string") {
    return null;
  }
  if (!isStringArray(resources)) return null;
  if (save !== undefined && !isStringArray(save)) return null;
  if (metadata !== undefined && !isRecord(metadata)) return null;
  if (!optionalString(message)) return null;
  const request: PermissionRequest = { id, sessionID, action, resources };
  if (save !== undefined) request.save = save;
  if (metadata !== undefined) request.metadata = metadata;
  if (message !== undefined) request.message = message;
  return request;
}

function toFormField(raw: unknown): FormField | null {
  if (!isRecord(raw)) return null;
  const { key, type, title, description, options, custom } = raw;
  if (typeof key !== "string" || typeof type !== "string") return null;
  if (!optionalString(title) || !optionalString(description)) return null;
  if (custom !== undefined && typeof custom !== "boolean") return null;
  const field: FormField = { key, type };
  if (title !== undefined) field.title = title;
  if (description !== undefined) field.description = description;
  if (custom !== undefined) field.custom = custom;
  if (options !== undefined) {
    if (!Array.isArray(options)) return null;
    const out: NonNullable<FormField["options"]> = [];
    for (const o of options) {
      if (!isRecord(o) || typeof o.value !== "string" || typeof o.label !== "string") return null;
      if (!optionalString(o.description)) return null;
      out.push(
        o.description === undefined
          ? { value: o.value, label: o.label }
          : { value: o.value, label: o.label, description: o.description }
      );
    }
    field.options = out;
  }
  return field;
}

// A form from `form.created` data's `form` or a `GET …/form` item. Null when the
// shape isn't the one measured, or a field isn't.
export function toFormInfo(raw: unknown): FormInfo | null {
  if (!isRecord(raw)) return null;
  const { id, sessionID, title, metadata, fields } = raw;
  if (typeof id !== "string" || typeof sessionID !== "string" || !Array.isArray(fields)) {
    return null;
  }
  if (!optionalString(title)) return null;
  if (metadata !== undefined && !isRecord(metadata)) return null;
  const parsed: FormField[] = [];
  for (const f of fields) {
    const field = toFormField(f);
    if (!field) return null;
    parsed.push(field);
  }
  const form: FormInfo = { id, sessionID, fields: parsed };
  if (title !== undefined) form.title = title;
  if (metadata !== undefined) form.metadata = metadata;
  return form;
}

// One item that doesn't parse makes the whole list unknown rather than one dialog
// shorter: a re-sync that silently missed a dialog would be a wrong answer.
function listOf<T>(data: unknown, parse: (raw: unknown) => T | null): T[] | null {
  if (!Array.isArray(data)) return null;
  const out: T[] = [];
  for (const item of data) {
    const parsed = parse(item);
    if (!parsed) return null;
    out.push(parsed);
  }
  return out;
}

const OUTCOMES = new Set(["succeeded", "failed", "interrupted"]);

function toServiceSession(raw: unknown): ServiceSession | null {
  if (!isRecord(raw) || typeof raw.id !== "string") return null;
  const session: ServiceSession = { id: raw.id };
  if (typeof raw.parentID === "string" && raw.parentID) session.parentID = raw.parentID;
  if (isRecord(raw.location) && typeof raw.location.directory === "string") {
    session.directory = raw.location.directory;
  }
  if (typeof raw.outcome === "string" && OUTCOMES.has(raw.outcome)) {
    session.outcome = raw.outcome as ServiceSession["outcome"];
  }
  return session;
}

interface Stream {
  abort: AbortController;
  connected: boolean;
  connectedAt: number;
  watchdog: ReturnType<typeof setTimeout> | null;
}

type Got = { status: number; body: unknown };

class ServiceClient implements OpencodeService {
  private readonly listeners = new Set<ServiceListener>();
  private current: ServiceStatus = { state: "connecting" };
  // Bumped by every open and close, so a callback from an earlier run does nothing.
  private run = 0;
  // The stream being opened or read; null between attempts.
  private stream: Stream | null = null;
  // Identity of the registration the latest attempt read; null when it found none.
  private tried: string | null = null;
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  // Since when there has been no connected stream; null while there is one.
  private downSince: number | null = null;
  private unreachableTimer: ReturnType<typeof setTimeout> | null = null;
  private lastReason = "";

  private readonly timing: ServiceTiming;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: ServiceOptions) {
    this.timing = { ...DEFAULT_TIMING, ...options.timing };
    // Looked up at call time, so the global is whatever it is when a request goes.
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
  }

  subscribe(listener: ServiceListener): () => void {
    const first = this.listeners.size === 0;
    this.listeners.add(listener);
    if (first) this.open();
    // Every subscriber learns the status, and one joining a live stream gets its own
    // re-sync: it has no state yet, and the stream's `server.connected` is past. Not
    // called synchronously, so it never runs before subscribe has returned.
    queueMicrotask(() => {
      if (!this.listeners.has(listener)) return;
      const status = this.current;
      this.call(listener, (l) => l.onStatus(status));
      if (!first && status.state === "connected") this.call(listener, (l) => l.onResync());
    });
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.close();
    };
  }

  status(): ServiceStatus {
    return { ...this.current };
  }

  async activeSessions(): Promise<Set<string> | null> {
    const got = await this.request("GET", "/api/session/active");
    const data = this.dataOf(got);
    return isRecord(data) ? new Set(Object.keys(data)) : null;
  }

  async session(sessionId: string): Promise<ServiceSession | null> {
    const got = await this.request("GET", `/api/session/${encodeURIComponent(sessionId)}`);
    return toServiceSession(this.dataOf(got));
  }

  async pendingPermissions(sessionId: string): Promise<PermissionRequest[] | null> {
    const got = await this.request(
      "GET",
      `/api/session/${encodeURIComponent(sessionId)}/permission`
    );
    return listOf(this.dataOf(got), toPermissionRequest);
  }

  async pendingForms(sessionId: string): Promise<FormInfo[] | null> {
    const got = await this.request("GET", `/api/session/${encodeURIComponent(sessionId)}/form`);
    return listOf(this.dataOf(got), toFormInfo);
  }

  replyPermission(
    sessionId: string,
    requestId: string,
    decision: "once" | "always" | "reject",
    message?: string
  ): Promise<AnswerResult> {
    const route = `/api/session/${encodeURIComponent(sessionId)}/permission/${encodeURIComponent(requestId)}/reply`;
    return this.reply("POST", route, message === undefined ? { decision } : { decision, message });
  }

  replyForm(
    sessionId: string,
    formId: string,
    answer: Record<string, string | string[]>
  ): Promise<AnswerResult> {
    const route = `/api/session/${encodeURIComponent(sessionId)}/form/${encodeURIComponent(formId)}/reply`;
    return this.reply("POST", route, { answer });
  }

  cancelForm(sessionId: string, formId: string, message?: string): Promise<AnswerResult> {
    const route = `/api/session/${encodeURIComponent(sessionId)}/form/${encodeURIComponent(formId)}`;
    const query = message === undefined ? "" : `?message=${encodeURIComponent(message)}`;
    return this.reply("DELETE", route, undefined, query);
  }

  // ── Requests ──────────────────────────────────────────────────────────────

  // The registration, read fresh every time: it's a tiny file, and a reply must go to
  // whichever service is registered now, not the one a stream last reached.
  private async endpoint(): Promise<Endpoint | Refused> {
    const file = registrationPath(this.options.env ?? process.env, this.options.home);
    let text: string;
    try {
      text = await fs.promises.readFile(file, "utf8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const reason =
        code === "ENOENT"
          ? "no service registration (OpenCode's background service isn't running)"
          : `the service registration can't be read (${code ?? "error"})`;
      return { reason, identity: null };
    }
    // Never quote a parse error: V8's message includes the text, password and all.
    const reg = parseRegistration(text);
    if (!reg) return { reason: "the service registration can't be read", identity: null };
    const identity = identityOf(reg);
    const origin = loopbackOrigin(reg.url);
    if (!origin) {
      return { reason: "the service registration names an address that isn't loopback", identity };
    }
    if (reg.password === undefined) return { origin, identity, reg };
    const authorization =
      "Basic " + Buffer.from(`opencode:${reg.password}`, "utf8").toString("base64");
    remember(reg.password, authorization);
    return { origin, authorization, identity, reg };
  }

  private headers(endpoint: Endpoint, accept: string, json: boolean): Record<string, string> {
    const headers: Record<string, string> = { accept };
    if (endpoint.authorization) headers.authorization = endpoint.authorization;
    if (json) headers["content-type"] = "application/json";
    return headers;
  }

  // Null when nothing came back: no usable registration, a network error, a timeout.
  // `query` is kept out of the log line: a cancel's message is the builder's words.
  private async request(
    method: string,
    route: string,
    body?: unknown,
    query = ""
  ): Promise<Got | null> {
    const found = await this.endpoint();
    if (!("origin" in found)) return null;
    try {
      const res = await this.fetchImpl(found.origin + route + query, {
        method,
        headers: this.headers(found, "application/json", body !== undefined),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timing.requestMs),
        // Only the registered address is ever spoken to.
        redirect: "manual",
      });
      const text = await res.text();
      let parsed: unknown;
      if (text) {
        try {
          parsed = JSON.parse(text);
        } catch {
          // Not JSON: a read gets nothing from it, a reply only needs the status.
        }
      }
      if (!res.ok) log(`${method} ${route}: HTTP ${res.status}`);
      return { status: res.status, body: parsed };
    } catch (err) {
      log(`${method} ${route}: ${networkReason(err)}`);
      return null;
    }
  }

  private dataOf(got: Got | null): unknown {
    if (!got || got.status < 200 || got.status >= 300 || !isRecord(got.body)) return undefined;
    return got.body.data;
  }

  // 404 and 409 are a dialog already settled (answered elsewhere, or gone with its
  // turn), which the official client treats as done too.
  private async reply(
    method: string,
    route: string,
    body?: unknown,
    query = ""
  ): Promise<AnswerResult> {
    const got = await this.request(method, route, body, query);
    if (!got) return { ok: false, reason: "failed" };
    if (got.status >= 200 && got.status < 300) return { ok: true };
    if (got.status === 404 || got.status === 409) return { ok: false, reason: "gone" };
    return { ok: false, reason: "failed" };
  }

  // ── The event stream ──────────────────────────────────────────────────────

  private open() {
    this.run++;
    this.attempt = 0;
    this.tried = null;
    this.lastReason = "no answer from OpenCode's background service";
    this.downSince = Date.now();
    this.setStatus({ state: "connecting" });
    this.armUnreachable();
    const run = this.run;
    this.pollTimer = setInterval(() => void this.poll(run), this.timing.registrationPollMs);
    void this.connect(run);
  }

  private close() {
    this.run++;
    const stream = this.stream;
    this.stream = null;
    stream?.abort.abort(new Cut("closed", "no subscribers"));
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.unreachableTimer) clearTimeout(this.unreachableTimer);
    this.retryTimer = this.pollTimer = this.unreachableTimer = null;
    this.downSince = null;
    // Nobody is told: nobody is listening. The next subscriber starts from here.
    this.current = { state: "connecting" };
    log("closed: no subscribers");
  }

  private async connect(run: number) {
    const stream: Stream = {
      abort: new AbortController(),
      connected: false,
      connectedAt: 0,
      watchdog: null,
    };
    this.stream = stream;
    let why: string | Cut;
    try {
      why = await this.pump(run, stream);
    } catch (err) {
      why = networkReason(err);
    }
    // Our own cut is the real reason, whatever error it caused on the way out.
    const cut: unknown = stream.abort.signal.aborted ? stream.abort.signal.reason : undefined;
    if (cut instanceof Cut) why = cut;
    if (stream.watchdog) clearTimeout(stream.watchdog);
    stream.abort.abort();
    if (this.stream === stream) this.stream = null;
    if (run !== this.run) return;

    if (stream.connected) {
      // Lost a live stream: the outage clock starts now.
      if (Date.now() - stream.connectedAt >= this.timing.stableMs) this.attempt = 0;
      this.downSince = Date.now();
      this.setStatus({ state: "connecting" });
      this.armUnreachable();
    }
    if (why instanceof Cut && why.kind === "replaced") {
      log("reconnecting to the newly registered service");
      void this.connect(run);
      return;
    }
    this.retryLater(run, why instanceof Cut ? why.reason : why);
  }

  // Reads the stream until it ends. Returns the reason it ended; throws on a network
  // error or a protocol violation.
  private async pump(run: number, stream: Stream): Promise<string> {
    const found = await this.endpoint();
    if (run === this.run) this.tried = found.identity;
    if (stream.abort.signal.aborted) return "cut";
    if (!("origin" in found)) return found.reason;

    log(
      `connecting to ${found.origin} (service ${found.reg.id ?? "?"}, pid ${found.reg.pid}, ` +
        `version ${found.reg.version ?? "?"})`
    );
    this.arm(stream, this.timing.connectMs, "the service didn't open its event stream in time");
    const res = await this.fetchImpl(`${found.origin}/api/event`, {
      headers: this.headers(found, "text/event-stream", false),
      signal: stream.abort.signal,
      redirect: "manual",
    });
    if (!res.ok || !res.body) {
      await res.body?.cancel().catch(() => {});
      return res.ok ? "the event stream had no body" : httpReason(res.status);
    }
    if (!(res.headers.get("content-type") ?? "").includes("text/event-stream")) {
      await res.body.cancel().catch(() => {});
      return "the service's event stream isn't server-sent events";
    }

    const parser = new SseParser((data) => this.frame(stream, data));
    const decoder = new TextDecoder();
    const reader = res.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return "the event stream ended";
        // Any bytes, heartbeats included, prove the stream alive. Before
        // `server.connected` the connect deadline stands, so junk can't hold it open.
        if (stream.connected) this.arm(stream, this.timing.stallMs, "the event stream went silent");
        parser.push(decoder.decode(value, { stream: true }));
      }
    } finally {
      reader.releaseLock();
    }
  }

  private frame(stream: Stream, data: string) {
    if (this.stream !== stream) return;
    let raw: unknown;
    try {
      raw = JSON.parse(data);
    } catch {
      log(`dropped a frame that isn't JSON (${data.length} chars)`);
      return;
    }
    const event = toServiceEvent(raw);
    if (!event) {
      log(`dropped a frame that isn't an event (${data.length} chars)`);
      return;
    }
    if (!stream.connected) {
      // The service always opens with it; anything else is not the protocol we know.
      if (event.type !== "server.connected") {
        throw new Ended("the event stream did not start with server.connected");
      }
      stream.connected = true;
      stream.connectedAt = Date.now();
      this.downSince = null;
      if (this.unreachableTimer) clearTimeout(this.unreachableTimer);
      this.unreachableTimer = null;
      this.arm(stream, this.timing.stallMs, "the event stream went silent");
      log("connected");
      this.setStatus({ state: "connected" });
      this.tell((l) => l.onResync());
      return;
    }
    // A second one would mean a new feed behind the same socket; re-sync to be safe.
    if (event.type === "server.connected") {
      this.tell((l) => l.onResync());
      return;
    }
    this.tell((l) => l.onEvent(event));
  }

  private arm(stream: Stream, ms: number, reason: string) {
    if (stream.watchdog) clearTimeout(stream.watchdog);
    stream.watchdog = setTimeout(() => stream.abort.abort(new Cut("stalled", reason)), ms);
  }

  private retryLater(run: number, reason: string) {
    this.lastReason = scrub(reason);
    if (this.current.state === "unreachable") {
      this.setStatus({ state: "unreachable", reason: this.lastReason });
    }
    const delay = Math.min(
      this.timing.backoffMaxMs,
      this.timing.backoffMinMs * 2 ** Math.min(this.attempt, 30)
    );
    this.attempt++;
    log(`${reason}; retrying in ${delay} ms`);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (run === this.run) void this.connect(run);
    }, delay);
  }

  // A registration that isn't the one the latest attempt read means a new service
  // (OpenCode replaces the old one on a version change and on `service restart`), or
  // one that has just started. Either way, connect to it now rather than after a
  // stall or a backoff. A registration gone missing changes nothing: the old stream,
  // if any, ends by itself when its service exits.
  private async poll(run: number) {
    if (this.polling) return;
    this.polling = true;
    try {
      const found = await this.endpoint();
      if (run !== this.run || found.identity === null || found.identity === this.tried) return;
      this.tried = found.identity;
      if (this.stream) {
        log("the service registration changed; replacing the stream");
        this.stream.abort.abort(new Cut("replaced", "the service was replaced"));
      } else {
        log("the service registration changed; connecting now");
        if (this.retryTimer) clearTimeout(this.retryTimer);
        this.retryTimer = null;
        void this.connect(run);
      }
    } finally {
      this.polling = false;
    }
  }

  // ── Status and listeners ──────────────────────────────────────────────────

  private armUnreachable() {
    if (this.unreachableTimer) clearTimeout(this.unreachableTimer);
    this.unreachableTimer = null;
    if (this.downSince === null) return;
    const wait = Math.max(0, this.downSince + this.timing.unreachableAfterMs - Date.now());
    this.unreachableTimer = setTimeout(() => {
      this.unreachableTimer = null;
      if (this.downSince === null || this.listeners.size === 0) return;
      this.setStatus({ state: "unreachable", reason: this.lastReason });
    }, wait);
  }

  private setStatus(next: ServiceStatus) {
    if (next.state === "unreachable") next = { state: "unreachable", reason: scrub(next.reason) };
    const prev = this.current;
    if (
      prev.state === next.state &&
      (prev.state !== "unreachable" || prev.reason === (next as { reason: string }).reason)
    ) {
      return;
    }
    this.current = next;
    log(`status ${next.state}${next.state === "unreachable" ? `: ${next.reason}` : ""}`);
    this.tell((l) => l.onStatus(next));
  }

  private tell(fn: (listener: ServiceListener) => void) {
    // A copy: one subscribing during this round waits for the next. One that left
    // during an earlier callback of this round hears nothing more.
    for (const listener of Array.from(this.listeners)) {
      if (this.listeners.has(listener)) this.call(listener, fn);
    }
  }

  // A listener that throws must not take the stream, or the other listeners, down.
  private call(listener: ServiceListener, fn: (listener: ServiceListener) => void) {
    try {
      fn(listener);
    } catch (err) {
      log(`a listener threw: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

// A client of its own; the app uses getOpencodeService(). Tests point it at a fake
// service through `env`/`home`, and shorten its timings.
export function createOpencodeService(options: ServiceOptions = {}): OpencodeService {
  return new ServiceClient(options);
}

let shared: OpencodeService | null = null;

// The process-wide client.
export function getOpencodeService(): OpencodeService {
  shared ??= createOpencodeService();
  return shared;
}
