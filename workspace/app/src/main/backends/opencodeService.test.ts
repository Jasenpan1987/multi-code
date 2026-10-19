// The service client against a fake OpenCode service: a real local HTTP server that
// speaks the routes and the SSE framing of v2.0.32 (docs/timeline/
// 2026-10-20_opencode-v2-source-reading.md), found through a registration file in a
// temp dir. Never the real HOME, never the builder's service: every client here gets
// an explicit `env` and `home`.
//
// Timings are shortened rather than faked: the stream runs over a real socket, and
// Node's fetch keeps timers of its own.
//
// After every test, nothing debugTrace was given and no status a listener heard may
// carry a password.

import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import type { AddressInfo } from "net";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../debug-trace", () => ({ debugTrace: vi.fn() }));

import { debugTrace } from "../debug-trace";
import {
  DEFAULT_TIMING,
  SseParser,
  createOpencodeService,
  getOpencodeService,
  registrationPath,
  type ServiceEvent,
  type ServiceListener,
  type ServiceOptions,
  type ServiceStatus,
  type ServiceTiming,
} from "./opencodeService";

const PASSWORD = "pw-A-3f9c1e7d5b";
const PASSWORD_B = "pw-B-8a2d4c6e0f";
const basic = (password: string) =>
  "Basic " + Buffer.from(`opencode:${password}`).toString("base64");
const SECRETS = [PASSWORD, PASSWORD_B, basic(PASSWORD).slice(6), basic(PASSWORD_B).slice(6)];

const FAST: ServiceTiming = {
  requestMs: 1_000,
  connectMs: 500,
  stallMs: 300,
  backoffMinMs: 20,
  backoffMaxMs: 80,
  stableMs: 10_000,
  registrationPollMs: 40,
  unreachableAfterMs: 250,
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), "multicode-oc-service-"));
let dirs = 0;
const cleanups: (() => void | Promise<void>)[] = [];
const heardStatuses: ServiceStatus[] = [];

afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
  for (const [msg] of vi.mocked(debugTrace).mock.calls) {
    for (const secret of SECRETS) expect(msg).not.toContain(secret);
  }
  for (const status of heardStatuses.splice(0)) {
    const text = JSON.stringify(status);
    for (const secret of SECRETS) expect(text).not.toContain(secret);
  }
  vi.mocked(debugTrace).mockClear();
  vi.unstubAllEnvs();
});

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(cond: () => boolean, ms = 3_000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await sleep(5);
  }
}

// A state dir of its own for each test, and a home that holds nothing.
function scratch() {
  const dir = path.join(root, String(dirs++));
  const state = path.join(dir, "state");
  const home = path.join(dir, "home");
  fs.mkdirSync(home, { recursive: true });
  return { dir, state, home, env: { XDG_STATE_HOME: state } };
}

interface Reg {
  id?: string;
  version?: string;
  url: string;
  pid: number;
  password?: string;
}

// Atomically, as OpenCode writes it: the client's poll must never read half a file.
function writeReg(stateDir: string, reg: Reg | string) {
  const dir = path.join(stateDir, "opencode");
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `service.json.${process.pid}.tmp`);
  fs.writeFileSync(tmp, typeof reg === "string" ? reg : JSON.stringify(reg), { mode: 0o600 });
  fs.renameSync(tmp, path.join(dir, "service.json"));
}

interface Seen {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

interface FakeStream {
  res: http.ServerResponse;
  headers: http.IncomingHttpHeaders;
  closed: boolean;
}

type Handler = (res: http.ServerResponse, req: Seen) => void;

const frame = (event: Record<string, unknown>) => `data: ${JSON.stringify(event)}\n\n`;
const CONNECTED = frame({ id: "evt_0", type: "server.connected", data: {} });

function json(status: number, body?: unknown): Handler {
  return (res) => {
    if (body === undefined) {
      res.writeHead(status);
      res.end();
      return;
    }
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
}

class FakeService {
  readonly requests: Seen[] = [];
  readonly streams: FakeStream[] = [];
  readonly routes = new Map<string, Handler>();
  // What a new `GET /api/event` gets once its headers are out.
  onStream: (stream: FakeStream, index: number) => void = (s) => s.res.write(CONNECTED);
  // When set, `GET /api/event` is answered with this status instead.
  eventStatus: number | null = null;
  private readonly server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => this.handle(req, res, body));
  });

  async start(): Promise<this> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => this.close());
    return this;
  }

  get url(): string {
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  route(key: string, handler: Handler) {
    this.routes.set(key, handler);
  }

  eventRequests(): number {
    return this.requests.filter((r) => r.url === "/api/event").length;
  }

  async close() {
    for (const s of this.streams) s.res.destroy();
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse, body: string) {
    const seen: Seen = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, body };
    this.requests.push(seen);
    if (seen.method === "GET" && seen.url === "/api/event") {
      if (this.eventStatus !== null) return json(this.eventStatus, { name: "Unavailable" })(res, seen);
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.flushHeaders();
      const stream: FakeStream = { res, headers: req.headers, closed: false };
      res.on("close", () => (stream.closed = true));
      this.streams.push(stream);
      this.onStream(stream, this.streams.length - 1);
      return;
    }
    const handler = this.routes.get(`${seen.method} ${seen.url}`);
    if (handler) return handler(res, seen);
    json(404, { name: "NotFound" })(res, seen);
  }
}

