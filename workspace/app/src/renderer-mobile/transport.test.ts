// The link against a fake socket and a fake desktop doing the real handshake and
// seal: connect, refusals, the 5 s connect deadline and the backoff, the ping and
// its pong timeout, and closing when hidden / dialling again when shown.

import nacl from "tweetnacl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientFrame, ServerFrame } from "../shared/remote-protocol";
import type { StoredPairing } from "./pairing";
import {
  BACKOFF_MS,
  CONNECT_DEADLINE_MS,
  Link,
  PING_EVERY_MS,
  PONG_TIMEOUT_MS,
  type LinkEnv,
  type LinkStatus,
  type OfflineReason,
} from "./transport";

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const bytes = (text: string) => new Uint8Array(Buffer.from(text, "base64"));

const host = nacl.box.keyPair();
const pairing: StoredPairing = {
  origin: "https://mac.tailnet.ts.net",
  hostPublicKey: b64(host.publicKey),
  deviceToken: "token-1",
  hostName: "Multi-Code on MacBook Air",
};

class FakeSocket {
  static all: FakeSocket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];
  closed = false;
  private key: Uint8Array | null = null;

  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.closed = true;
    this.readyState = 3;
  }

  // The desktop's side.
  accept() {
    this.readyState = 1;
    this.onopen?.();
  }

  hello(hostPublicKey = pairing.hostPublicKey) {
    const clientHello = JSON.parse(this.sent[0]) as { type: string; clientPublicKey: string };
    expect(clientHello.type).toBe("client-hello");
    this.key = nacl.box.before(bytes(clientHello.clientPublicKey), host.secretKey);
    this.plain({ type: "server-hello", v: 3, hostPublicKey, hostName: pairing.hostName, sessionId: "s" });
  }

  plain(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  seal(frame: ServerFrame) {
    const nonce = nacl.randomBytes(nacl.box.nonceLength);
    const body = nacl.box.after(new TextEncoder().encode(JSON.stringify(frame)), nonce, this.key!);
    this.plain({ type: "sealed", nonce: b64(nonce), body: b64(body) });
  }

  // What the phone sent inside the seal.
  frames(): ClientFrame[] {
    return this.sent.slice(1).map((raw) => {
      const env = JSON.parse(raw) as { nonce: string; body: string };
      const opened = nacl.box.open.after(bytes(env.body), bytes(env.nonce), this.key!);
      return JSON.parse(new TextDecoder().decode(opened!)) as ClientFrame;
    });
  }

  drop(code = 1006) {
    this.readyState = 3;
    this.onclose?.({ code });
  }

  // Handshake and auth, as the desktop answers them.
  connect() {
    this.accept();
    this.hello();
    this.seal({ type: "auth-ok", hostName: pairing.hostName, vapidPublicKey: "vapid", pushEnabled: false });
  }
}

let statuses: LinkStatus[];
let frames: ServerFrame[];
let visible: boolean;
let handlers: { hidden(): void; visible(): void; online(): void } | null;
let reach: ReturnType<typeof vi.fn<() => Promise<OfflineReason>>>;
let link: Link;

const env: LinkEnv = {
  WebSocket: FakeSocket as unknown as typeof WebSocket,
  isVisible: () => visible,
  listen(h) {
    handlers = h;
    return () => (handlers = null);
  },
  reach: () => reach(),
};

const last = () => FakeSocket.all[FakeSocket.all.length - 1];
const state = () => statuses[statuses.length - 1];

function start() {
  link = new Link({
    url: "wss://mac.tailnet.ts.net/",
    pairing,
    deviceName: "iPhone",
    onStatus: (s) => statuses.push(s),
    onFrame: (f) => frames.push(f),
    env,
  });
  link.start();
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.all = [];
  statuses = [];
  frames = [];
  visible = true;
  handlers = null;
  reach = vi.fn(async () => "mac-unreachable" as OfflineReason);
});

afterEach(() => {
  link?.stop();
  vi.useRealTimers();
});

