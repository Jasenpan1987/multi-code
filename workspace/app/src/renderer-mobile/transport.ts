// The phone's one link to the Mac: a WebSocket to the page's own origin (`wss:` on
// the `tailscale serve` HTTPS origin, `ws:` on http://127.0.0.1 in development),
// the plaintext hello that pins the desktop's key, then NaCl-sealed frames and
// `auth` (shared/remote-protocol.ts).
//
// iOS is what shapes the rest (docs/timeline/2026-10-13_mobile-v2-research.md):
//   - A socket in a backgrounded page is closed about 10 s later, and one left
//     open across a lock can come back half-open: "connected", delivering nothing.
//     So the link closes itself when the page is hidden, dials again the moment it
//     is shown (`visibilitychange`, `pageshow`, `online`), and pings every 15 s
//     while visible: no frame within 5 s of a ping and the socket is given up.
//   - On resume `new WebSocket()` can hang in CONNECTING. Every connect has 5 s to
//     get from dialling to `auth-ok`; one that hasn't is abandoned and retried.
// Retries back off from 0.5 s to 8 s. The link knows nothing of sessions or the
// outbox: the store resubscribes and resends when it reports `connected`.

import nacl from "tweetnacl";
import {
  REMOTE_PROTOCOL_VERSION,
  type AuthOkFrame,
  type ClientFrame,
  type ServerFrame,
} from "../shared/remote-protocol";
import type { StoredPairing } from "./pairing";

export const PING_EVERY_MS = 15_000;
export const PONG_TIMEOUT_MS = 5_000;
export const CONNECT_DEADLINE_MS = 5_000;
export const BACKOFF_MS = [500, 1000, 2000, 4000, 8000];
// How often a failing link asks why it fails (see `reach` below).
const PROBE_GAP_MS = 10_000;
const PROBE_TIMEOUT_MS = 4_000;

// Why the Mac can't be reached, as far as the phone can tell (PRD Story 1: the app
// says which side can't be reached):
//   no-network      — this phone has no network at all
//   mac-unreachable — nothing answers at the Mac's address: it is asleep or off,
//                     or Tailscale is off on it or on this phone
//   multi-code-down — the Mac answers, but nothing listens behind `tailscale
//                     serve`: Multi-Code isn't running, or its phone link is off
//   link-failed     — the page loads from the Mac, but the socket doesn't open
export type OfflineReason = "no-network" | "mac-unreachable" | "multi-code-down" | "link-failed";

// Why the Mac turned this phone away. Retrying won't change it, so the link stops
// until the page is shown again or the phone pairs anew:
//   unknown-token, revoked — the desktop doesn't know this phone (any more)
//   version                — the desktop speaks another protocol version
//   wrong-key              — the desktop's key isn't the one pinned at pairing
export type RefusedReason = "unknown-token" | "revoked" | "version" | "wrong-key";

export type LinkStatus =
  // Dialling after a start, a resume or a dropped connection.
  | { state: "connecting" }
  | { state: "connected"; authOk: AuthOkFrame }
  // The last attempt failed. The link keeps retrying and stays `offline` while it
  // does (`retrying`: an attempt is under way), so the screen doesn't flicker
  // between "connecting" and the banner. `reason` is null until the first probe
  // answers.
  | { state: "offline"; reason: OfflineReason | null; retrying: boolean }
  | { state: "refused"; reason: RefusedReason }
  // The page is hidden, so the link is closed on purpose.
  | { state: "paused" };

// The page and network events the link reacts to, injected so tests can drive it.
export interface LinkEnv {
  WebSocket: typeof WebSocket;
  isVisible(): boolean;
  // Subscribes to the events that mean "hidden" and "look again now"; returns the
  // unsubscribe.
  listen(handlers: { hidden(): void; visible(): void; online(): void }): () => void;
  // Why a connect failed (see OfflineReason).
  reach(): Promise<OfflineReason>;
}

export interface LinkOptions {
  url: string;
  pairing: StoredPairing;
  deviceName: string;
  onStatus: (status: LinkStatus) => void;
  onFrame: (frame: ServerFrame) => void;
  env?: LinkEnv;
}

// WebSocket.OPEN, spelled out so the link doesn't need a global WebSocket in tests.
const OPEN = 1;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const b64 = {
  encode(bytes: Uint8Array): string {
    let s = "";
    for (const byte of bytes) s += String.fromCharCode(byte);
    return btoa(s);
  },
  decode(text: string): Uint8Array {
    return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
  },
};

// The socket URL for the page's own origin.
export function socketUrl(location: Location): string {
  return `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/`;
}