// A port nothing listens on: a server bound and closed again.
async function deadUrl(): Promise<string> {
  const s = await new FakeService().start();
  const url = s.url;
  await s.close();
  return url;
}

function client(options: ServiceOptions & { timing?: Partial<ServiceTiming> }) {
  return createOpencodeService({ ...options, timing: { ...FAST, ...options.timing } });
}

// Wraps the real fetch so a test can tell whether any request went out at all.
function countingFetch() {
  return vi.fn((input: string | URL | Request, init?: RequestInit) => fetch(input, init));
}

function recorder() {
  const events: ServiceEvent[] = [];
  const statuses: ServiceStatus[] = [];
  let resyncs = 0;
  const listener: ServiceListener = {
    onEvent: (e) => events.push(e),
    onResync: () => resyncs++,
    onStatus: (s) => {
      statuses.push(s);
      heardStatuses.push(s);
    },
  };
  return {
    listener,
    events,
    statuses,
    resyncs: () => resyncs,
    last: () => statuses[statuses.length - 1],
  };
}

function subscribe(service: ReturnType<typeof client>, listener: ServiceListener) {
  const off = service.subscribe(listener);
  cleanups.push(off);
  return off;
}

// A live fake with a registration pointing at it; `null` for one without a password.
async function setup(password: string | null = PASSWORD) {
  const fake = await new FakeService().start();
  const s = scratch();
  const reg: Reg = { id: "svc-1", version: "2.0.32", url: fake.url, pid: 4242 };
  if (password !== null) reg.password = password;
  writeReg(s.state, reg);
  return { fake, ...s };
}

describe("registrationPath", () => {
  it("is under XDG_STATE_HOME when it is set", () => {
    expect(registrationPath({ XDG_STATE_HOME: "/x/state" }, "/home/u")).toBe(
      "/x/state/opencode/service.json"
    );
  });

  it("falls back to ~/.local/state when XDG_STATE_HOME is unset or empty, as OpenCode does", () => {
    expect(registrationPath({}, "/home/u")).toBe("/home/u/.local/state/opencode/service.json");
    expect(registrationPath({ XDG_STATE_HOME: "" }, "/home/u")).toBe(
      "/home/u/.local/state/opencode/service.json"
    );
  });
});

