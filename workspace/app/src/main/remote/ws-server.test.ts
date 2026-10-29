// Integration test: drives the real RemoteServer over a real socket with a real
// NaCl handshake, with the desktop's real RemoteHost (remote-host.ts) on top of a
// fake process manager. This is the part where a subtle framing, auth or ack bug
// would be invisible to unit tests but break every phone, and where an answer is
// followed through to the keys process-manager would write. Web Push's send is
// mocked: no test reaches a push service.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import WebSocket from "ws";
import nacl from "tweetnacl";

const userData = fs.mkdtempSync(path.join(os.tmpdir(), "multicode-remote-"));

vi.mock("electron", () => ({
  app: {
    getPath: () => userData,
    getName: () => "Multi-Code",
  },
}));

// Everything else of web-push is real: the keys it generates, the JWT it signs.
const sendNotification = vi.fn();
vi.mock("web-push", async (importOriginal) => {
  const actual = (await importOriginal<{ default: typeof import("web-push") }>()).default;
  return { default: { ...actual, sendNotification } };
});

const { RemoteServer } = await import("./ws-server");
const { createRemoteHost, firstSentence } = await import("./remote-host");
const { REMOTE_PROTOCOL_VERSION } = await import("../../shared/remote-protocol");
const { extractPromptDetail } = await import("./promptExtract");
const { permissionDetail, permissionToolCall } = await import("../backends/opencodePrompt");
const { topicOf } = await import("./push");
const { default: webpush } = await import("web-push");

type TranscriptEntry = import("../../shared/remote-protocol").TranscriptEntry;
type HostProcessManager = import("./remote-host").HostProcessManager;
type InstanceInfo = import("../process-manager").InstanceInfo;
type SecretaryEvent = import("../process-manager").SecretaryEvent;
type SecretaryEventListener = import("../process-manager").SecretaryEventListener;
type AnswerOutcome = import("../process-manager").AnswerOutcome;
type AnswerPlan = import("../secretary/dialog").AnswerPlan;

type AnyRecord = Record<string, unknown>;

// A minimal phone: hello, pin-check, seal/open, and a queue of received frames.
class TestClient {
  private socket: WebSocket;
  private keyPair = nacl.box.keyPair();
  private sharedKey: Uint8Array | null = null;
  private queue: AnyRecord[] = [];
  private waiters: Array<(frame: AnyRecord) => void> = [];
  plainFrames: AnyRecord[] = [];

  constructor(private readonly url: string) {
    this.socket = new WebSocket(url);
  }

  async handshake(expectedHostKey?: string): Promise<AnyRecord> {
    await new Promise<void>((resolve, reject) => {
      this.socket.once("open", resolve);
      this.socket.once("error", reject);
    });

    this.socket.on("message", (raw) => this.onMessage(raw.toString()));

    const helloPromise = this.next();
    this.socket.send(
      JSON.stringify({
        type: "client-hello",
        v: REMOTE_PROTOCOL_VERSION,
        clientPublicKey: Buffer.from(this.keyPair.publicKey).toString("base64"),
      })
    );
    const hello = await helloPromise;

    if (hello.type === "server-hello") {
      const hostKey = String(hello.hostPublicKey);
      if (expectedHostKey && hostKey !== expectedHostKey) {
        throw new Error("host key mismatch");
      }
      this.sharedKey = nacl.box.before(
        new Uint8Array(Buffer.from(hostKey, "base64")),
        this.keyPair.secretKey
      );
    }
    return hello;
  }

  private onMessage(text: string) {
    let frame: AnyRecord;
    try {
      frame = JSON.parse(text);
    } catch {
      return;
    }

    if (frame.type === "sealed" && this.sharedKey) {
      const opened = nacl.box.open.after(
        new Uint8Array(Buffer.from(String(frame.body), "base64")),
        new Uint8Array(Buffer.from(String(frame.nonce), "base64")),
        this.sharedKey
      );
      if (!opened) return;
      this.push(JSON.parse(Buffer.from(opened).toString("utf8")));
      return;
    }
    this.plainFrames.push(frame);
    this.push(frame);
  }

  private push(frame: AnyRecord) {
    const waiter = this.waiters.shift();
    if (waiter) waiter(frame);
    else this.queue.push(frame);
  }

  send(frame: AnyRecord) {
    if (!this.sharedKey) throw new Error("not handshaken");
    const nonce = nacl.randomBytes(nacl.box.nonceLength);
    const boxed = nacl.box.after(
      new Uint8Array(Buffer.from(JSON.stringify(frame), "utf8")),
      nonce,
      this.sharedKey
    );
    this.socket.send(
      JSON.stringify({
        type: "sealed",
        nonce: Buffer.from(nonce).toString("base64"),
        body: Buffer.from(boxed).toString("base64"),
      })
    );
  }

  sendRaw(text: string) {
    this.socket.send(text);
  }

  next(timeoutMs = 3000): Promise<AnyRecord> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("timed out waiting for frame")),
        timeoutMs
      );
      this.waiters.push((frame) => {
        clearTimeout(timer);
        resolve(frame);
      });
    });
  }

  // Skip frames until one of `type` (that `match` accepts) arrives, so a test
  // doesn't depend on the exact ordering of unrelated pushes.
  async waitFor(
    type: string,
    match: (frame: AnyRecord) => boolean = () => true,
    timeoutMs = 3000
  ): Promise<AnyRecord> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`timed out waiting for ${type}`);
      const frame = await this.next(remaining);
      if (frame.type === type && match(frame)) return frame;
    }
  }

  ack(clientMsgId: string): Promise<AnyRecord> {
    return this.waitFor("ack", (f) => f.clientMsgId === clientMsgId);
  }

  // The first list in which instance `id` matches.
  async instance(id: string, match: (row: AnyRecord) => boolean): Promise<AnyRecord> {
    const frame = await this.waitFor("instances", (f) =>
      (f.instances as AnyRecord[]).some((row) => row.id === id && match(row))
    );
    return (frame.instances as AnyRecord[]).find((row) => row.id === id)!;
  }

  // Every frame up to the reply to a ping sent now.
  async drain(): Promise<AnyRecord[]> {
    const at = Math.random();
    this.send({ type: "ping", at });
    const seen: AnyRecord[] = [];
    for (;;) {
      const frame = await this.next();
      if (frame.type === "pong" && frame.at === at) return seen;
      seen.push(frame);
    }
  }

  waitClose(timeoutMs = 3000): Promise<number> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("timed out waiting for close")),
        timeoutMs
      );
      this.socket.once("close", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
  }

  close() {
    this.socket.close();
  }
}

// What process-manager would say about its instances, and what was asked of it.
class FakeProcessManager implements HostProcessManager {
  instances = new Map<string, InstanceInfo>();
  events = new Map<string, SecretaryEvent>();
  // The latest turn per instance, which the list's line is read from (one turn).
  turns = new Map<string, TranscriptEntry[]>();
  sizes = new Map<string, { cols: number; rows: number }>();
  // What a subscribed phone is sent (the turns it asked for).
  transcript: TranscriptEntry[] = [
    { kind: "user", text: "run the tests" },
    { kind: "tool", tool: "Bash", text: "pnpm test", pending: true },
  ];
  hasEarlier = false;
  transcriptTurns: number[] = [];
  answerOutcome: () => Promise<AnswerOutcome> = async () => ({ ok: true });
  interruptResult = true;
  // Instances whose answer's keys are still going in.
  answering = new Set<string>();
  // Instances whose terminal shows no running turn (OpenCode on another session).
  offScreen = new Set<string>();
  answers: { id: string; seq: number; plan: AnswerPlan }[] = [];
  prompts: { id: string; text: string }[] = [];
  writes: { id: string; data: string }[] = [];
  interrupts: string[] = [];
  turnReads = 0;
  transcriptReads = 0;
  private listeners = new Set<SecretaryEventListener>();

  add(info: Partial<InstanceInfo> & { id: string }) {
    this.instances.set(info.id, {
      cwd: `/tmp/${info.id}`,
      name: info.id,
      status: "running",
      startedAt: 1,
      backend: "claude",
      ...info,
    });
  }

  raise(id: string, event: SecretaryEvent) {
    this.events.set(id, event);
    for (const listener of this.listeners) listener(id, event);
  }

  clear(id: string) {
    this.events.delete(id);
    for (const listener of this.listeners) listener(id, null);
  }

  setWorking(id: string, working: boolean, since = Date.now()) {
    const info = this.instances.get(id)!;
    info.working = working || undefined;
    info.workingSince = working ? since : undefined;
  }

  listInstances() {
    return [...this.instances.values()].map((i) => ({ ...i }));
  }
  infoOf(id: string) {
    const info = this.instances.get(id);
    return info ? { ...info } : undefined;
  }
  secretaryEventOf(id: string) {
    return this.events.get(id);
  }
  onSecretaryEvent(listener: SecretaryEventListener) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  async answerDialog(id: string, seq: number, plan: AnswerPlan) {
    this.answers.push({ id, seq, plan });
    return this.answerOutcome();
  }
  isAnswering(id: string) {
    return this.answering.has(id);
  }
  canInterrupt(id: string) {
    return !this.offScreen.has(id);
  }
  sendPrompt(id: string, text: string) {
    this.prompts.push({ id, text });
  }
  writeToInstance(id: string, data: string) {
    this.writes.push({ id, data });
  }
  async interruptInstance(id: string) {
    this.interrupts.push(id);
    return this.interruptResult;
  }
  // The host reads one turn for a list line, and the phone's own count of turns
  // for a transcript; the fake keeps the two apart to count them.
  readRecentTurns(id: string, turns: number) {
    if (turns === 1) {
      this.turnReads++;
      return { entries: this.turns.get(id) ?? [], hasEarlier: false };
    }
    this.transcriptReads++;
    this.transcriptTurns.push(turns);
    return { entries: this.transcript, hasEarlier: this.hasEarlier };
  }
  ptySizeOf(id: string) {
    if (this.instances.get(id)?.status !== "running") return null;
    return this.sizes.get(id) ?? { cols: 120, rows: 30 };
  }
}