export function browserEnv(): LinkEnv {
  return {
    WebSocket,
    isVisible: () => document.visibilityState === "visible",
    listen({ hidden, visible, online }) {
      const onVisibility = () => (document.visibilityState === "visible" ? visible() : hidden());
      document.addEventListener("visibilitychange", onVisibility);
      // A page restored from the back-forward cache, which fires no visibilitychange.
      window.addEventListener("pageshow", visible);
      window.addEventListener("online", online);
      return () => {
        document.removeEventListener("visibilitychange", onVisibility);
        window.removeEventListener("pageshow", visible);
        window.removeEventListener("online", online);
      };
    },
    async reach() {
      if (navigator.onLine === false) return "no-network";
      try {
        // The query keeps the service worker from answering it out of its cache
        // (sw.ts never handles a URL with one).
        const res = await fetch(`/manifest.webmanifest?reach=${Date.now()}`, {
          cache: "no-store",
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        // `tailscale serve` answers for the Mac and says what's behind it: a gateway
        // error is nothing listening on Multi-Code's port.
        if (res.status === 502 || res.status === 503 || res.status === 504) return "multi-code-down";
        return "link-failed";
      } catch {
        return "mac-unreachable";
      }
    },
  };
}

export class Link {
  private readonly env: LinkEnv;
  private socket: WebSocket | null = null;
  private key: Uint8Array | null = null;
  private authed = false;
  // Failed connects in a row: the backoff step.
  private failures = 0;
  // The last connect failed and none has succeeded since.
  private offline = false;
  private reason: OfflineReason | null = null;
  private probedAt = -Infinity;
  private running = false;
  private refused = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private unlisten: (() => void) | null = null;
  private status: LinkStatus = { state: "paused" };

  constructor(private readonly options: LinkOptions) {
    this.env = options.env ?? browserEnv();
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.unlisten = this.env.listen({
      hidden: () => this.pause(),
      // With a socket still held (a page restored without a hidden event first),
      // it may be half-open: ping it rather than trust it.
      visible: () => (this.authed ? this.ping() : this.retryNow()),
      online: () => (this.authed ? this.ping() : this.retryNow()),
    });
    if (this.env.isVisible()) this.connect();
    else this.setStatus({ state: "paused" });
  }

  stop() {
    this.running = false;
    this.unlisten?.();
    this.unlisten = null;
    this.clearRetry();
    if (this.socket) this.drop(this.socket);
  }

  // Seals and sends a frame. False when no authenticated socket is open: the
  // caller decides whether that frame waits (the outbox) or is refused.
  send(frame: ClientFrame): boolean {
    if (!this.socket || !this.key || !this.authed) return false;
    if (this.socket.readyState !== OPEN) return false;
    this.sendSealed(this.socket, this.key, frame);
    return true;
  }

  // Dial now instead of waiting out the backoff: the page was shown again, the
  // network came back, or the builder pressed Retry. A refused link tries once more.
  retryNow() {
    if (!this.running || !this.env.isVisible()) return;
    if (this.socket) return;
    this.refused = false;
    // The builder is looking: start the backoff over, but keep saying `offline`
    // until a connect works.
    this.failures = 0;
    this.connect();
  }

  private setStatus(status: LinkStatus) {
    this.status = status;
    this.options.onStatus(status);
  }

  private connect() {
    if (!this.running || this.refused || this.socket) return;
    this.clearRetry();
    this.setStatus(this.offline ? { state: "offline", reason: this.reason, retrying: true } : { state: "connecting" });

    let socket: WebSocket;
    try {
      socket = new this.env.WebSocket(this.options.url);
    } catch {
      this.failed(null);
      return;
    }
    this.socket = socket;
    // A fresh key pair per connect, so nothing from an abandoned socket carries over.
    const keys = nacl.box.keyPair();
    this.deadlineTimer = setTimeout(() => this.failed(socket), CONNECT_DEADLINE_MS);

    socket.onopen = () => {
      socket.send(
        JSON.stringify({
          type: "client-hello",
          v: REMOTE_PROTOCOL_VERSION,
          clientPublicKey: b64.encode(keys.publicKey),
        })
      );
    };
    socket.onmessage = (event) => this.receive(socket, keys.secretKey, String(event.data));
    socket.onclose = () => (this.authed ? this.lost(socket) : this.failed(socket));
    // onclose always follows an error, and is where it's handled.
    socket.onerror = () => {};
  }

  private receive(socket: WebSocket, secretKey: Uint8Array, data: string) {
    if (socket !== this.socket) return;
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(data) as Record<string, unknown>;
    } catch {
      this.failed(socket);
      return;
    }

    // Before the seal: the desktop's hello, or its refusal.
    if (!this.key) {
      if (frame.type === "handshake-error") {
        if (frame.reason === "version") this.refuse(socket, "version");
        else this.failed(socket);
        return;
      }
      if (frame.type !== "server-hello" || typeof frame.hostPublicKey !== "string") {
        this.failed(socket);
        return;
      }
      // The pin: the desktop must present the exact key from the QR, which is what
      // makes the link safe whatever the network in between.
      if (frame.hostPublicKey !== this.options.pairing.hostPublicKey) {
        this.refuse(socket, "wrong-key");
        return;
      }
      this.key = nacl.box.before(b64.decode(frame.hostPublicKey), secretKey);
      // The desktop drops a socket that hasn't authenticated within 10 s; the
      // connect deadline is shorter.
      this.sendSealed(socket, this.key, {
        type: "auth",
        deviceToken: this.options.pairing.deviceToken,
        deviceName: this.options.deviceName,
      });
      return;
    }

    if (frame.type !== "sealed" || typeof frame.nonce !== "string" || typeof frame.body !== "string") return;
    let opened: Uint8Array | null;
    try {
      opened = nacl.box.open.after(b64.decode(frame.body), b64.decode(frame.nonce), this.key);
    } catch {
      opened = null;
    }
    if (!opened) return;
    let inner: ServerFrame;
    try {
      inner = JSON.parse(decoder.decode(opened)) as ServerFrame;
    } catch {
      return;
    }

    if (!this.authed) {
      if (inner.type === "auth-ok") {
        this.authed = true;
        this.failures = 0;
        this.offline = false;
        this.reason = null;
        this.clearDeadline();
        this.pingTimer = setInterval(() => this.ping(), PING_EVERY_MS);
        this.setStatus({ state: "connected", authOk: inner });
      } else if (inner.type === "auth-failed") {
        this.refuse(socket, inner.reason);
      }
      return;
    }

    // Anything at all from the desktop proves the socket is alive. Pongs go on to
    // the store too, which dates what's on screen by the last frame.
    this.clearPong();
    this.options.onFrame(inner);
  }

  private ping() {
    if (!this.socket || !this.key || !this.authed || this.pongTimer) return;
    const socket = this.socket;
    this.sendSealed(socket, this.key, { type: "ping", at: Date.now() });
    this.pongTimer = setTimeout(() => {
      this.pongTimer = null;
      // Half-open: close it without waiting for a close that may never come.
      this.lost(socket);
    }, PONG_TIMEOUT_MS);
  }

  // An authenticated socket went away (closed, or stopped answering). Dial again
  // after the first backoff step: soon, but not in a loop against a desktop that
  // drops every socket it accepts.
  private lost(socket: WebSocket) {
    if (socket !== this.socket) return;
    this.drop(socket);
    if (!this.running) return;
    this.setStatus({ state: "connecting" });
    this.scheduleRetry(BACKOFF_MS[0]);
  }

  // A connect that didn't reach `auth-ok`: closed, errored, timed out, or answered
  // with something that isn't the protocol.
  private failed(socket: WebSocket | null) {
    if (socket && socket !== this.socket) return;
    if (socket) this.drop(socket);
    if (!this.running) return;
    const delay = BACKOFF_MS[Math.min(this.failures, BACKOFF_MS.length - 1)];
    this.failures += 1;
    this.offline = true;
    this.setStatus({ state: "offline", reason: this.reason, retrying: false });
    this.scheduleRetry(delay);
    void this.probe();
  }

  private refuse(socket: WebSocket, reason: RefusedReason) {
    this.drop(socket);
    this.clearRetry();
    this.refused = true;
    this.setStatus({ state: "refused", reason });
  }

  private pause() {
    this.clearRetry();
    if (this.socket) this.drop(this.socket);
    if (this.running && !this.refused) this.setStatus({ state: "paused" });
  }

  private async probe() {
    const now = Date.now();
    if (now - this.probedAt < PROBE_GAP_MS) return;
    this.probedAt = now;
    const reason = await this.env.reach();
    if (!this.running || !this.offline) return;
    this.reason = reason;
    if (this.status.state === "offline" && this.status.reason !== reason) {
      this.setStatus({ ...this.status, reason });
    }
    // The page loads but the socket didn't: most often Multi-Code has just come
    // back between the two. Try now rather than after the backoff.
    if (reason === "link-failed" && !this.socket && this.env.isVisible()) this.connect();
  }

  private scheduleRetry(delay: number) {
    this.clearRetry();
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.env.isVisible()) this.connect();
    }, delay);
  }

  // Forget a socket: detach its handlers first, so its late close or message can't
  // touch the next one.
  private drop(socket: WebSocket) {
    socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
    try {
      socket.close();
    } catch {
      // Already closed.
    }
    if (socket === this.socket) {
      this.socket = null;
      this.key = null;
      this.authed = false;
    }
    this.clearDeadline();
    this.clearPong();
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private sendSealed(socket: WebSocket, key: Uint8Array, frame: ClientFrame) {
    const nonce = nacl.randomBytes(nacl.box.nonceLength);
    const body = nacl.box.after(encoder.encode(JSON.stringify(frame)), nonce, key);
    socket.send(JSON.stringify({ type: "sealed", nonce: b64.encode(nonce), body: b64.encode(body) }));
  }

  private clearRetry() {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private clearDeadline() {
    if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
    this.deadlineTimer = null;
  }

  private clearPong() {
    if (this.pongTimer) clearTimeout(this.pongTimer);
    this.pongTimer = null;
  }
}