describe("discovery and auth", () => {
  it("finds the service through XDG_STATE_HOME", async () => {
    const { fake, env, home } = await setup();
    fake.route("GET /api/session/active", json(200, { data: { ses_a: { type: "running" } } }));
    expect(await client({ env, home }).activeSessions()).toEqual(new Set(["ses_a"]));
  });

  it("finds it under the home directory without XDG_STATE_HOME", async () => {
    const fake = await new FakeService().start();
    const s = scratch();
    writeReg(path.join(s.home, ".local", "state"), { url: fake.url, pid: 7, password: PASSWORD });
    fake.route("GET /api/session/active", json(200, { data: { ses_h: { type: "running" } } }));
    expect(await client({ env: {}, home: s.home }).activeSessions()).toEqual(new Set(["ses_h"]));
  });

  it("reads process.env at lookup time by default", async () => {
    const { fake, state, home } = await setup();
    fake.route("GET /api/session/active", json(200, { data: {} }));
    const service = client({ home });
    vi.stubEnv("XDG_STATE_HOME", state);
    expect(await service.activeSessions()).toEqual(new Set());
  });

  it("sends Basic opencode:<password> on reads, replies and the event stream", async () => {
    const { fake, env, home } = await setup();
    fake.route("GET /api/session/active", json(200, { data: {} }));
    fake.route("POST /api/session/ses_1/permission/per_1/reply", json(204));
    const service = client({ env, home });
    await service.activeSessions();
    await service.replyPermission("ses_1", "per_1", "once");
    const rec = recorder();
    subscribe(service, rec.listener);
    await until(() => rec.resyncs() === 1);
    expect(fake.requests.map((r) => r.headers.authorization)).toEqual([
      basic(PASSWORD),
      basic(PASSWORD),
      basic(PASSWORD),
    ]);
    expect(fake.streams[0].headers.accept).toBe("text/event-stream");
  });

  it("sends no Authorization header when the registration has no password", async () => {
    const { fake, env, home } = await setup(null);
    fake.route("GET /api/session/active", json(200, { data: {} }));
    await client({ env, home }).activeSessions();
    expect(fake.requests[0].headers.authorization).toBeUndefined();
  });

  it.each([
    ["another host", "http://192.168.1.20:4096"],
    ["a name", "http://example.com:4096"],
    ["https", "https://127.0.0.1:4096"],
    ["credentials in the URL", `http://opencode:${PASSWORD}@127.0.0.1:4096`],
    ["not a URL", "127.0.0.1:4096"],
  ])("refuses a registration naming %s: no request, unreachable", async (_name, url) => {
    const s = scratch();
    writeReg(s.state, { id: "svc-x", url, pid: 9, password: PASSWORD });
    const f = countingFetch();
    const service = client({ env: s.env, home: s.home, fetch: f });
    expect(await service.activeSessions()).toBeNull();
    expect(await service.replyPermission("ses_1", "per_1", "once")).toEqual({
      ok: false,
      reason: "failed",
    });
    const rec = recorder();
    subscribe(service, rec.listener);
    await until(() => rec.last()?.state === "unreachable");
    expect(rec.last()).toEqual({
      state: "unreachable",
      reason: "the service registration names an address that isn't loopback",
    });
    await sleep(100);
    expect(f).not.toHaveBeenCalled();
  });

  it("accepts localhost and [::1] as loopback", async () => {
    const { fake, env, home } = await setup();
    fake.route("GET /api/session/active", json(200, { data: {} }));
    const port = new URL(fake.url).port;
    const s = scratch();
    for (const url of [`http://localhost:${port}`, `http://[::1]:${port}`]) {
      writeReg(s.state, { url, pid: 3, password: PASSWORD });
      const f = vi.fn(async (input: string | URL | Request) => {
        expect(String(input)).toBe(`${url}/api/session/active`);
        return new Response(JSON.stringify({ data: {} }), { status: 200 });
      });
      expect(await client({ env: s.env, home: s.home, fetch: f }).activeSessions()).toEqual(
        new Set()
      );
      expect(f).toHaveBeenCalledTimes(1);
    }
    expect(await client({ env, home }).activeSessions()).toEqual(new Set());
  });

  it("makes no request without a registration, and reports it after the threshold", async () => {
    const s = scratch();
    const f = countingFetch();
    const service = client({ env: s.env, home: s.home, fetch: f });
    expect(await service.activeSessions()).toBeNull();
    expect(await service.session("ses_1")).toBeNull();
    expect(await service.cancelForm("ses_1", "frm_1")).toEqual({ ok: false, reason: "failed" });
    const rec = recorder();
    const started = Date.now();
    subscribe(service, rec.listener);
    await until(() => rec.last()?.state === "unreachable");
    expect(Date.now() - started).toBeGreaterThanOrEqual(FAST.unreachableAfterMs - 5);
    expect(rec.statuses).toEqual([
      { state: "connecting" },
      {
        state: "unreachable",
        reason: "no service registration (OpenCode's background service isn't running)",
      },
    ]);
    expect(f).not.toHaveBeenCalled();
  });

  it("treats a corrupt registration as none, without quoting it", async () => {
    const s = scratch();
    writeReg(s.state, `{"url":"http://127.0.0.1:1","password":"${PASSWORD}",`);
    const f = countingFetch();
    const service = client({ env: s.env, home: s.home, fetch: f });
    expect(await service.activeSessions()).toBeNull();
    const rec = recorder();
    subscribe(service, rec.listener);
    await until(() => rec.last()?.state === "unreachable");
    expect(rec.last()).toEqual({
      state: "unreachable",
      reason: "the service registration can't be read",
    });
    writeReg(s.state, { url: "http://127.0.0.1:1", pid: 0 });
    expect(await service.activeSessions()).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });

  it("connects as soon as a registration appears, without waiting out the backoff", async () => {
    const fake = await new FakeService().start();
    const s = scratch();
    const rec = recorder();
    subscribe(client({ env: s.env, home: s.home, timing: { backoffMinMs: 5_000 } }), rec.listener);
    await sleep(60);
    const appeared = Date.now();
    writeReg(s.state, { id: "svc-new", url: fake.url, pid: 11, password: PASSWORD });
    await until(() => rec.resyncs() === 1, 1_000);
    expect(Date.now() - appeared).toBeLessThan(500);
    expect(rec.last()).toEqual({ state: "connected" });
  });
});