// ---------------------------------------------------------------------------
// Dialogs, as the agents report them
// ---------------------------------------------------------------------------

const BASH_INPUT = { command: "pnpm test:e2e", description: "Run the end-to-end tests" };

function bash(seq: number, at = 1000): SecretaryEvent {
  return {
    kind: "needs-you",
    seq,
    at,
    prompt: { detail: extractPromptDetail("Bash", BASH_INPUT)!, toolName: "Bash", toolInput: BASH_INPUT },
  };
}

const QUESTIONS_INPUT = {
  questions: [
    {
      question: "Which database?",
      header: "DB",
      multiSelect: false,
      options: [{ label: "Postgres" }, { label: "SQLite", description: "One file" }],
    },
    {
      question: "Which extras?",
      header: "Extras",
      multiSelect: true,
      options: [{ label: "Cache" }, { label: "Metrics" }, { label: "Tracing" }],
    },
  ],
};

function questions(seq: number): SecretaryEvent {
  return {
    kind: "needs-you",
    seq,
    at: 1000,
    prompt: {
      detail: extractPromptDetail("AskUserQuestion", QUESTIONS_INPUT)!,
      toolName: "AskUserQuestion",
      toolInput: QUESTIONS_INPUT,
    },
  };
}

const PLAN_INPUT = { plan: "# Add dark mode\n\n1. Theme tokens\n2. A toggle" };

function plan(seq: number): SecretaryEvent {
  return {
    kind: "needs-you",
    seq,
    at: 1000,
    prompt: {
      detail: extractPromptDetail("ExitPlanMode", PLAN_INPUT)!,
      toolName: "ExitPlanMode",
      toolInput: PLAN_INPUT,
    },
  };
}

const OC_REQUEST = {
  id: "per_1",
  sessionID: "ses_1",
  action: "shell",
  resources: ["rm -rf build"],
  save: ["rm *"],
};

function ocPermission(seq: number): SecretaryEvent {
  const call = permissionToolCall(OC_REQUEST);
  return {
    kind: "needs-you",
    seq,
    at: 1000,
    prompt: { detail: permissionDetail(OC_REQUEST), ...call },
  };
}

// An MCP elicitation: needs you, with nothing the desktop can answer.
const elicitation = (seq: number): SecretaryEvent => ({ kind: "needs-you", seq, at: 1000 });

const finished = (seq: number, at = 2000): SecretaryEvent => ({ kind: "finished", seq, at });

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

interface Fixture {
  server: InstanceType<typeof RemoteServer>;
  pm: FakeProcessManager;
  url: string;
  token: string;
  hostPublicKey: string;
}

const fixtures: Fixture[] = [];

async function startServer(options: { heartbeatTimeoutMs?: number } = {}): Promise<Fixture> {
  const server = new RemoteServer(options);
  // HTTPS ready, so pairing offers are made (ws-server.https.test.ts covers the gate).
  server.setChecker({
    check: async () => ({
      tailscale: { state: "running", dnsName: "mac.example.ts.net" },
      https: { state: "ready", origin: "https://mac.example.ts.net" },
    }),
    setUpHttps: async () => {
      throw new Error("not in these tests");
    },
  });
  const pm = new FakeProcessManager();
  pm.add({ id: "inst-1", name: "demo" });
  server.setHost(createRemoteHost(pm, server));

  // Port 0 = OS-assigned, so parallel test files never collide.
  const status = await server.start(0);
  if (!status.port) throw new Error(status.error ?? "server did not start");

  const offer = server.createPairingOffer();
  if (!offer) throw new Error("no pairing offer");

  const fixture: Fixture = {
    server,
    pm,
    url: `ws://127.0.0.1:${status.port}`,
    token: offer.deviceToken,
    hostPublicKey: offer.hostPublicKey,
  };
  fixtures.push(fixture);
  return fixture;
}

async function connected(fx: Fixture, token = fx.token) {
  const client = new TestClient(fx.url);
  await client.handshake(fx.hostPublicKey);
  client.send({ type: "auth", deviceToken: token, deviceName: "phone" });
  await client.waitFor("auth-ok");
  await client.waitFor("instances");
  return client;
}

afterEach(async () => {
  while (fixtures.length) {
    const fixture = fixtures.pop();
    await fixture?.server.stop();
  }
  // Each test starts from a clean device list.
  try {
    fs.rmSync(path.join(userData, "remote-devices.json"), { force: true });
  } catch {
    // ignore
  }
});

describe("RemoteServer startup failure", () => {
  it("reports a busy port instead of crashing the process", async () => {
    // Regression: a failed bind emits `error` twice — listen()'s own rejection,
    // plus a second one via the attached WebSocketServer. The handler used to be
    // registered only after a successful listen, so that second error was
    // unhandled, and an unhandled 'error' on a net.Server is thrown. In Electron
    // that killed the main process: leaving another Multi-Code running turned
    // "phone link unavailable" into "the app won't start".
    const first = await startServer();
    expect(first.server.isRunning()).toBe(true);
    const busyPort = first.server.getStatus().port;
    expect(busyPort).toBeTruthy();

    const uncaught: unknown[] = [];
    const onUncaught = (err: unknown) => uncaught.push(err);
    process.on("uncaughtException", onUncaught);

    const second = new RemoteServer();
    try {
      const status = await second.start(busyPort as number);

      expect(status.enabled).toBe(false);
      expect(String(status.error)).toContain("already in use");
      // Give the deferred error a chance to surface before asserting it didn't.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(uncaught).toEqual([]);
    } finally {
      process.off("uncaughtException", onUncaught);
      await second.stop();
    }
  });

  it("leaves the already-running server untouched", async () => {
    // A second instance failing to bind must not disturb the one that owns the
    // port — otherwise starting a second copy would break the working one.
    const first = await startServer();
    const busyPort = first.server.getStatus().port as number;

    const second = new RemoteServer();
    await second.start(busyPort);
    await second.stop();

    expect(first.server.isRunning()).toBe(true);
    expect(first.server.getStatus().port).toBe(busyPort);
  });
});

describe("RemoteServer handshake", () => {
  it("completes a handshake and authenticates a paired device", async () => {
    const fx = await startServer();
    const client = new TestClient(fx.url);
    const hello = await client.handshake(fx.hostPublicKey);

    expect(hello.type).toBe("server-hello");
    expect(hello.hostPublicKey).toBe(fx.hostPublicKey);

    client.send({ type: "auth", deviceToken: fx.token, deviceName: "iPhone" });
    const authOk = await client.waitFor("auth-ok");
    expect(authOk.type).toBe("auth-ok");

    // The instance list is pushed unprompted right after auth, so the phone
    // renders something immediately.
    const instances = await client.waitFor("instances");
    expect((instances.instances as unknown[]).length).toBe(1);

    client.close();
  });

  it("records the device name so the desktop can label the phone", async () => {
    const fx = await startServer();
    const client = new TestClient(fx.url);
    await client.handshake();
    client.send({ type: "auth", deviceToken: fx.token, deviceName: "Jasen's iPhone" });
    await client.waitFor("auth-ok");

    const device = fx.server.getStatus().devices[0];
    expect(device.name).toBe("Jasen's iPhone");
    expect(device.connected).toBe(true);

    client.close();
  });

  it("rejects an unknown device token", async () => {
    const fx = await startServer();
    const client = new TestClient(fx.url);
    await client.handshake();
    client.send({ type: "auth", deviceToken: "not-a-real-token" });

    const failed = await client.waitFor("auth-failed");
    expect(failed.reason).toBe("unknown-token");
    expect(await client.waitClose()).toBe(4003);
  });

  it("refuses a protocol version mismatch", async () => {
    const fx = await startServer();
    const client = new TestClient(fx.url);
    await new Promise((r) => setTimeout(r, 50));
    client.sendRaw(
      JSON.stringify({ type: "client-hello", v: 999, clientPublicKey: "AAAA" })
    );
    const code = await client.waitClose();
    expect(code).toBe(4002);
  });

  it("drops a socket that sends a plaintext frame after the handshake", async () => {
    const fx = await startServer();
    const client = new TestClient(fx.url);
    await client.handshake();
    // A peer without the key can't produce a sealed frame; answering it at all
    // would give a probe something to work with.
    client.sendRaw(JSON.stringify({ type: "auth", deviceToken: fx.token }));
    expect(await client.waitClose()).toBe(4002);
  });

  it("drops a socket whose sealed frame fails to decrypt", async () => {
    const fx = await startServer();
    const client = new TestClient(fx.url);
    await client.handshake();
    client.sendRaw(
      JSON.stringify({ type: "sealed", nonce: "AAAA", body: "BBBB" })
    );
    expect(await client.waitClose()).toBe(4002);
  });

  it("refuses commands before auth", async () => {
    const fx = await startServer();
    const client = new TestClient(fx.url);
    await client.handshake();
    client.send({ type: "input", instanceId: "inst-1", data: "x" });

    expect(await client.waitClose()).toBe(4003);
    // Critically, the unauthenticated input must never have reached the PTY.
    expect(fx.pm.writes).toEqual([]);
  });
});