describe("link", () => {
  it("dials the page's origin, pins the desktop's key and authenticates", () => {
    start();
    expect(state()).toEqual({ state: "connecting" });
    expect(last().url).toBe("wss://mac.tailnet.ts.net/");
    expect(link.send({ type: "list-instances" })).toBe(false);

    const socket = last();
    socket.accept();
    socket.hello();
    expect(socket.frames()).toEqual([{ type: "auth", deviceToken: "token-1", deviceName: "iPhone" }]);
    socket.seal({ type: "auth-ok", hostName: pairing.hostName, vapidPublicKey: "vapid", pushEnabled: true });
    expect(state()).toMatchObject({ state: "connected", authOk: { vapidPublicKey: "vapid", pushEnabled: true } });

    socket.seal({ type: "instances", instances: [] });
    // Pongs too: the store dates what's on screen by the last frame.
    socket.seal({ type: "pong", at: 1 });
    expect(frames).toEqual([{ type: "instances", instances: [] }, { type: "pong", at: 1 }]);
    expect(link.send({ type: "subscribe", instanceId: "a" })).toBe(true);
    expect(socket.frames().at(-1)).toEqual({ type: "subscribe", instanceId: "a" });
  });

  it("refuses a desktop whose key isn't the pinned one, and stops", () => {
    start();
    last().accept();
    last().hello(b64(nacl.box.keyPair().publicKey));
    expect(state()).toEqual({ state: "refused", reason: "wrong-key" });
    expect(last().closed).toBe(true);
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.all).toHaveLength(1);
  });

  it("stops on another protocol version and on a token the desktop doesn't know", () => {
    start();
    last().accept();
    last().plain({ type: "handshake-error", reason: "version" });
    expect(state()).toEqual({ state: "refused", reason: "version" });

    link.retryNow();
    const socket = last();
    expect(FakeSocket.all).toHaveLength(2);
    socket.accept();
    socket.hello();
    socket.seal({ type: "auth-failed", reason: "revoked" });
    expect(state()).toEqual({ state: "refused", reason: "revoked" });
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.all).toHaveLength(2);
  });

  it("abandons a connect stuck for 5 s, says why, and backs off from 0.5 s to 8 s", async () => {
    start();
    vi.advanceTimersByTime(CONNECT_DEADLINE_MS - 1);
    expect(state()).toEqual({ state: "connecting" });
    vi.advanceTimersByTime(1);
    expect(last().closed).toBe(true);
    expect(state()).toEqual({ state: "offline", reason: null, retrying: false });
    // The probe's answer, without moving the clock.
    await vi.advanceTimersByTimeAsync(0);
    expect(state()).toEqual({ state: "offline", reason: "mac-unreachable", retrying: false });

    const gaps: number[] = [];
    for (let i = 0; i < 6; i++) {
      const before = FakeSocket.all.length;
      let waited = 0;
      while (FakeSocket.all.length === before) {
        vi.advanceTimersByTime(100);
        waited += 100;
      }
      gaps.push(waited);
      // The retry keeps saying offline, now with an attempt under way.
      expect(state()).toEqual({ state: "offline", reason: "mac-unreachable", retrying: true });
      last().drop();
    }
    expect(gaps).toEqual([...BACKOFF_MS, 8000]);
  });

  it("counts a socket closed before auth-ok as a failed connect", () => {
    start();
    last().drop();
    expect(state()).toMatchObject({ state: "offline" });
    expect(reach).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(BACKOFF_MS[0]);
    last().connect();
    expect(state()).toMatchObject({ state: "connected" });
  });

  it("dials again at once when the Mac's page answers but the socket failed", async () => {
    reach = vi.fn(async () => "link-failed" as OfflineReason);
    start();
    last().drop();
    expect(FakeSocket.all).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeSocket.all).toHaveLength(2);
    expect(state()).toEqual({ state: "offline", reason: "link-failed", retrying: true });
  });

  it("dials again soon after a connected socket drops", () => {
    start();
    last().connect();
    last().drop();
    expect(state()).toEqual({ state: "connecting" });
    expect(link.send({ type: "list-instances" })).toBe(false);
    vi.advanceTimersByTime(BACKOFF_MS[0]);
    expect(FakeSocket.all).toHaveLength(2);
    last().connect();
    expect(state()).toMatchObject({ state: "connected" });
  });

  it("pings every 15 s and gives up a socket that doesn't answer within 5 s", () => {
    start();
    const socket = last();
    socket.connect();
    vi.advanceTimersByTime(PING_EVERY_MS);
    expect(socket.frames().at(-1)).toMatchObject({ type: "ping" });
    socket.seal({ type: "pong", at: 0 });
    vi.advanceTimersByTime(PONG_TIMEOUT_MS + 1);
    expect(state()).toMatchObject({ state: "connected" });

    // Half-open: the next ping gets nothing back.
    vi.advanceTimersByTime(PING_EVERY_MS - PONG_TIMEOUT_MS - 1);
    expect(socket.frames().filter((f) => f.type === "ping")).toHaveLength(2);
    vi.advanceTimersByTime(PONG_TIMEOUT_MS);
    expect(socket.closed).toBe(true);
    expect(state()).toEqual({ state: "connecting" });
    vi.advanceTimersByTime(BACKOFF_MS[0]);
    expect(FakeSocket.all).toHaveLength(2);
  });

  it("counts any frame after a ping as the socket being alive", () => {
    start();
    const socket = last();
    socket.connect();
    vi.advanceTimersByTime(PING_EVERY_MS);
    socket.seal({ type: "output", instanceId: "a", data: "x" });
    vi.advanceTimersByTime(PONG_TIMEOUT_MS + 1);
    expect(state()).toMatchObject({ state: "connected" });
  });

  it("closes when the page is hidden and dials at once when it is shown", () => {
    start();
    const socket = last();
    socket.connect();
    handlers!.hidden();
    expect(socket.closed).toBe(true);
    expect(state()).toEqual({ state: "paused" });
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.all).toHaveLength(1);

    visible = true;
    handlers!.visible();
    expect(FakeSocket.all).toHaveLength(2);
    expect(state()).toEqual({ state: "connecting" });
  });

  it("pings a socket it still holds when the page is shown, instead of trusting it", () => {
    start();
    const socket = last();
    socket.connect();
    handlers!.visible();
    expect(FakeSocket.all).toHaveLength(1);
    expect(socket.frames().at(-1)).toMatchObject({ type: "ping" });
    vi.advanceTimersByTime(PONG_TIMEOUT_MS);
    expect(socket.closed).toBe(true);
    vi.advanceTimersByTime(BACKOFF_MS[0]);
    expect(FakeSocket.all).toHaveLength(2);
  });

  it("starts paused in a hidden page", () => {
    visible = false;
    start();
    expect(state()).toEqual({ state: "paused" });
    expect(FakeSocket.all).toHaveLength(0);
    visible = true;
    handlers!.visible();
    expect(FakeSocket.all).toHaveLength(1);
  });

  it("skips the backoff when shown again or back online, and keeps saying offline", () => {
    start();
    vi.advanceTimersByTime(CONNECT_DEADLINE_MS);
    expect(state()).toMatchObject({ state: "offline", retrying: false });
    handlers!.online();
    expect(FakeSocket.all).toHaveLength(2);
    expect(state()).toMatchObject({ state: "offline", retrying: true });
    // One attempt at a time: shown again while dialling changes nothing.
    handlers!.visible();
    expect(FakeSocket.all).toHaveLength(2);
  });

  it("checks a connected socket at once when the network comes back", () => {
    start();
    const socket = last();
    socket.connect();
    handlers!.online();
    expect(socket.frames().at(-1)).toMatchObject({ type: "ping" });
    vi.advanceTimersByTime(PONG_TIMEOUT_MS);
    expect(socket.closed).toBe(true);
  });

  it("ignores a late close or message from a socket it gave up", () => {
    start();
    const stuck = last();
    vi.advanceTimersByTime(CONNECT_DEADLINE_MS);
    expect(stuck.onclose).toBeNull();
    expect(stuck.onmessage).toBeNull();
    vi.advanceTimersByTime(BACKOFF_MS[0]);
    last().connect();
    expect(state()).toMatchObject({ state: "connected" });
  });

  it("stays quiet once stopped", () => {
    start();
    last().connect();
    link.stop();
    expect(last().closed).toBe(true);
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.all).toHaveLength(1);
    handlers?.visible();
    expect(FakeSocket.all).toHaveLength(1);
  });
});