describe("SseParser", () => {
  const parse = (chunks: string[], max?: number) => {
    const frames: string[] = [];
    const parser = new SseParser((d) => frames.push(d), max);
    for (const c of chunks) parser.push(c);
    return frames;
  };

  const SAMPLE =
    'data: {"a":1}\n\n' +
    ": heartbeat\n\n" +
    'data: {"b":\r\ndata: 2}\r\n\r\n' +
    "event: ignored\nid: 7\nretry: 10\ndata:no-space\n\n" +
    "data: lone\rdata: cr\r\r" +
    "data\n\n" +
    "data: tail";

  const EXPECTED = ['{"a":1}', '{"b":\n2}', "no-space", "lone\ncr", ""];

  it("splits frames on blank lines, joins multi-line data, skips comments and other fields", () => {
    expect(parse([SAMPLE])).toEqual(EXPECTED);
  });

  it("gives the same frames however the text is split", () => {
    for (let i = 0; i <= SAMPLE.length; i++) {
      expect(parse([SAMPLE.slice(0, i), SAMPLE.slice(i)])).toEqual(EXPECTED);
    }
    expect(parse([...SAMPLE])).toEqual(EXPECTED);
  });

  it("doesn't take a CRLF split across pushes for two line ends", () => {
    expect(parse(["data: a\r", "\ndata: b\r", "\n\r", "\n"])).toEqual(["a\nb"]);
  });

  it("keeps an unterminated frame back", () => {
    expect(parse(["data: x\n"])).toEqual([]);
  });

  it("throws on a pending frame over its limit", () => {
    expect(() => parse(["data: 0123456789"], 10)).toThrow();
    expect(parse(["data: 0123\n\n"], 10)).toEqual(["0123"]);
  });
});