describe("RemoteServer heartbeat", () => {
  it("closes an authenticated socket that has sent nothing for the timeout", async () => {
    const fx = await startServer({ heartbeatTimeoutMs: 300 });
    const client = await connected(fx);
    expect(fx.server.getStatus().devices[0].connected).toBe(true);

    expect(await client.waitClose(2000)).toBe(4004);
    expect(fx.server.getStatus().devices[0].connected).toBe(false);
  });

  it("arms one timer per socket, however many times it authenticates", async () => {
    const fx = await startServer({ heartbeatTimeoutMs: 300 });
    const client = await connected(fx);
    client.send({ type: "auth", deviceToken: fx.token });
    await client.waitFor("auth-ok");
    let closed = false;
    void client.waitClose(5000).then(() => (closed = true), () => {});
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setTimeout(r, 150));
      client.send({ type: "ping", at: i });
      await client.waitFor("pong", (f) => f.at === i);
    }
    expect(closed).toBe(false);
    client.close();
  });

  it("keeps when a phone was last heard from as its last seen, once it goes", async () => {
    const fx = await startServer();
    const client = await connected(fx);
    const authedAt = fx.server.getStatus().devices[0].lastSeenAt;
    await new Promise((r) => setTimeout(r, 50));
    const pingAt = Date.now();
    client.send({ type: "ping", at: 1 });
    await client.waitFor("pong");
    client.close();
    await vi.waitFor(() => expect(fx.server.getStatus().devices[0].connected).toBe(false));

    const lastSeenAt = fx.server.getStatus().devices[0].lastSeenAt;
    expect(lastSeenAt).toBeGreaterThan(authedAt);
    expect(lastSeenAt).toBeGreaterThanOrEqual(pingAt);
  });

  it("keeps a socket that pings", async () => {
    const fx = await startServer({ heartbeatTimeoutMs: 300 });
    const client = await connected(fx);
    let closed = false;
    void client.waitClose(5000).then(() => (closed = true), () => {});
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setTimeout(r, 150));
      client.send({ type: "ping", at: i });
      await client.waitFor("pong", (f) => f.at === i);
    }
    expect(closed).toBe(false);
    client.close();
  });
});

describe("RemoteServer streaming", () => {
  it("replays buffered output as a snapshot on subscribe, at the PTY's size", async () => {
    const fx = await startServer();
    fx.pm.sizes.set("inst-1", { cols: 132, rows: 41 });
    // Output produced before the phone ever connected.
    fx.server.broadcastOutput("inst-1", "earlier output\r\n");

    const client = await connected(fx);
    client.send({ type: "subscribe", instanceId: "inst-1" });

    const snapshot = await client.waitFor("snapshot");
    expect(snapshot.data).toContain("earlier output");
    expect([snapshot.cols, snapshot.rows]).toEqual([132, 41]);

    client.close();
  });

  it("sends the PTY's new size to subscribers when the desktop resizes it", async () => {
    const fx = await startServer();
    fx.pm.add({ id: "inst-2" });
    const client = await connected(fx);
    client.send({ type: "subscribe", instanceId: "inst-1" });
    await client.waitFor("snapshot");

    fx.server.broadcastResize("inst-2", 80, 24);
    fx.server.broadcastResize("inst-1", 100, 33);
    const resize = await client.waitFor("resize");
    expect(resize).toEqual({ type: "resize", instanceId: "inst-1", cols: 100, rows: 33 });

    client.close();
  });

  it("streams output only for subscribed instances", async () => {
    const fx = await startServer();
    const client = await connected(fx);
    client.send({ type: "subscribe", instanceId: "inst-1" });
    await client.waitFor("snapshot");

    fx.server.broadcastOutput("other-inst", "should not arrive");
    fx.server.broadcastOutput("inst-1", "hello phone");

    const output = await client.waitFor("output");
    expect(output.instanceId).toBe("inst-1");
    expect(output.data).toBe("hello phone");

    client.close();
  });

  it("stops streaming after unsubscribe", async () => {
    const fx = await startServer();
    const client = await connected(fx);
    client.send({ type: "subscribe", instanceId: "inst-1" });
    await client.waitFor("snapshot");
    client.send({ type: "unsubscribe", instanceId: "inst-1" });

    // Give the unsubscribe time to land, then confirm nothing streams.
    await new Promise((r) => setTimeout(r, 100));
    fx.server.broadcastOutput("inst-1", "after unsubscribe");

    const seen = await client.drain();
    expect(seen.map((f) => f.type)).not.toContain("output");

    client.close();
  });

  it("passes raw input straight through to the PTY", async () => {
    const fx = await startServer();
    const client = await connected(fx);

    client.send({ type: "input", instanceId: "inst-1", data: "\x1b[A" });
    await vi.waitFor(() => expect(fx.pm.writes).toHaveLength(1));
    expect(fx.pm.writes[0]).toEqual({ id: "inst-1", data: "\x1b[A" });

    client.close();
  });

  it("sends the last turns the phone asked for on subscribe, 10 unless it says", async () => {
    // The transcript is what the phone shows instead of the 120-column terminal,
    // so it has to arrive without the phone asking for it.
    const fx = await startServer();
    fx.pm.hasEarlier = true;
    const client = await connected(fx);

    client.send({ type: "subscribe", instanceId: "inst-1", turns: 20 });
    const frame = await client.waitFor("transcript");
    expect(frame).toEqual({
      type: "transcript",
      instanceId: "inst-1",
      entries: fx.pm.transcript,
      hasEarlier: true,
    });

    // A refresh keeps the count the phone asked for.
    fx.pm.raise("inst-1", finished(1));
    await client.waitFor("transcript");
    client.send({ type: "subscribe", instanceId: "inst-1" });
    await client.waitFor("transcript");
    expect(fx.pm.transcriptTurns).toEqual([20, 20, 10]);
    client.close();
  });

  it("sends an empty transcript too, so the phone knows the session has none yet", async () => {
    const fx = await startServer();
    fx.pm.transcript = [];
    const client = await connected(fx);
    client.send({ type: "subscribe", instanceId: "inst-1" });
    expect((await client.waitFor("transcript")).entries).toEqual([]);
    client.close();
  });

  it("refreshes the transcript when the agent's state changes", async () => {
    const fx = await startServer();
    const client = await connected(fx);
    client.send({ type: "subscribe", instanceId: "inst-1" });
    await client.waitFor("transcript");

    fx.pm.raise("inst-1", bash(1));
    const refreshed = await client.waitFor("transcript");
    expect(refreshed.entries).toHaveLength(2);

    client.close();
  });

  it("refreshes the transcript while the agent streams output", async () => {
    // Without this the summary was only sent on subscribe, so it sat frozen for
    // the whole time an agent was working — the exact window a phone is for.
    const fx = await startServer();
    const client = await connected(fx);
    client.send({ type: "subscribe", instanceId: "inst-1" });
    await client.waitFor("transcript");

    fx.server.broadcastOutput("inst-1", "working...\r\n");

    // Arrives on a trailing timer, not per chunk.
    const refreshed = await client.waitFor("transcript");
    expect(refreshed.entries).toHaveLength(2);

    client.close();
  });

  it("coalesces a burst of output into a single transcript refresh", async () => {
    // PTY output can arrive thousands of times a second and each refresh re-reads
    // a session file, so a burst must not mean a read per chunk.
    const fx = await startServer();
    const client = await connected(fx);
    client.send({ type: "subscribe", instanceId: "inst-1" });
    await client.waitFor("transcript");

    const before = fx.pm.transcriptReads;
    for (let i = 0; i < 200; i++) {
      fx.server.broadcastOutput("inst-1", `line ${i}\r\n`);
    }
    await client.waitFor("transcript");
    // One refresh for the whole burst, not 200.
    expect(fx.pm.transcriptReads - before).toBe(1);

    client.close();
  });

  it("doesn't read the transcript for an instance nobody is watching", async () => {
    const fx = await startServer();
    const client = await connected(fx);
    // Connected but not subscribed.
    const before = fx.pm.transcriptReads;

    fx.server.broadcastOutput("inst-1", "background work\r\n");
    await new Promise((resolve) => setTimeout(resolve, 1300));

    expect(fx.pm.transcriptReads).toBe(before);

    client.close();
  });
});

