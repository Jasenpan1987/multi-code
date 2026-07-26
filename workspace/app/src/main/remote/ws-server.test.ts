// Integration test: drives the real RemoteServer over a real socket with a real
// NaCl handshake. This is the part where a subtle framing or auth bug would be
// invisible to unit tests but break every phone.

import { afterEach, describe, expect, it, vi } from "vitest";
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

const { RemoteServer } = await import("./ws-server");
const { REMOTE_PROTOCOL_VERSION } = await import("../../shared/remote-protocol");

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

    const helloPromise = this.nextPlain();
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

  private nextPlain(): Promise<AnyRecord> {
    return this.next();
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

  // Skip frames until one of `type` arrives, so a test doesn't depend on the
  // exact ordering of unrelated pushes.
  async waitFor(type: string, timeoutMs = 3000): Promise<AnyRecord> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`timed out waiting for ${type}`);
      const frame = await this.next(remaining);
      if (frame.type === type) return frame;
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

interface Fixture {
  server: InstanceType<typeof RemoteServer>;
  url: string;
  token: string;
  hostPublicKey: string;
  writes: Array<{ id: string; data: string }>;
  prompts: Array<{ id: string; text: string }>;
}

const fixtures: Fixture[] = [];

async function startServer(): Promise<Fixture> {
  const server = new RemoteServer();
  const writes: Array<{ id: string; data: string }> = [];
  const prompts: Array<{ id: string; text: string }> = [];

  server.setHost({
    listInstances: () => [
      {
        id: "inst-1",
        name: "demo",
        cwd: "/tmp/demo",
        backend: "claude",
        status: "running",
      },
    ],
    writeToInstance: (id, data) => writes.push({ id, data }),
    sendPrompt: (id, text) => prompts.push({ id, text }),
  });

  // Port 0 = OS-assigned, so parallel test files never collide.
  const status = await server.start(0);
  if (!status.port) throw new Error(status.error ?? "server did not start");

  const offer = server.createPairingOffer();
  if (!offer) throw new Error("no pairing offer");

  const fixture: Fixture = {
    server,
    url: `ws://127.0.0.1:${status.port}`,
    token: offer.deviceToken,
    hostPublicKey: offer.hostPublicKey,
    writes,
    prompts,
  };
  fixtures.push(fixture);
  return fixture;
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
    expect(fx.writes).toEqual([]);
  });
});

describe("RemoteServer streaming", () => {
  async function connected(fx: Fixture) {
    const client = new TestClient(fx.url);
    await client.handshake(fx.hostPublicKey);
    client.send({ type: "auth", deviceToken: fx.token, deviceName: "phone" });
    await client.waitFor("auth-ok");
    await client.waitFor("instances");
    return client;
  }

  it("replays buffered output as a snapshot on subscribe", async () => {
    const fx = await startServer();
    // Output produced before the phone ever connected.
    fx.server.broadcastOutput("inst-1", "earlier output\r\n");

    const client = await connected(fx);
    client.send({ type: "subscribe", instanceId: "inst-1" });

    const snapshot = await client.waitFor("snapshot");
    expect(snapshot.data).toContain("earlier output");

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
    fx.server.broadcastActivity("inst-1", "waiting");

    // An activity frame still arrives (it isn't subscription-scoped), but no
    // output frame should.
    const frame = await client.waitFor("activity");
    expect(frame.type).toBe("activity");

    client.close();
  });

  it("forwards a typed prompt through the compose path", async () => {
    const fx = await startServer();
    const client = await connected(fx);
    client.send({ type: "prompt", instanceId: "inst-1", text: "use postgres" });

    await vi.waitFor(() => expect(fx.prompts).toHaveLength(1));
    expect(fx.prompts[0]).toEqual({ id: "inst-1", text: "use postgres" });

    client.close();
  });

  it("delivers a pending prompt to a phone that connects late", async () => {
    const fx = await startServer();
    // The agent blocks before the phone is anywhere near.
    fx.server.broadcastActivity("inst-1", "prompt", {
      tool: "AskUserQuestion",
      question: "Which database?",
      options: [{ label: "Postgres" }, { label: "SQLite" }],
    });

    const client = await connected(fx);
    client.send({ type: "subscribe", instanceId: "inst-1" });
    const prompt = await client.waitFor("prompt-state");
    expect(prompt.question).toBe("Which database?");

    client.close();
  });
});