describe("event stream", () => {
  it("re-syncs on server.connected and delivers events after it", async () => {
    const { fake, env, home } = await setup();
    const rec = recorder();
    subscribe(client({ env, home }), rec.listener);
    await until(() => rec.resyncs() === 1);
    expect(rec.statuses).toEqual([{ state: "connecting" }, { state: "connected" }]);
    fake.streams[0].res.write(
      frame({
        id: "evt_1",
        created: 1,
        type: "session.created",
        location: { directory: "/w/p", workspaceID: "wrk_1" },
        data: { sessionID: "ses_1", parentID: "ses_0" },
      }) + frame({ id: "evt_2", type: "session.execution.started", data: { sessionID: "ses_1" } })
    );
    await until(() => rec.events.length === 2);
    expect(rec.events).toEqual([
      {
        type: "session.created",
        data: { sessionID: "ses_1", parentID: "ses_0" },
        location: { directory: "/w/p" },
      },
      { type: "session.execution.started", data: { sessionID: "ses_1" } },
    ]);
    expect(rec.resyncs()).toBe(1);
  });

  it("parses frames split across writes, byte by byte, and drops malformed ones", async () => {
    const { fake, env, home } = await setup();
    const rec = recorder();
    subscribe(client({ env, home }), rec.listener);
    await until(() => rec.resyncs() === 1);
    const text =
      'data: {"type":"a.one","data":{"n":1}}\r\n\r\n' +
      ": heartbeat\n\n" +
      'data: {"type":"a.two",\ndata: "data":{"n":2},"location":{"directory":"/p"}}\n\n' +
      "data: not json\n\n" +
      "data: [1,2]\n\n" +
      'data: {"no":"type"}\n\n' +
      'data: {"type":"bad.data","data":"x"}\n\n' +
      'data: {"type":"a.three","data":{"s":"héllo ✓"}}\r\r';
    const bytes = Buffer.from(text, "utf8");
    for (let i = 0; i < bytes.length; i += 5) {
      fake.streams[0].res.write(bytes.subarray(i, i + 5));
      await sleep(1);
    }
    await until(() => rec.events.length === 3);
    expect(rec.events).toEqual([
      { type: "a.one", data: { n: 1 } },
      { type: "a.two", data: { n: 2 }, location: { directory: "/p" } },
      { type: "a.three", data: { s: "héllo ✓" } },
    ]);
    // Malformed frames are dropped, not taken for a broken stream.
    expect(fake.eventRequests()).toBe(1);
  });

  it("reconnects when the service ends the stream, and re-syncs again", async () => {
    const { fake, env, home } = await setup();
    fake.onStream = (s, i) => {
      s.res.write(CONNECTED);
      if (i === 0) s.res.end();
    };
    const rec = recorder();
    subscribe(client({ env, home }), rec.listener);
    await until(() => rec.resyncs() === 2);
    expect(fake.eventRequests()).toBe(2);
    expect(rec.statuses).toEqual([
      { state: "connecting" },
      { state: "connected" },
      { state: "connecting" },
      { state: "connected" },
    ]);
  });

  it("refuses a stream that doesn't open with server.connected, and retries", async () => {
    const { fake, env, home } = await setup();
    fake.onStream = (s, i) => {
      if (i === 0) s.res.write(frame({ type: "session.execution.started", data: { sessionID: "x" } }));
      else s.res.write(CONNECTED + frame({ type: "after", data: {} }));
    };
    const rec = recorder();
    subscribe(client({ env, home }), rec.listener);
    await until(() => rec.events.length === 1);
    expect(rec.events.map((e) => e.type)).toEqual(["after"]);
    expect(rec.resyncs()).toBe(1);
    await until(() => fake.streams[0].closed);
  });

  it("treats a silent stream as dropped", async () => {
    const { fake, env, home } = await setup();
    const rec = recorder();
    subscribe(client({ env, home }), rec.listener);
    await until(() => rec.resyncs() === 2, 2_000);
    expect(fake.streams[0].closed).toBe(true);
    expect(fake.eventRequests()).toBe(2);
  });

  it("keeps a stream that sends only heartbeats", async () => {
    const { fake, env, home } = await setup();
    const rec = recorder();
    subscribe(client({ env, home }), rec.listener);
    await until(() => rec.resyncs() === 1);
    for (let i = 0; i < 8; i++) {
      fake.streams[0].res.write(": heartbeat\n\n");
      await sleep(100);
    }
    expect(fake.eventRequests()).toBe(1);
    expect(rec.resyncs()).toBe(1);
    expect(rec.last()).toEqual({ state: "connected" });
  });

  it("gives up on a stream that opens but never sends server.connected", async () => {
    const { fake, env, home } = await setup();
    fake.onStream = (s, i) => {
      if (i === 0) s.res.write(": heartbeat\n\n");
      else s.res.write(CONNECTED);
    };
    const rec = recorder();
    subscribe(client({ env, home }), rec.listener);
    await until(() => rec.resyncs() === 1, 2_000);
    expect(fake.streams[0].closed).toBe(true);
    expect(fake.eventRequests()).toBe(2);
  });

  it("follows a replaced service to its new port and password, and re-syncs", async () => {
    const { fake: a, state, env, home } = await setup();
    const b = await new FakeService().start();
    const rec = recorder();
    subscribe(client({ env, home }), rec.listener);
    await until(() => rec.resyncs() === 1);
    writeReg(state, { id: "svc-2", version: "2.0.33", url: b.url, pid: 5151, password: PASSWORD_B });
    await until(() => rec.resyncs() === 2);
    expect(b.streams[0].headers.authorization).toBe(basic(PASSWORD_B));
    await until(() => a.streams[0].closed);
    b.streams[0].res.write(frame({ type: "from.b", data: {} }));
    await until(() => rec.events.length === 1);
    expect(rec.events[0].type).toBe("from.b");
    expect(rec.statuses.some((s) => s.state === "unreachable")).toBe(false);
    expect(rec.last()).toEqual({ state: "connected" });
  });

  it("reconnects when the registration names a new process on the same address", async () => {
    const { fake, state, env, home } = await setup();
    const rec = recorder();
    subscribe(client({ env, home }), rec.listener);
    await until(() => rec.resyncs() === 1);
    writeReg(state, { id: "svc-1b", version: "2.0.32", url: fake.url, pid: 4343, password: PASSWORD });
    await until(() => rec.resyncs() === 2);
    expect(fake.streams[0].closed).toBe(true);
    expect(fake.eventRequests()).toBe(2);
  });

  it("goes connecting at once when the stream is lost, unreachable only after the threshold", async () => {
    const { fake, env, home } = await setup();
    const rec = recorder();
    subscribe(client({ env, home }), rec.listener);
    await until(() => rec.resyncs() === 1);
    fake.eventStatus = 503;
    const lost = Date.now();
    fake.streams[0].res.end();
    await until(() => rec.last()?.state === "connecting");
    await until(() => rec.last()?.state === "unreachable");
    expect(Date.now() - lost).toBeGreaterThanOrEqual(FAST.unreachableAfterMs - 5);
    expect(rec.last()).toEqual({
      state: "unreachable",
      reason: "the service is starting or stopping (HTTP 503)",
    });
    // And back once the service answers again.
    fake.eventStatus = null;
    await until(() => rec.last()?.state === "connected");
    expect(rec.resyncs()).toBe(2);
  });

  it("says why when nothing listens at the registered address, and recovers when one does", async () => {
    const s = scratch();
    writeReg(s.state, { id: "svc-dead", url: await deadUrl(), pid: 12, password: PASSWORD });
    const rec = recorder();
    subscribe(client({ env: s.env, home: s.home }), rec.listener);
    await until(() => rec.last()?.state === "unreachable");
    expect(rec.last()).toEqual({ state: "unreachable", reason: "connection failed (ECONNREFUSED)" });
    const fake = await new FakeService().start();
    writeReg(s.state, { id: "svc-live", url: fake.url, pid: 13, password: PASSWORD });
    await until(() => rec.last()?.state === "connected");
    expect(rec.resyncs()).toBe(1);
  });

  it("reports a refused password without the password", async () => {
    const { fake, env, home } = await setup();
    fake.eventStatus = 401;
    const rec = recorder();
    subscribe(client({ env, home }), rec.listener);
    await until(() => rec.last()?.state === "unreachable");
    expect(rec.last()).toEqual({
      state: "unreachable",
      reason: "the service refused the password in its registration (HTTP 401)",
    });
    const traced = vi.mocked(debugTrace).mock.calls.map(([m]) => m);
    expect(traced.some((m) => m.includes("HTTP 401"))).toBe(true);
    expect(traced.some((m) => m.includes(fake.url))).toBe(true);
  });

  it("scrubs the password even from an error that quotes it", async () => {
    const s = scratch();
    writeReg(s.state, { url: "http://127.0.0.1:9", pid: 14, password: PASSWORD });
    const f = vi.fn(async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: `E_${PASSWORD}` } });
    });
    const service = client({ env: s.env, home: s.home, fetch: f });
    expect(await service.activeSessions()).toBeNull();
    const rec = recorder();
    subscribe(service, rec.listener);
    await until(() => rec.last()?.state === "unreachable");
    expect(rec.last()).toEqual({ state: "unreachable", reason: "connection failed (E_[redacted])" });
    expect(f).toHaveBeenCalled();
  });

  it("closes the stream when the last listener leaves, and not before", async () => {
    const { fake, env, home } = await setup();
    const service = client({ env, home });
    const one = recorder();
    const two = recorder();
    const offOne = subscribe(service, one.listener);
    const offTwo = subscribe(service, two.listener);
    await until(() => one.resyncs() === 1);
    offOne();
    offOne();
    await sleep(50);
    expect(fake.streams[0].closed).toBe(false);
    offTwo();
    await until(() => fake.streams[0].closed);
    await sleep(150);
    expect(fake.eventRequests()).toBe(1);
    expect(service.status()).toEqual({ state: "connecting" });
    // A new subscriber opens it again.
    const three = recorder();
    subscribe(service, three.listener);
    await until(() => three.resyncs() === 1);
    expect(fake.eventRequests()).toBe(2);
  });

  it("gives a listener joining a live stream the status and a re-sync of its own", async () => {
    const { env, home } = await setup();
    const service = client({ env, home });
    const first = recorder();
    subscribe(service, first.listener);
    await until(() => first.resyncs() === 1);
    const late = recorder();
    subscribe(service, late.listener);
    await until(() => late.resyncs() === 1);
    expect(late.statuses).toEqual([{ state: "connected" }]);
    expect(first.resyncs()).toBe(1);
    expect(service.status()).toEqual({ state: "connected" });
  });

  it("keeps going when a listener throws", async () => {
    const { fake, env, home } = await setup();
    const service = client({ env, home });
    subscribe(service, {
      onEvent: () => {
        throw new Error("boom");
      },
      onResync: () => {
        throw new Error("boom");
      },
      onStatus: () => {},
    });
    const rec = recorder();
    subscribe(service, rec.listener);
    await until(() => rec.resyncs() === 1);
    fake.streams[0].res.write(frame({ type: "x.one", data: {} }) + frame({ type: "x.two", data: {} }));
    await until(() => rec.events.length === 2);
    expect(fake.eventRequests()).toBe(1);
  });
});