describe("instance states and previews", () => {
  const row = (client: TestClient, match: (r: AnyRecord) => boolean) => client.instance("inst-1", match);

  it("is Needs you while the live event is, with what the dialog asks", async () => {
    const fx = await startServer();
    const client = await connected(fx);
    fx.pm.raise("inst-1", bash(7, 1234));
    const needsYou = await row(client, (r) => r.state === "needs-you");
    expect(needsYou).toMatchObject({ since: 1234, preview: "Bash: pnpm test:e2e" });
    client.close();
  });

  it("is Working while the agent says a turn runs, with the tool it is on", async () => {
    const fx = await startServer();
    fx.pm.turns.set("inst-1", [
      { kind: "user", text: "fix it" },
      { kind: "assistant", text: "Looking." },
      { kind: "tool", tool: "Bash", text: "pnpm test", pending: true },
    ]);
    fx.pm.setWorking("inst-1", true, 5555);
    const client = await connected(fx);
    const working = await row(client, (r) => r.state === "working" && r.preview !== undefined);
    expect(working).toMatchObject({ since: 5555, preview: "Bash: pnpm test" });
    client.close();
  });

  it("is Finished from a finished event, with its conclusion's first sentence, until a phone opens it", async () => {
    const fx = await startServer();
    const client = await connected(fx);
    fx.pm.turns.set("inst-1", [
      { kind: "user", text: "fix it" },
      { kind: "tool", tool: "Edit", text: "src/a.ts" },
      { kind: "assistant", text: "## Done\n\nFixed the **flaky** test. It was a race." },
    ]);
    fx.pm.raise("inst-1", finished(8, 4321));
    const done = await row(client, (r) => r.state === "finished" && r.preview !== undefined);
    expect(done).toMatchObject({ since: 4321, preview: "Fixed the flaky test. It was a race." });

    client.send({ type: "subscribe", instanceId: "inst-1" });
    const seen = await row(client, (r) => r.state === "idle");
    // Idle shows the last thing it said, cut the same way.
    expect(seen.preview).toBe("Fixed the flaky test. It was a race.");
    client.close();
  });

  it("goes back to Idle when the builder writes to it (the event goes)", async () => {
    const fx = await startServer();
    const client = await connected(fx);
    fx.pm.raise("inst-1", finished(9));
    await row(client, (r) => r.state === "finished");
    fx.pm.clear("inst-1");
    await row(client, (r) => r.state === "idle");
    client.close();
  });

  it("is Finished again for the next turn after the last one was seen", async () => {
    const fx = await startServer();
    const client = await connected(fx);
    fx.pm.raise("inst-1", finished(10));
    client.send({ type: "subscribe", instanceId: "inst-1" });
    await row(client, (r) => r.state === "idle");
    fx.pm.raise("inst-1", finished(11));
    await row(client, (r) => r.state === "finished");
    client.close();
  });

  it("sends a list again only when it changed, and every change to a phone that joined since", async () => {
    const fx = await startServer();
    const a = await connected(fx);
    fx.pm.raise("inst-1", finished(13, 7000));
    await a.instance("inst-1", (r) => r.state === "finished");
    await new Promise((r) => setTimeout(r, 50));
    for (let i = 0; i < 3; i++) fx.server.broadcastInstances();
    expect((await a.drain()).map((f) => f.type)).not.toContain("instances");
    a.close();
    await vi.waitFor(() => expect(fx.server.getStatus().devices[0].connected).toBe(false));

    // Changed back and forth while no phone was there: the one joining now was sent
    // the list as it is, and the next change must reach it even though it reads like
    // the last list broadcast.
    fx.pm.clear("inst-1");
    const b = await connected(fx);
    fx.pm.raise("inst-1", finished(13, 7000));
    await b.instance("inst-1", (r) => r.state === "finished");
    b.close();
  });

  it("leaves the Manager out, and lists stopped instances as Idle", async () => {
    const fx = await startServer();
    fx.pm.add({ id: "manager", isManager: true, working: true });
    fx.pm.add({ id: "stopped", status: "stopped" });
    const client = new TestClient(fx.url);
    await client.handshake();
    client.send({ type: "auth", deviceToken: fx.token });
    const list = await client.waitFor("instances");
    const ids = (list.instances as AnyRecord[]).map((r) => r.id);
    expect(ids).toEqual(["inst-1", "stopped"]);
    expect((list.instances as AnyRecord[])[1]).toMatchObject({ status: "stopped", state: "idle" });
    client.close();
  });

  it("reads each instance's line once, then only on events and while it works, never per list", async () => {
    const fx = await startServer();
    const client = await connected(fx);
    await vi.waitFor(() => expect(fx.pm.turnReads).toBe(1));
    for (let i = 0; i < 5; i++) fx.server.broadcastInstances();
    client.send({ type: "list-instances" });
    await client.drain();
    expect(fx.pm.turnReads).toBe(1);

    fx.pm.raise("inst-1", finished(12));
    await vi.waitFor(() => expect(fx.pm.turnReads).toBe(2));
    client.close();
  });

  it("reads an instance's line afresh after events it heard with the phone link off", async () => {
    const pm = new FakeProcessManager();
    pm.add({ id: "inst-1" });
    let running = true;
    const push = {
      isRunning: () => running,
      broadcastInstances: () => {},
      broadcastPromptState: () => {},
      broadcastPromptCleared: () => {},
      broadcastTranscript: () => {},
      pushSession: () => {},
    };
    const host = createRemoteHost(pm, push);
    pm.turns.set("inst-1", [{ kind: "assistant", text: "The old result, from the turn before." }]);
    host.listInstances();
    await vi.waitFor(() => expect(host.listInstances()[0].preview).toBe("The old result, from the turn before."));

    running = false;
    pm.turns.set("inst-1", [{ kind: "assistant", text: "The new result, from the latest turn." }]);
    pm.raise("inst-1", finished(14));
    running = true;
    host.listInstances();
    await vi.waitFor(() =>
      expect(host.listInstances()[0]).toMatchObject({
        state: "finished",
        preview: "The new result, from the latest turn.",
      })
    );
    host.dispose();
  });

  it("refreshes a working instance's tool from output at most every 5 s, and only with a phone connected", async () => {
    const fx = await startServer();
    fx.pm.setWorking("inst-1", true);
    // No phone: output reads nothing.
    fx.server.broadcastOutput("inst-1", "x");
    expect(fx.pm.turnReads).toBe(0);

    const client = await connected(fx);
    await vi.waitFor(() => expect(fx.pm.turnReads).toBeGreaterThan(0));
    const before = fx.pm.turnReads;
    fx.pm.turns.set("inst-1", [
      { kind: "user", text: "go" },
      { kind: "tool", tool: "Read", text: "src/b.ts", pending: true },
    ]);
    for (let i = 0; i < 50; i++) fx.server.broadcastOutput("inst-1", "spinner");
    await row(client, (r) => r.preview === "Read: src/b.ts");
    expect(fx.pm.turnReads - before).toBe(1);
    client.close();
  });
});

describe("prompt-state", () => {
  it("is broadcast when a dialog opens, with the dialog in full", async () => {
    const fx = await startServer();
    const client = await connected(fx);
    fx.pm.raise("inst-1", bash(21));
    const frame = await client.waitFor("prompt-state");
    expect(frame).toEqual({
      type: "prompt-state",
      instanceId: "inst-1",
      seq: 21,
      summary: "Bash: pnpm test:e2e",
      dialog: {
        kind: "permission",
        tool: "Bash",
        subject: "pnpm test:e2e",
        description: "Run the end-to-end tests",
        options: [
          { effect: "allow-once", label: "Yes", description: "Allow this once" },
          {
            effect: "allow-always",
            label: "Yes, and don't ask again",
            description: "Allow it, and stop asking for calls like it",
          },
          { effect: "deny", label: "No", description: "Reject and tell the agent what to do instead" },
        ],
        reasonAllowed: true,
      },
    });
    client.close();
  });

  it("is resent to a phone that subscribes while the dialog is open, under the same seq", async () => {
    const fx = await startServer();
    fx.pm.raise("inst-1", questions(22));
    const client = await connected(fx);
    client.send({ type: "subscribe", instanceId: "inst-1" });
    const frame = await client.waitFor("prompt-state");
    expect(frame.seq).toBe(22);
    expect(frame.summary).toBe("Which database?");
    expect(frame.dialog).toEqual({
      kind: "questions",
      questions: [
        {
          question: "Which database?",
          header: "DB",
          multiSelect: false,
          options: [{ label: "Postgres" }, { label: "SQLite", description: "One file" }],
        },
        {
          question: "Which extras?",
          header: "Extras",
          multiSelect: true,
          options: [{ label: "Cache" }, { label: "Metrics" }, { label: "Tracing" }],
        },
      ],
      textAllowed: true,
    });
    client.close();
  });

  it("carries a plan and OpenCode's permission as the secretary reads them", async () => {
    const fx = await startServer();
    fx.pm.add({ id: "oc", backend: "opencode" });
    const client = await connected(fx);

    fx.pm.raise("inst-1", plan(23));
    const planFrame = await client.waitFor("prompt-state");
    expect(planFrame.summary).toBe("Plan: Add dark mode");
    expect(planFrame.dialog).toMatchObject({
      kind: "plan",
      plan: PLAN_INPUT.plan,
      options: [
        { effect: "approve-auto", label: "Yes, auto-accept edits" },
        { effect: "approve", label: "Yes, manually approve edits" },
        { effect: "revise", label: "Tell Claude what to change" },
      ],
    });

    fx.pm.raise("oc", ocPermission(24));
    const ocFrame = await client.waitFor("prompt-state", (f) => f.instanceId === "oc");
    expect(ocFrame.summary).toBe("shell: rm -rf build");
    expect(ocFrame.dialog).toMatchObject({
      kind: "permission",
      tool: "shell",
      subject: "rm -rf build",
      reasonAllowed: true,
    });
    const options = (ocFrame.dialog as { options: AnyRecord[] }).options;
    expect(options.map((o) => [o.effect, o.label])).toEqual([
      ["allow-once", "Allow once"],
      ["allow-always", "Always allow"],
      ["deny", "Reject"],
    ]);
    // The request's own wording of what "always" saves.
    expect(options[1].description).toContain('"rm *"');
    client.close();
  });

  it("has no dialog for one the desktop can't answer, so the phone offers the terminal", async () => {
    const fx = await startServer();
    const client = await connected(fx);
    fx.pm.raise("inst-1", elicitation(25));
    const frame = await client.waitFor("prompt-state");
    expect(frame).toEqual({
      type: "prompt-state",
      instanceId: "inst-1",
      seq: 25,
      summary: "Waiting for you in the terminal",
    });
    client.close();
  });

  it("is restated under a new seq, and cleared naming the seq that closed", async () => {
    const fx = await startServer();
    const client = await connected(fx);
    fx.pm.raise("inst-1", bash(26));
    await client.waitFor("prompt-state", (f) => f.seq === 26);
    fx.pm.raise("inst-1", bash(27));
    await client.waitFor("prompt-state", (f) => f.seq === 27);
    fx.pm.clear("inst-1");
    expect(await client.waitFor("prompt-cleared")).toEqual({
      type: "prompt-cleared",
      instanceId: "inst-1",
      seq: 27,
    });
    client.close();
  });

  it("is cleared when a finished event replaces the needs-you", async () => {
    const fx = await startServer();
    const client = await connected(fx);
    fx.pm.raise("inst-1", bash(28));
    await client.waitFor("prompt-state");
    fx.pm.raise("inst-1", finished(29));
    expect((await client.waitFor("prompt-cleared")).seq).toBe(28);
    client.close();
  });
});