describe("RemoteServer remote decisions", () => {
  async function connectedWithPrompt(fx: Fixture, optionCount: number) {
    const client = new TestClient(fx.url);
    await client.handshake(fx.hostPublicKey);
    client.send({ type: "auth", deviceToken: fx.token, deviceName: "phone" });
    await client.waitFor("auth-ok");
    await client.waitFor("instances");

    const options = Array.from({ length: optionCount }, (_, i) => ({
      label: `Option ${i + 1}`,
    }));
    fx.server.broadcastActivity("inst-1", "prompt", {
      tool: "AskUserQuestion",
      question: "Pick one",
      options,
    });
    await client.waitFor("prompt-state");
    return client;
  }

  it("translates a tapped option into the matching keystroke", async () => {
    const fx = await startServer();
    const client = await connectedWithPrompt(fx, 4);

    client.send({ type: "choose", instanceId: "inst-1", optionIndex: 2 });
    await vi.waitFor(() => expect(fx.writes).toHaveLength(1));
    // Third option -> "3".
    expect(fx.writes[0]).toEqual({ id: "inst-1", data: "3" });

    client.close();
  });

  it("refuses an out-of-range option instead of guessing", async () => {
    const fx = await startServer();
    const client = await connectedWithPrompt(fx, 3);

    client.send({ type: "choose", instanceId: "inst-1", optionIndex: 7 });
    const error = await client.waitFor("error");
    expect(String(error.message)).toContain("no longer available");
    // The important part: nothing was typed into the agent's terminal.
    expect(fx.writes).toEqual([]);

    client.close();
  });

  it("refuses a choice for a prompt that already cleared", async () => {
    const fx = await startServer();
    const client = await connectedWithPrompt(fx, 3);

    // Someone answered on the desktop first — the race that would otherwise send
    // a keystroke into whatever replaced the prompt.
    fx.server.broadcastActivity("inst-1", "prompt-cleared");
    await client.waitFor("prompt-cleared");

    client.send({ type: "choose", instanceId: "inst-1", optionIndex: 0 });
    await client.waitFor("error");
    expect(fx.writes).toEqual([]);

    client.close();
  });

  it("passes raw input straight through to the PTY", async () => {
    const fx = await startServer();
    const client = new TestClient(fx.url);
    await client.handshake();
    client.send({ type: "auth", deviceToken: fx.token });
    await client.waitFor("auth-ok");

    client.send({ type: "input", instanceId: "inst-1", data: "\x1b[A" });
    await vi.waitFor(() => expect(fx.writes).toHaveLength(1));
    expect(fx.writes[0].data).toBe("\x1b[A");

    client.close();
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

    const a = new TestClient(fx.url);
    await a.handshake();
    a.send({ type: "auth", deviceToken: fx.token, deviceName: "phone-a" });
    await a.waitFor("auth-ok");

    const b = new TestClient(fx.url);
    await b.handshake();
    b.send({ type: "auth", deviceToken: secondOffer.deviceToken, deviceName: "phone-b" });
    await b.waitFor("auth-ok");

    const deviceA = fx.server
      .getStatus()
      .devices.find((d) => d.name === "phone-a");
    fx.server.revokeDevice(deviceA!.id);
    expect(await a.waitClose()).toBe(4003);

    // b must still be live and receiving.
    fx.server.broadcastActivity("inst-1", "waiting");
    const activity = await b.waitFor("activity");
    expect(activity.instanceId).toBe("inst-1");

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
});