describe("snapshot reads", () => {
  it("lists the active sessions", async () => {
    const { fake, env, home } = await setup();
    fake.route(
      "GET /api/session/active",
      json(200, { data: { ses_a: { type: "running" }, ses_b: { type: "running" } } })
    );
    expect(await client({ env, home }).activeSessions()).toEqual(new Set(["ses_a", "ses_b"]));
  });

  it("reads a session, its directory from its location", async () => {
    const { fake, env, home } = await setup();
    fake.route(
      "GET /api/session/ses_1",
      json(200, {
        data: {
          id: "ses_1",
          parentID: "ses_0",
          location: { directory: "/w/p" },
          outcome: "succeeded",
          title: "t",
          time: { created: 1, updated: 2 },
        },
      })
    );
    fake.route("GET /api/session/ses_root", json(200, { data: { id: "ses_root" } }));
    fake.route("GET /api/session/ses_gone", json(404, { name: "SessionNotFoundError" }));
    fake.route("GET /api/session/ses_bad", json(200, { data: { title: "no id" } }));
    fake.route("GET /api/session/ses%2Fa%20b", json(200, { data: { id: "ses/a b" } }));
    const service = client({ env, home });
    expect(await service.session("ses_1")).toEqual({
      id: "ses_1",
      parentID: "ses_0",
      directory: "/w/p",
      outcome: "succeeded",
    });
    expect(await service.session("ses_root")).toEqual({ id: "ses_root" });
    expect(await service.session("ses_gone")).toBeNull();
    expect(await service.session("ses_bad")).toBeNull();
    expect(await service.session("ses/a b")).toEqual({ id: "ses/a b" });
  });

  it("lists pending permissions and forms", async () => {
    const { fake, env, home } = await setup();
    fake.route(
      "GET /api/session/ses_1/permission",
      json(200, {
        data: [
          {
            id: "per_1",
            sessionID: "ses_1",
            action: "shell",
            resources: ["git push"],
            save: ["git push *"],
            metadata: { command: "git push" },
            source: { type: "tool", messageID: "msg_1", id: "call_1" },
          },
          { id: "per_2", sessionID: "ses_1", action: "edit", resources: ["/w/p/a.ts"] },
        ],
      })
    );
    fake.route(
      "GET /api/session/ses_1/form",
      json(200, {
        data: [
          {
            id: "frm_1",
            sessionID: "ses_1",
            title: "Questions",
            metadata: { kind: "question", tool: { messageID: "msg_1", id: "call_2" } },
            fields: [
              {
                key: "q0",
                type: "string",
                title: "Pick",
                description: "Which one?",
                options: [
                  { value: "A", label: "A", description: "first" },
                  { value: "B", label: "B" },
                ],
                custom: true,
              },
              { key: "q1", type: "multiselect", options: [{ value: "x", label: "x" }] },
            ],
          },
        ],
      })
    );
    const service = client({ env, home });
    expect(await service.pendingPermissions("ses_1")).toEqual([
      {
        id: "per_1",
        sessionID: "ses_1",
        action: "shell",
        resources: ["git push"],
        save: ["git push *"],
        metadata: { command: "git push" },
      },
      { id: "per_2", sessionID: "ses_1", action: "edit", resources: ["/w/p/a.ts"] },
    ]);
    expect(await service.pendingForms("ses_1")).toEqual([
      {
        id: "frm_1",
        sessionID: "ses_1",
        title: "Questions",
        metadata: { kind: "question", tool: { messageID: "msg_1", id: "call_2" } },
        fields: [
          {
            key: "q0",
            type: "string",
            title: "Pick",
            description: "Which one?",
            options: [
              { value: "A", label: "A", description: "first" },
              { value: "B", label: "B" },
            ],
            custom: true,
          },
          { key: "q1", type: "multiselect", options: [{ value: "x", label: "x" }] },
        ],
      },
    ]);
  });

  it("returns null for a list it can't trust", async () => {
    const { fake, env, home } = await setup();
    fake.route("GET /api/session/s1/permission", json(200, { data: { not: "a list" } }));
    fake.route(
      "GET /api/session/s2/permission",
      json(200, { data: [{ id: "per_1", sessionID: "s2", action: "x", resources: [] }, { id: 3 }] })
    );
    fake.route("GET /api/session/s3/permission", json(500, { name: "UnknownError" }));
    fake.route("GET /api/session/s1/form", json(200, { data: [{ id: "frm_1", sessionID: "s1" }] }));
    fake.route(
      "GET /api/session/s2/form",
      json(200, { data: [{ id: "frm_1", sessionID: "s2", fields: [{ key: "q0" }] }] })
    );
    fake.route("GET /api/session/s3/form", (res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{not json");
    });
    fake.route("GET /api/session/s4/form", json(200, { data: [] }));
    const service = client({ env, home });
    expect(await service.pendingPermissions("s1")).toBeNull();
    expect(await service.pendingPermissions("s2")).toBeNull();
    expect(await service.pendingPermissions("s3")).toBeNull();
    expect(await service.pendingForms("s1")).toBeNull();
    expect(await service.pendingForms("s2")).toBeNull();
    expect(await service.pendingForms("s3")).toBeNull();
    expect(await service.pendingForms("s4")).toEqual([]);
    fake.route("GET /api/session/active", json(200, { data: ["ses_a"] }));
    expect(await service.activeSessions()).toBeNull();
  });

  it("returns null when the service can't be reached or doesn't answer in time", async () => {
    const s = scratch();
    writeReg(s.state, { url: await deadUrl(), pid: 15, password: PASSWORD });
    expect(await client({ env: s.env, home: s.home }).activeSessions()).toBeNull();

    const { fake, env, home } = await setup();
    fake.route("GET /api/session/active", () => {});
    const started = Date.now();
    expect(await client({ env, home, timing: { requestMs: 150 } }).activeSessions()).toBeNull();
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe("replies", () => {
  it("posts a permission decision, with and without a message, to encoded paths", async () => {
    const { fake, env, home } = await setup();
    fake.route("POST /api/session/ses_1/permission/per_1/reply", json(204));
    fake.route("POST /api/session/ses%2F1/permission/per%3F2/reply", json(204));
    const service = client({ env, home });
    expect(await service.replyPermission("ses_1", "per_1", "always")).toEqual({ ok: true });
    expect(await service.replyPermission("ses/1", "per?2", "reject", "use rg")).toEqual({ ok: true });
    expect(fake.requests.map((r) => [r.method, r.url, JSON.parse(r.body)])).toEqual([
      ["POST", "/api/session/ses_1/permission/per_1/reply", { decision: "always" }],
      ["POST", "/api/session/ses%2F1/permission/per%3F2/reply", { decision: "reject", message: "use rg" }],
    ]);
    expect(fake.requests[0].headers["content-type"]).toBe("application/json");
  });

  it("posts a form answer and cancels a form, with the message as a query", async () => {
    const { fake, env, home } = await setup();
    fake.route("POST /api/session/ses_1/form/frm_1/reply", json(204));
    fake.route("DELETE /api/session/ses_1/form/frm_1", json(204));
    fake.route("DELETE /api/session/ses_1/form/frm_2?message=not%20now%20%26%20later", json(204));
    const service = client({ env, home });
    expect(await service.replyForm("ses_1", "frm_1", { q0: "A", q1: ["x", "y"] })).toEqual({
      ok: true,
    });
    expect(await service.cancelForm("ses_1", "frm_1")).toEqual({ ok: true });
    expect(await service.cancelForm("ses_1", "frm_2", "not now & later")).toEqual({ ok: true });
    expect(JSON.parse(fake.requests[0].body)).toEqual({ answer: { q0: "A", q1: ["x", "y"] } });
    expect(fake.requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      "POST /api/session/ses_1/form/frm_1/reply",
      "DELETE /api/session/ses_1/form/frm_1",
      "DELETE /api/session/ses_1/form/frm_2?message=not%20now%20%26%20later",
    ]);
    // The builder's words stay out of the log.
    const traced = vi.mocked(debugTrace).mock.calls.map(([m]) => m).join("\n");
    expect(traced).not.toContain("not now");
  });

  it.each([
    [204, { ok: true }],
    [200, { ok: true }],
    [404, { ok: false, reason: "gone" }],
    [409, { ok: false, reason: "gone" }],
    [400, { ok: false, reason: "failed" }],
    [401, { ok: false, reason: "failed" }],
    [500, { ok: false, reason: "failed" }],
  ])("maps HTTP %i to %o", async (status, expected) => {
    const { fake, env, home } = await setup();
    const body = status === 204 ? undefined : { name: "X", echoed: basic(PASSWORD) };
    fake.route("POST /api/session/s/permission/p/reply", json(status, body));
    fake.route("POST /api/session/s/form/f/reply", json(status, body));
    fake.route("DELETE /api/session/s/form/f", json(status, body));
    const service = client({ env, home });
    expect(await service.replyPermission("s", "p", "once")).toEqual(expected);
    expect(await service.replyForm("s", "f", { q0: "A" })).toEqual(expected);
    expect(await service.cancelForm("s", "f")).toEqual(expected);
  });

  it("maps a network error to failed", async () => {
    const s = scratch();
    writeReg(s.state, { url: await deadUrl(), pid: 16, password: PASSWORD });
    const service = client({ env: s.env, home: s.home });
    expect(await service.replyPermission("s", "p", "once")).toEqual({ ok: false, reason: "failed" });
    expect(await service.replyForm("s", "f", { q0: "A" })).toEqual({ ok: false, reason: "failed" });
  });
});

describe("defaults", () => {
  it("uses the official client's stall rule and the PRD's bar threshold", () => {
    expect(DEFAULT_TIMING.stallMs).toBe(45_000);
    expect(DEFAULT_TIMING.unreachableAfterMs).toBe(15_000);
  });

  it("shares one client per process", () => {
    expect(getOpencodeService()).toBe(getOpencodeService());
  });
});