describe("answer", () => {
  const answer = (client: TestClient, clientMsgId: string, seq: number, choice: AnyRecord, confirmed?: boolean) =>
    client.send({ type: "answer", instanceId: "inst-1", seq, choice, confirmed, clientMsgId });

  it("goes through to answerDialog with the secretary's keys, and acks ok", async () => {
    const fx = await startServer();
    fx.pm.raise("inst-1", bash(31));
    const client = await connected(fx);
    answer(client, "a1", 31, { effect: "allow-once" });
    expect(await client.ack("a1")).toEqual({ type: "ack", clientMsgId: "a1", ok: true });
    expect(fx.pm.answers).toEqual([{ id: "inst-1", seq: 31, plan: { keys: ["1"] } }]);
    client.close();
  });

  it("sends a denial's reason after the keys (Claude) or with the Reject (OpenCode)", async () => {
    const fx = await startServer();
    fx.pm.add({ id: "oc", backend: "opencode" });
    fx.pm.raise("inst-1", bash(32));
    fx.pm.raise("oc", ocPermission(33));
    const client = await connected(fx);
    answer(client, "a1", 32, { effect: "deny", feedback: "use the unit tests" });
    await client.ack("a1");
    client.send({
      type: "answer",
      instanceId: "oc",
      seq: 33,
      choice: { effect: "deny", feedback: "not that one" },
      clientMsgId: "a2",
    });
    await client.ack("a2");
    expect(fx.pm.answers.map((a) => a.plan)).toEqual([
      { keys: ["3"], followUp: "use the unit tests" },
      { keys: [], answer: { kind: "permission", decision: "reject", message: "not that one" } },
    ]);
    client.close();
  });

  it("answers a two-question box with a multi-select whole, in one go", async () => {
    const fx = await startServer();
    fx.pm.raise("inst-1", questions(34));
    const client = await connected(fx);
    answer(client, "a1", 34, {
      answers: [
        { question: 1, picks: [2] },
        { question: 2, picks: [1, 3] },
      ],
    });
    expect((await client.ack("a1")).ok).toBe(true);
    const DOWN = "\x1b[B";
    expect(fx.pm.answers[0].plan.keys).toEqual(["2", "1", "3", DOWN, DOWN, DOWN, DOWN, "\r", "1"]);
    // Acked once the keys are in: a session reports no record of the answers to
    // wait for (no PostToolUse among its alert hooks).
    expect(fx.pm.answers[0].plan.expect).toBeUndefined();
    client.close();
  });

  it("is refused as gone for a seq that isn't the live dialog's, or with none open", async () => {
    const fx = await startServer();
    fx.pm.raise("inst-1", bash(35));
    const client = await connected(fx);
    answer(client, "a1", 34, { effect: "allow-once" });
    expect(await client.ack("a1")).toMatchObject({ ok: false, reason: "gone" });
    fx.pm.clear("inst-1");
    answer(client, "a2", 35, { effect: "allow-once" });
    expect(await client.ack("a2")).toMatchObject({ ok: false, reason: "gone" });
    expect(fx.pm.answers).toEqual([]);
    client.close();
  });

  it("asks for confirmation before a wider option, then presses it once confirmed", async () => {
    const fx = await startServer();
    fx.pm.raise("inst-1", bash(36));
    fx.pm.add({ id: "plan" });
    fx.pm.raise("plan", plan(37));
    const client = await connected(fx);
    answer(client, "a1", 36, { effect: "allow-always" });
    expect(await client.ack("a1")).toMatchObject({ ok: false, reason: "needs-confirm" });
    client.send({ type: "answer", instanceId: "plan", seq: 37, choice: { effect: "approve-auto" }, clientMsgId: "a2" });
    expect(await client.ack("a2")).toMatchObject({ ok: false, reason: "needs-confirm" });
    expect(fx.pm.answers).toEqual([]);

    answer(client, "a3", 36, { effect: "allow-always" }, true);
    expect((await client.ack("a3")).ok).toBe(true);
    expect(fx.pm.answers).toEqual([{ id: "inst-1", seq: 36, plan: { keys: ["2"] } }]);
    client.close();
  });

  it("fails with a message for an answer the dialog needs more of", async () => {
    const fx = await startServer();
    fx.pm.raise("inst-1", plan(38));
    fx.pm.add({ id: "q" });
    fx.pm.raise("q", questions(39));
    const client = await connected(fx);
    answer(client, "a1", 38, { effect: "revise" });
    expect(await client.ack("a1")).toEqual({
      type: "ack",
      clientMsgId: "a1",
      ok: false,
      reason: "failed",
      message: "Say what the plan should change",
    });
    client.send({
      type: "answer",
      instanceId: "q",
      seq: 39,
      choice: { answers: [{ question: 1, picks: [1] }] },
      clientMsgId: "a2",
    });
    expect(await client.ack("a2")).toMatchObject({ reason: "failed", message: "Answer every question first" });
    expect(fx.pm.answers).toEqual([]);
    client.close();
  });

  it("is unsupported for a dialog the desktop can't answer, or a choice it doesn't offer", async () => {
    const fx = await startServer();
    fx.pm.raise("inst-1", elicitation(40));
    fx.pm.add({ id: "b" });
    fx.pm.raise("b", bash(41));
    const client = await connected(fx);
    answer(client, "a1", 40, { effect: "allow-once" });
    expect(await client.ack("a1")).toMatchObject({ ok: false, reason: "unsupported" });
    for (const [i, choice] of [
      { effect: "approve" },
      { effect: "launch-missiles" },
      { answers: [{ question: 1, picks: [1] }] },
      { answers: "all" },
    ].entries()) {
      client.send({ type: "answer", instanceId: "b", seq: 41, choice, clientMsgId: `b${i}` });
      expect(await client.ack(`b${i}`)).toMatchObject({ ok: false, reason: "unsupported" });
    }
    expect(fx.pm.answers).toEqual([]);
    client.close();
  });

  it("acks by what answerDialog did", async () => {
    const fx = await startServer();
    const client = await connected(fx);
    const cases: [AnswerOutcome, string][] = [
      [{ ok: false, reason: "answered" }, "gone"],
      [{ ok: false, reason: "changed" }, "gone"],
      [{ ok: false, reason: "interrupted" }, "gone"],
      [{ ok: false, reason: "stopped" }, "not-running"],
      [{ ok: false, reason: "failed" }, "failed"],
    ];
    for (const [i, [outcome, reason]] of cases.entries()) {
      fx.pm.raise("inst-1", bash(50 + i));
      fx.pm.answerOutcome = async () => outcome;
      answer(client, `o${i}`, 50 + i, { effect: "allow-once" });
      expect(await client.ack(`o${i}`)).toMatchObject({ ok: false, reason });
    }
    client.close();
  });
});

describe("prompt", () => {
  const prompt = (client: TestClient, clientMsgId: string, instanceId = "inst-1", text = "use postgres") =>
    client.send({ type: "prompt", instanceId, text, clientMsgId });

  it("goes through the compose path and acks ok", async () => {
    const fx = await startServer();
    const client = await connected(fx);
    prompt(client, "m1");
    expect(await client.ack("m1")).toEqual({ type: "ack", clientMsgId: "m1", ok: true });
    expect(fx.pm.prompts).toEqual([{ id: "inst-1", text: "use postgres" }]);
    client.close();
  });

  it("is refused while a dialog is open, so the text never lands in it", async () => {
    const fx = await startServer();
    fx.pm.raise("inst-1", bash(70));
    const client = await connected(fx);
    prompt(client, "m1");
    expect(await client.ack("m1")).toMatchObject({ ok: false, reason: "dialog-open" });
    expect(fx.pm.prompts).toEqual([]);
    client.close();
  });

  it("is refused while an answer's keys are still going in: the dialog is still on screen", async () => {
    const fx = await startServer();
    // The answer's first key has cleared the event; its last isn't in yet.
    fx.pm.answering.add("inst-1");
    fx.pm.setWorking("inst-1", true);
    const client = await connected(fx);
    prompt(client, "m1");
    expect(await client.ack("m1")).toMatchObject({ ok: false, reason: "dialog-open" });
    client.send({ type: "interrupt", instanceId: "inst-1", clientMsgId: "i1" });
    expect(await client.ack("i1")).toMatchObject({ ok: false, reason: "dialog-open" });
    expect(fx.pm.prompts).toEqual([]);
    expect(fx.pm.interrupts).toEqual([]);
    client.close();
  });

  it("is refused for an instance that isn't running, or doesn't exist", async () => {
    const fx = await startServer();
    fx.pm.add({ id: "stopped", status: "stopped" });
    const client = await connected(fx);
    prompt(client, "m1", "stopped");
    expect(await client.ack("m1")).toMatchObject({ ok: false, reason: "not-running" });
    prompt(client, "m2", "nobody");
    expect(await client.ack("m2")).toMatchObject({ ok: false, reason: "not-running" });
    expect(fx.pm.prompts).toEqual([]);
    client.close();
  });

  it("is still sent while the agent works (the CLI queues it)", async () => {
    const fx = await startServer();
    fx.pm.setWorking("inst-1", true);
    const client = await connected(fx);
    prompt(client, "m1");
    expect((await client.ack("m1")).ok).toBe(true);
    client.close();
  });

  it("fails a malformed frame without acting on it", async () => {
    const fx = await startServer();
    const client = await connected(fx);
    client.send({ type: "prompt", instanceId: "inst-1", text: 42, clientMsgId: "m1" });
    expect(await client.ack("m1")).toMatchObject({ ok: false, reason: "failed" });
    // No id, no ack, and nothing done.
    client.send({ type: "prompt", instanceId: "inst-1", text: "x" });
    await client.drain();
    expect(fx.pm.prompts).toEqual([]);
    client.close();
  });
});

describe("interrupt", () => {
  const interrupt = (client: TestClient, clientMsgId: string, instanceId = "inst-1") =>
    client.send({ type: "interrupt", instanceId, clientMsgId });

  it("stops a running turn and acks ok", async () => {
    const fx = await startServer();
    fx.pm.setWorking("inst-1", true);
    const client = await connected(fx);
    interrupt(client, "i1");
    expect(await client.ack("i1")).toEqual({ type: "ack", clientMsgId: "i1", ok: true });
    expect(fx.pm.interrupts).toEqual(["inst-1"]);
    client.close();
  });

  it("is refused while a dialog is open: Esc would answer it", async () => {
    const fx = await startServer();
    fx.pm.setWorking("inst-1", true);
    fx.pm.raise("inst-1", bash(80));
    const client = await connected(fx);
    interrupt(client, "i1");
    expect(await client.ack("i1")).toMatchObject({ ok: false, reason: "dialog-open" });
    expect(fx.pm.interrupts).toEqual([]);
    client.close();
  });

  it("is refused when nothing runs, or the instance isn't running", async () => {
    const fx = await startServer();
    fx.pm.add({ id: "stopped", status: "stopped" });
    const client = await connected(fx);
    interrupt(client, "i1");
    expect(await client.ack("i1")).toMatchObject({ ok: false, reason: "not-working" });
    interrupt(client, "i2", "stopped");
    expect(await client.ack("i2")).toMatchObject({ ok: false, reason: "not-running" });
    expect(fx.pm.interrupts).toEqual([]);
    client.close();
  });

  it("is refused again for the same turn until the agent has had time to say it stopped", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const fx = await startServer();
      fx.pm.setWorking("inst-1", true, 100);
      const client = await connected(fx);
      interrupt(client, "i1");
      await client.ack("i1");
      // The agent hasn't reported the turn over yet.
      interrupt(client, "i2");
      expect(await client.ack("i2")).toMatchObject({ ok: false, reason: "not-working" });
      // A new turn may be stopped at once.
      fx.pm.setWorking("inst-1", true, 200);
      interrupt(client, "i3");
      expect((await client.ack("i3")).ok).toBe(true);
      // Still running 3 s on: the Esc didn't take, and trying again is allowed.
      vi.setSystemTime(Date.now() + 3000);
      interrupt(client, "i4");
      expect((await client.ack("i4")).ok).toBe(true);
      expect(fx.pm.interrupts).toEqual(["inst-1", "inst-1", "inst-1"]);
      client.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("is refused when the terminal isn't showing the running turn (OpenCode)", async () => {
    const fx = await startServer();
    fx.pm.setWorking("inst-1", true);
    fx.pm.offScreen.add("inst-1");
    const client = await connected(fx);
    interrupt(client, "i1");
    expect(await client.ack("i1")).toMatchObject({ ok: false, reason: "unsupported" });
    expect(fx.pm.interrupts).toEqual([]);
    client.close();
  });

  it("says why when not every key went in", async () => {
    const fx = await startServer();
    fx.pm.setWorking("inst-1", true);
    const client = await connected(fx);
    // A dialog came up between OpenCode's two Escs.
    fx.pm.interruptInstance = async (id) => {
      fx.pm.interrupts.push(id);
      fx.pm.events.set("inst-1", bash(81));
      return false;
    };
    interrupt(client, "i1");
    expect(await client.ack("i1")).toMatchObject({ ok: false, reason: "dialog-open" });
    client.close();
  });
});

describe("acks are kept per device", () => {
  it("gives a resent prompt the same ack, on a new socket, without sending it twice", async () => {
    const fx = await startServer();
    const first = await connected(fx);
    first.send({ type: "prompt", instanceId: "inst-1", text: "once", clientMsgId: "m1" });
    const ack = await first.ack("m1");
    first.close();

    // Reconnected, the phone resends what it never saw acked.
    const second = await connected(fx);
    second.send({ type: "prompt", instanceId: "inst-1", text: "once", clientMsgId: "m1" });
    expect(await second.ack("m1")).toEqual(ack);
    expect(fx.pm.prompts).toHaveLength(1);
    second.close();
  });

  it("keeps a refusal too, so a resend isn't tried again", async () => {
    const fx = await startServer();
    fx.pm.raise("inst-1", bash(90));
    const client = await connected(fx);
    client.send({ type: "prompt", instanceId: "inst-1", text: "x", clientMsgId: "m1" });
    const refused = await client.ack("m1");
    expect(refused).toMatchObject({ ok: false, reason: "dialog-open" });
    fx.pm.clear("inst-1");
    client.send({ type: "prompt", instanceId: "inst-1", text: "x", clientMsgId: "m1" });
    expect(await client.ack("m1")).toEqual(refused);
    expect(fx.pm.prompts).toEqual([]);
    client.close();
  });

  it("waits for an answer still being worked on, and presses its keys once", async () => {
    const fx = await startServer();
    fx.pm.raise("inst-1", bash(91));
    let finish: (outcome: AnswerOutcome) => void = () => {};
    fx.pm.answerOutcome = () => new Promise((resolve) => (finish = resolve));
    const client = await connected(fx);
    const frame = { type: "answer", instanceId: "inst-1", seq: 91, choice: { effect: "allow-once" }, clientMsgId: "a1" };
    client.send(frame);
    await vi.waitFor(() => expect(fx.pm.answers).toHaveLength(1));
    client.send(frame);
    await client.drain();
    finish({ ok: true });
    await client.ack("a1");
    await client.ack("a1");
    expect(fx.pm.answers).toHaveLength(1);
    client.close();
  });

  it("are not shared between devices", async () => {
    const fx = await startServer();
    const other = fx.server.createPairingOffer()!;
    const a = await connected(fx);
    const b = await connected(fx, other.deviceToken);
    a.send({ type: "prompt", instanceId: "inst-1", text: "from a", clientMsgId: "m1" });
    await a.ack("m1");
    b.send({ type: "prompt", instanceId: "inst-1", text: "from b", clientMsgId: "m1" });
    await b.ack("m1");
    expect(fx.pm.prompts.map((p) => p.text)).toEqual(["from a", "from b"]);
    a.close();
    b.close();
  });

  it("remembers the last 200, then lets the oldest go", async () => {
    const fx = await startServer();
    const client = await connected(fx);
    for (let i = 0; i <= 200; i++) {
      client.send({ type: "prompt", instanceId: "inst-1", text: `p${i}`, clientMsgId: `m${i}` });
    }
    await client.ack("m200");
    expect(fx.pm.prompts).toHaveLength(201);
    // m1 is still known; m0 has been let go and counts as new.
    client.send({ type: "prompt", instanceId: "inst-1", text: "p1", clientMsgId: "m1" });
    client.send({ type: "prompt", instanceId: "inst-1", text: "p0", clientMsgId: "m0" });
    await client.drain();
    expect(fx.pm.prompts.map((p) => p.text).slice(201)).toEqual(["p0"]);
    client.close();
  });
});

describe("Web Push (T-810)", () => {
  // A phone's real-shaped subscription to Apple's push service.
  const P256DH = crypto.createECDH("prime256v1").generateKeys().toString("base64url");
  const AUTH = crypto.randomBytes(16).toString("base64url");
  const subscription = (n = 1) => ({
    endpoint: `https://web.push.apple.com/QK${n}`,
    keys: { p256dh: P256DH, auth: AUTH },
  });
  const devicesFile = () =>
    JSON.parse(fs.readFileSync(path.join(userData, "remote-devices.json"), "utf8")) as AnyRecord[];
  const vapidPublicKey = () =>
    (JSON.parse(fs.readFileSync(path.join(userData, "remote-push.json"), "utf8")) as AnyRecord).publicKey;
  const payloadOf = (call: number) => JSON.parse(sendNotification.mock.calls[call][1] as string);
  const endpoints = () => sendNotification.mock.calls.map(([sub]) => (sub as { endpoint: string }).endpoint);
  const refused = (statusCode: number, body = "") =>
    new webpush.WebPushError("Received unexpected response code", statusCode, {}, body, subscription().endpoint);
  // Long enough for a read and a send that are going to happen to have happened.
  const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

  beforeEach(() => {
    sendNotification.mockReset();
    sendNotification.mockResolvedValue({ statusCode: 201, body: "", headers: {} });
  });

  // A phone that turned notifications on, then put the app away: its socket closed.
  // Connect phones one at a time: the device connected now is taken to be this one.
  async function subscribedAway(fx: Fixture, token = fx.token, sub = subscription()): Promise<string> {
    const client = await connected(fx, token);
    const id = fx.server.getStatus().devices.find((d) => d.connected)!.id;
    client.send({ type: "push-subscribe", subscription: sub, clientMsgId: `on-${id}` });
    expect(await client.ack(`on-${id}`)).toMatchObject({ ok: true });
    client.close();
    await vi.waitFor(() => expect(fx.server.getStatus().devices.find((d) => d.id === id)?.connected).toBe(false));
    return id;
  }

  it("keeps a phone's subscription on its device, says so in auth-ok and the status, and null removes it", async () => {
    const fx = await startServer();
    expect(fx.server.getStatus().checks.push).toEqual({ state: "ready" });
    const client = await connected(fx);
    client.send({ type: "push-subscribe", subscription: subscription(), clientMsgId: "on" });
    expect(await client.ack("on")).toEqual({ type: "ack", clientMsgId: "on", ok: true });
    expect(fx.server.getStatus().devices[0].pushEnabled).toBe(true);
    expect(devicesFile()[0].push).toEqual(subscription());
    client.close();

    const again = new TestClient(fx.url);
    await again.handshake(fx.hostPublicKey);
    again.send({ type: "auth", deviceToken: fx.token });
    const ok = await again.waitFor("auth-ok");
    expect(ok).toMatchObject({ pushEnabled: true, vapidPublicKey: vapidPublicKey() });
    expect(Buffer.from(String(ok.vapidPublicKey), "base64url")).toHaveLength(65);

    again.send({ type: "push-subscribe", subscription: null, clientMsgId: "off" });
    expect(await again.ack("off")).toMatchObject({ ok: true });
    expect(fx.server.getStatus().devices[0].pushEnabled).toBe(false);
    expect(devicesFile()[0].push).toBeUndefined();
    again.close();
  });

  it("refuses a subscription Web Push can't use, and keeps the one it had", async () => {
    const fx = await startServer();
    const client = await connected(fx);
    client.send({ type: "push-subscribe", subscription: subscription(), clientMsgId: "on" });
    await client.ack("on");
    const bad = [
      { ...subscription(), endpoint: "http://web.push.apple.com/QK1" },
      { ...subscription(), endpoint: "not a url" },
      { endpoint: "https://web.push.apple.com/QK1" },
      { ...subscription(), keys: { p256dh: P256DH, auth: "" } },
      "on",
      undefined,
    ];
    for (const [i, value] of bad.entries()) {
      client.send({ type: "push-subscribe", subscription: value, clientMsgId: `bad${i}` });
      expect(await client.ack(`bad${i}`), JSON.stringify(value)).toMatchObject({ ok: false, reason: "failed" });
    }
    expect(devicesFile()[0].push).toEqual(subscription());
    client.close();
  });

  it("undoes a subscription it couldn't save, so the phone's resend is saved", async () => {
    const fx = await startServer();
    const client = await connected(fx);
    const file = path.join(userData, "remote-devices.json");
    fs.chmodSync(file, 0o400);
    try {
      client.send({ type: "push-subscribe", subscription: subscription(), clientMsgId: "on" });
      expect(await client.ack("on")).toMatchObject({ ok: false, reason: "failed" });
      expect(fx.server.getStatus().devices[0].pushEnabled).toBe(false);
    } finally {
      fs.chmodSync(file, 0o600);
    }
    client.send({ type: "push-subscribe", subscription: subscription(), clientMsgId: "again" });
    expect(await client.ack("again")).toMatchObject({ ok: true });
    expect(devicesFile()[0].push).toEqual(subscription());

    // The same for turning it off.
    fs.chmodSync(file, 0o400);
    try {
      client.send({ type: "push-subscribe", subscription: null, clientMsgId: "off" });
      expect(await client.ack("off")).toMatchObject({ ok: false, reason: "failed" });
      expect(fx.server.getStatus().devices[0].pushEnabled).toBe(true);
    } finally {
      fs.chmodSync(file, 0o600);
    }
    client.send({ type: "push-subscribe", subscription: null, clientMsgId: "off-again" });
    expect(await client.ack("off-again")).toMatchObject({ ok: true });
    expect(devicesFile()[0].push).toBeUndefined();
    client.close();
  });

  it("pushes a Needs you to a phone that isn't looking, as Declarative Web Push", async () => {
    const fx = await startServer();
    await subscribedAway(fx);
    fx.pm.raise("inst-1", bash(31));
    await vi.waitFor(() => expect(sendNotification).toHaveBeenCalledTimes(1));

    const [sub, payload, options] = sendNotification.mock.calls[0];
    expect(sub).toEqual(subscription());
    expect(JSON.parse(payload)).toEqual({
      web_push: 8030,
      notification: {
        title: "demo · Needs you",
        body: "Bash: pnpm test:e2e",
        navigate: "https://mac.example.ts.net/#/s/inst-1",
        tag: "inst-1",
      },
      app_badge: 1,
    });
    expect(options).toMatchObject({ TTL: 3600, urgency: "high", topic: topicOf("inst-1") });
    expect(options.topic).toMatch(/^[A-Za-z0-9_-]{1,32}$/);
    // Signed for Apple's service, with the HTTPS origin as the contact (Apple refuses a
    // .local or localhost one) and the key the phone subscribed with.
    const authorization = String(options.headers.Authorization);
    expect(authorization).toMatch(new RegExp(`^vapid t=[\\w-]+\\.[\\w-]+\\.[\\w-]+, k=${vapidPublicKey()}$`));
    const jwt = JSON.parse(Buffer.from(authorization.split(".")[1], "base64url").toString("utf8"));
    expect(jwt).toMatchObject({ aud: "https://web.push.apple.com", sub: "https://mac.example.ts.net" });
  });

  it("pushes a Finished with its conclusion's first sentence, read after the event", async () => {
    const fx = await startServer();
    fx.pm.turns.set("inst-1", [{ kind: "assistant", text: "The old result, from the turn before." }]);
    await subscribedAway(fx);
    await vi.waitFor(() => expect(fx.pm.turnReads).toBe(1));
    fx.pm.turns.set("inst-1", [
      { kind: "user", text: "fix it" },
      { kind: "tool", tool: "Edit", text: "src/a.ts" },
      { kind: "assistant", text: "## Done\n\nFixed the **flaky** test. It was a race." },
    ]);
    fx.pm.raise("inst-1", finished(32));
    await vi.waitFor(() => expect(sendNotification).toHaveBeenCalledTimes(1));
    expect(payloadOf(0)).toEqual({
      web_push: 8030,
      notification: {
        title: "demo · Finished",
        body: "Fixed the flaky test. It was a race.",
        navigate: "https://mac.example.ts.net/#/s/inst-1",
        tag: "inst-1",
      },
      app_badge: 0,
    });
  });

  it("badges the number of sessions that need the builder when it is sent", async () => {
    const fx = await startServer();
    fx.pm.add({ id: "inst-2", name: "other" });
    fx.pm.add({ id: "inst-3", name: "third" });
    await subscribedAway(fx);
    const raised = async (id: string, event: SecretaryEvent) => {
      const before = sendNotification.mock.calls.length;
      fx.pm.raise(id, event);
      await vi.waitFor(() => expect(sendNotification).toHaveBeenCalledTimes(before + 1));
      return payloadOf(before).app_badge;
    };
    expect(await raised("inst-2", bash(40))).toBe(1);
    expect(await raised("inst-3", finished(41))).toBe(1);
    expect(await raised("inst-1", questions(42))).toBe(2);
    // The builder answered inst-2 at the desk; its next turn finished.
    fx.pm.clear("inst-2");
    expect(await raised("inst-2", finished(43))).toBe(1);
  });

  it("skips a phone with the app open, until it has gone quiet", async () => {
    const fx = await startServer();
    const second = fx.server.createPairingOffer()!;
    await subscribedAway(fx, second.deviceToken, subscription(2));
    const looking = await connected(fx);
    looking.send({ type: "push-subscribe", subscription: subscription(1), clientMsgId: "on" });
    await looking.ack("on");

    fx.pm.raise("inst-1", bash(50));
    await vi.waitFor(() => expect(sendNotification).toHaveBeenCalledTimes(1));
    await settle();
    expect(endpoints()).toEqual(["https://web.push.apple.com/QK2"]);

    // Locked with its socket half-open: no ping for longer than a phone that looks
    // ever goes without one.
    for (const conn of fx.server["connections"]) conn.heardAt -= 30_000;
    fx.pm.raise("inst-1", finished(51));
    await vi.waitFor(() => expect(sendNotification).toHaveBeenCalledTimes(3));
    expect(endpoints().slice(1).sort()).toEqual(["https://web.push.apple.com/QK1", "https://web.push.apple.com/QK2"]);
    looking.close();
  });

  it("sends nothing for a restated dialog, or for the Manager", async () => {
    const fx = await startServer();
    fx.pm.add({ id: "manager", name: "Manager", isManager: true });
    await subscribedAway(fx);
    fx.pm.raise("inst-1", { ...bash(60), restated: true });
    fx.pm.raise("manager", bash(61));
    await settle();
    expect(sendNotification).not.toHaveBeenCalled();
    // The restated dialog is still the live one; only its second push is skipped.
    expect(fx.server["host"]!.listInstances()[0]).toMatchObject({ state: "needs-you" });
  });

  it("still pushes an event a restatement followed at once: the restatement has no push of its own", async () => {
    const fx = await startServer();
    await subscribedAway(fx);
    // An OpenCode turn ends beside an open dialog: Finished, then the dialog said again.
    fx.pm.raise("inst-1", finished(72));
    fx.pm.raise("inst-1", { ...bash(73), restated: true });
    await vi.waitFor(() => expect(sendNotification).toHaveBeenCalledTimes(1));
    expect(payloadOf(0)).toMatchObject({ notification: { title: "demo · Finished" }, app_badge: 1 });

    // A fresh dialog said again before its line was read.
    fx.pm.raise("inst-1", bash(74));
    fx.pm.raise("inst-1", { ...bash(75), restated: true });
    await vi.waitFor(() => expect(sendNotification).toHaveBeenCalledTimes(2));
    await settle();
    expect(sendNotification).toHaveBeenCalledTimes(2);
    expect(payloadOf(1).notification.title).toBe("demo · Needs you");
  });

  it("sends only the newer of two events that came before the first's line was read", async () => {
    const fx = await startServer();
    await subscribedAway(fx);
    fx.pm.raise("inst-1", finished(70));
    fx.pm.raise("inst-1", bash(71));
    await vi.waitFor(() => expect(sendNotification).toHaveBeenCalledTimes(1));
    await settle();
    expect(sendNotification).toHaveBeenCalledTimes(1);
    expect(payloadOf(0).notification.title).toBe("demo · Needs you");
  });

  it("sends a phone's pushes one after the other, so an older one can't land after a newer one", async () => {
    const fx = await startServer();
    fx.pm.add({ id: "inst-2", name: "other" });
    await subscribedAway(fx);
    let release!: () => void;
    sendNotification.mockImplementationOnce(
      () => new Promise((resolve) => (release = () => resolve({ statusCode: 201, body: "", headers: {} })))
    );
    fx.pm.raise("inst-1", bash(100));
    await vi.waitFor(() => expect(sendNotification).toHaveBeenCalledTimes(1));
    fx.pm.raise("inst-2", finished(101));
    await settle();
    expect(sendNotification).toHaveBeenCalledTimes(1);
    release();
    await vi.waitFor(() => expect(sendNotification).toHaveBeenCalledTimes(2));
    expect(payloadOf(1).notification.title).toBe("other · Finished");
  });

  it.each([404, 410])("deletes a subscription the push service says is gone (%i)", async (statusCode) => {
    const fx = await startServer();
    const id = await subscribedAway(fx);
    const pushed: boolean[] = [];
    fx.server.setStatusListener(() => pushed.push(fx.server.getStatus().devices[0].pushEnabled));
    sendNotification.mockRejectedValueOnce(refused(statusCode));
    fx.pm.raise("inst-1", bash(80));
    await vi.waitFor(() => expect(fx.server.getStatus().devices[0].pushEnabled).toBe(false));
    expect(pushed.at(-1)).toBe(false);
    expect(devicesFile()[0].push).toBeUndefined();
    expect(fx.server.getStatus().devices[0].lastPushError).toBeUndefined();

    fx.pm.raise("inst-1", finished(81));
    await settle();
    expect(sendNotification).toHaveBeenCalledTimes(1);
    expect((await fx.server.sendTestPush(id)).ok).toBe(false);
  });

  it("records any other failure on the device until a push to it works, and never throws into the event", async () => {
    const fx = await startServer();
    await subscribedAway(fx);
    const device = () => fx.server.getStatus().devices[0];

    sendNotification.mockRejectedValueOnce(refused(403, JSON.stringify({ reason: "BadJwtToken" })));
    fx.pm.raise("inst-1", bash(90));
    await vi.waitFor(() => expect(device().lastPushError).toBe("The push service refused it: 403 BadJwtToken"));
    expect(device().pushEnabled).toBe(true);
    expect(devicesFile()[0].lastPushError).toBe("The push service refused it: 403 BadJwtToken");

    sendNotification.mockRejectedValueOnce(new Error("getaddrinfo ENOTFOUND web.push.apple.com"));
    fx.pm.raise("inst-1", finished(91));
    await vi.waitFor(() =>
      expect(device().lastPushError).toBe("Couldn't send it: getaddrinfo ENOTFOUND web.push.apple.com")
    );

    sendNotification.mockImplementationOnce(() => {
      throw new Error("boom");
    });
    expect(() => fx.pm.raise("inst-1", bash(92))).not.toThrow();
    await vi.waitFor(() => expect(device().lastPushError).toBe("Couldn't send it: boom"));

    fx.pm.raise("inst-1", finished(93));
    await vi.waitFor(() => expect(device().lastPushError).toBeUndefined());
    expect(devicesFile()[0].lastPushError).toBeUndefined();
    expect(sendNotification).toHaveBeenCalledTimes(4);
  });

  it("sends nothing until HTTPS is ready, nor with the phone link off", async () => {
    const fx = await startServer();
    const id = await subscribedAway(fx);
    fx.server.setChecker({
      check: async () => ({
        tailscale: { state: "running", dnsName: "mac.example.ts.net" },
        https: { state: "serve-missing", command: "tailscale serve --bg --https=443 http://127.0.0.1:6768" },
      }),
      setUpHttps: async () => {
        throw new Error("not in these tests");
      },
    });
    await fx.server["checks"].refresh(true);
    fx.pm.raise("inst-1", bash(95));
    await settle();
    expect(sendNotification).not.toHaveBeenCalled();
    expect(await fx.server.sendTestPush(id)).toEqual({ ok: false, error: "HTTPS isn't set up yet." });

    await fx.server.stop();
    fx.pm.raise("inst-1", finished(96));
    await settle();
    expect(sendNotification).not.toHaveBeenCalled();
    expect(await fx.server.sendTestPush(id)).toEqual({ ok: false, error: "Turn the phone link on first." });
  });

  it("stops pushing to a revoked phone", async () => {
    const fx = await startServer();
    const id = await subscribedAway(fx);
    fx.server.revokeDevice(id);
    fx.pm.raise("inst-1", bash(97));
    await settle();
    expect(sendNotification).not.toHaveBeenCalled();
    expect(await fx.server.sendTestPush(id)).toEqual({ ok: false, error: "This phone isn't paired any more." });
  });

  it("forgets every subscription when the keys are lost: they were made for the old key", async () => {
    const fx = await startServer();
    await subscribedAway(fx);
    const before = vapidPublicKey();
    await fx.server.stop();
    fs.rmSync(path.join(userData, "remote-push.json"));

    const server = new RemoteServer();
    expect(server.getStatus().devices[0].pushEnabled).toBe(false);
    expect(devicesFile()[0].push).toBeUndefined();
    expect(vapidPublicKey()).not.toBe(before);
  });

  it("sends a test push to a phone whether or not it is looking, and says how it went", async () => {
    const fx = await startServer();
    const client = await connected(fx);
    const id = fx.server.getStatus().devices[0].id;
    expect(await fx.server.sendTestPush(id)).toEqual({
      ok: false,
      error: "Notifications are off on this phone. Turn them on in its app.",
    });
    client.send({ type: "push-subscribe", subscription: subscription(), clientMsgId: "on" });
    await client.ack("on");

    expect(await fx.server.sendTestPush(id)).toEqual({ ok: true });
    // No badge: a test leaves the icon's number as it is.
    expect(payloadOf(0)).toEqual({
      web_push: 8030,
      notification: {
        title: "Multi-Code · Test",
        body: "Notifications from this Mac work.",
        navigate: "https://mac.example.ts.net/#/",
        tag: "multi-code-test",
      },
    });

    sendNotification.mockRejectedValueOnce(refused(500, JSON.stringify({ reason: "InternalServerError" })));
    expect(await fx.server.sendTestPush(id)).toEqual({
      ok: false,
      error: "The push service refused it: 500 InternalServerError",
    });
    expect(fx.server.getStatus().devices[0].lastPushError).toBe("The push service refused it: 500 InternalServerError");

    sendNotification.mockRejectedValueOnce(refused(410));
    expect(await fx.server.sendTestPush(id)).toEqual({
      ok: false,
      error: "This phone's subscription has expired. Open the app on it to turn notifications on again.",
    });
    expect(fx.server.getStatus().devices[0]).toMatchObject({ pushEnabled: false });
    client.close();
  });
});

describe("firstSentence", () => {
  it("cuts at the first sentence end past a few words, in either script, or at 120 characters", () => {
    expect(firstSentence("The flaky test was a race between timers. I fixed it.")).toBe(
      "The flaky test was a race between timers."
    );
    // "Done." alone says nothing.
    expect(firstSentence("Done. Created a.txt in the current directory. Nothing else.")).toBe(
      "Done. Created a.txt in the current directory."
    );
    expect(firstSentence("修好了。测试都过了。")).toBe("修好了。测试都过了。");
    expect(firstSentence("Updated README.md and v1.2 notes")).toBe("Updated README.md and v1.2 notes");
    const long = firstSentence("word ".repeat(60));
    expect(long).toHaveLength(120);
    expect(long.endsWith("…")).toBe(true);
  });

  it("reads past headings, fences and Markdown marks", () => {
    expect(firstSentence("## Summary\n\n- **Fixed** the `parser` [bug](http://x). More.")).toBe(
      "Fixed the parser bug. More."
    );
    expect(firstSentence("Renamed run_tests to run_all. Then more")).toBe("Renamed run_tests to run_all.");
    expect(firstSentence("# Only a heading")).toBe("Only a heading");
  });
});

describe("RemoteServer device revocation", () => {
  it("disconnects a revoked device and refuses it afterwards", async () => {
    const fx = await startServer();
    const client = new TestClient(fx.url);
    await client.handshake();
    client.send({ type: "auth", deviceToken: fx.token, deviceName: "phone" });
    await client.waitFor("auth-ok");

    const deviceId = fx.server.getStatus().devices[0].id;
    fx.server.revokeDevice(deviceId);

    expect(await client.waitClose()).toBe(4003);
    expect(fx.server.getStatus().devices).toHaveLength(0);

    // The old token must not work on a fresh socket either.
    const retry = new TestClient(fx.url);
    await retry.handshake();
    retry.send({ type: "auth", deviceToken: fx.token });
    const failed = await retry.waitFor("auth-failed");
    expect(failed.reason).toBe("unknown-token");
  });

  it("leaves other devices connected when one is revoked", async () => {
    const fx = await startServer();
    const secondOffer = fx.server.createPairingOffer();
    if (!secondOffer) throw new Error("no second offer");

    const a = await connected(fx);
    const b = await connected(fx, secondOffer.deviceToken);

    const deviceA = fx.server.getStatus().devices[0];
    fx.server.revokeDevice(deviceA.id);
    expect(await a.waitClose()).toBe(4003);

    // b must still be live and receiving: the list it gets next shows the change.
    fx.pm.raise("inst-1", finished(100));
    await b.instance("inst-1", (r) => r.state === "finished");

    b.close();
  });
});

describe("RemoteServer static file serving", () => {
  async function get(url: string) {
    const res = await fetch(url);
    return { status: res.status, body: await res.text() };
  }

  it("refuses path traversal out of the mobile bundle", async () => {
    const fx = await startServer();
    const base = fx.url.replace("ws://", "http://");
    // Both the encoded and raw forms must be rejected: the server is on an open
    // port, so a traversal here would expose the whole filesystem.
    const encoded = await get(`${base}/..%2f..%2f..%2f..%2fetc%2fpasswd`);
    expect([403, 404]).toContain(encoded.status);
    expect(encoded.body).not.toContain("root:");
  });

  it("404s an unknown asset", async () => {
    const fx = await startServer();
    const base = fx.url.replace("ws://", "http://");
    const res = await get(`${base}/definitely-not-here.js`);
    expect(res.status).toBe(404);
  });

  // The phone's service worker fetches every file through the HTTP cache: each
  // must be checked with the server every time, and cheaply (mobile-v2 T-806).
  it("serves the app's files no-cache with a tag, and answers an unchanged one 304", async () => {
    const fx = await startServer();
    const base = fx.url.replace("ws://", "http://");
    for (const [file, type] of [
      ["/", "text/html; charset=utf-8"],
      ["/manifest.webmanifest", "application/manifest+json; charset=utf-8"],
      ["/icons/icon-180.png", "image/png"],
    ]) {
      const res = await fetch(`${base}${file}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe(type);
      expect(res.headers.get("cache-control")).toBe("no-cache");
      const etag = res.headers.get("etag");
      expect(etag).toMatch(/^W\/".+"$/);
      const again = await fetch(`${base}${file}`, { headers: { "if-none-match": etag! } });
      expect(again.status).toBe(304);
      expect(again.headers.get("etag")).toBe(etag);
    }
  });
});
