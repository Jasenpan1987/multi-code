// Phone side of the sealed link.
//
// Races every endpoint from the pairing offer in parallel and keeps the first
// that completes a handshake — Tailscale addresses come first in the list, but a
// LAN address will usually win the race at home, and either is fine because both
// are direct. Reconnects with backoff when the socket drops, which happens
// constantly on a phone (screen lock, wifi/cellular handoff).

import nacl from "tweetnacl";
import {
  REMOTE_PROTOCOL_VERSION,
  type ClientFrame,
  type ServerFrame,
} from "../shared/remote-protocol";

const b64 = {
  encode: (bytes: Uint8Array): string => {
    let s = "";
    for (const byte of bytes) s += String.fromCharCode(byte);
    return btoa(s);
  },
  decode: (text: string): Uint8Array => {
    const s = atob(text);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  },
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export type ConnectionState =
  | "idle"
  | "connecting"
  | "connected"
  | "auth-failed"
  | "disconnected";

export interface TransportCallbacks {
  onState: (state: ConnectionState, detail?: string) => void;
  onFrame: (frame: ServerFrame) => void;
}

export interface StoredPairing {
  endpoints: string[];
  hostPublicKey: string;
  deviceToken: string;
  hostName: string;
}

// Reconnect backoff. Starts fast because the common case is a brief wifi blip,
// and caps low enough that a phone coming out of a pocket reconnects promptly.
const BACKOFF_MS = [500, 1000, 2000, 4000, 8000, 15_000];

// A handshake that stalls (endpoint reachable but not our server) shouldn't hold
// the race open.
const HANDSHAKE_TIMEOUT_MS = 6000;

export class RemoteTransport {
  private socket: WebSocket | null = null;
  private sharedKey: Uint8Array | null = null;
  private attempt = 0;
  private closed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private state: ConnectionState = "idle";

  constructor(
    private readonly pairing: StoredPairing,
    private readonly deviceName: string,
    private readonly callbacks: TransportCallbacks
  ) {}

  getState(): ConnectionState {
    return this.state;
  }

  private setState(state: ConnectionState, detail?: string) {
    this.state = state;
    this.callbacks.onState(state, detail);
  }

  start() {
    this.closed = false;
    void this.connect();
  }

  stop() {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.socket?.close();
    this.socket = null;
    this.sharedKey = null;
  }

  send(frame: ClientFrame) {
    if (!this.socket || !this.sharedKey) return;
    if (this.socket.readyState !== WebSocket.OPEN) return;
    const nonce = nacl.randomBytes(nacl.box.nonceLength);
    const boxed = nacl.box.after(
      encoder.encode(JSON.stringify(frame)),
      nonce,
      this.sharedKey
    );
    this.socket.send(
      JSON.stringify({
        type: "sealed",
        nonce: b64.encode(nonce),
        body: b64.encode(boxed),
      })
    );
  }

  private async connect() {
    if (this.closed) return;
    this.setState("connecting");

    let winner: { socket: WebSocket; sharedKey: Uint8Array } | null;
    try {
      winner = await this.race();
    } catch {
      winner = null;
    }

    if (this.closed) {
      winner?.socket.close();
      return;
    }

    if (!winner) {
      this.scheduleReconnect();
      return;
    }

    this.attempt = 0;
    this.socket = winner.socket;
    this.sharedKey = winner.sharedKey;

    winner.socket.onmessage = (event) => this.handleMessage(event);
    winner.socket.onclose = () => {
      this.socket = null;
      this.sharedKey = null;
      if (!this.closed && this.state !== "auth-failed") {
        this.setState("disconnected");
        this.scheduleReconnect();
      }
    };
    winner.socket.onerror = () => {
      // onclose always follows, so reconnect is handled there.
    };

    // Authenticate immediately; the desktop drops unauthenticated sockets after
    // 10s. `connected` is only reported once auth-ok comes back.
    this.send({
      type: "auth",
      deviceToken: this.pairing.deviceToken,
      deviceName: this.deviceName,
    });
  }

  // Open every endpoint at once, resolve with the first to finish its hello
  // exchange, and close the losers.
  private race(): Promise<{ socket: WebSocket; sharedKey: Uint8Array } | null> {
    const endpoints = this.pairing.endpoints;
    if (endpoints.length === 0) return Promise.resolve(null);

    return new Promise((resolve) => {
      let settled = false;
      let pending = endpoints.length;
      const sockets: WebSocket[] = [];

      const finish = (
        result: { socket: WebSocket; sharedKey: Uint8Array } | null
      ) => {
        if (settled) return;
        settled = true;
        for (const s of sockets) {
          if (s !== result?.socket) {
            s.onopen = s.onmessage = s.onerror = s.onclose = null;
            s.close();
          }
        }
        resolve(result);
      };

      const oneFailed = () => {
        pending -= 1;
        if (pending <= 0) finish(null);
      };

      for (const endpoint of endpoints) {
        let socket: WebSocket;
        try {
          socket = new WebSocket(endpoint);
        } catch {
          oneFailed();
          continue;
        }
        sockets.push(socket);

        const timer = setTimeout(() => {
          if (!settled) {
            socket.close();
            oneFailed();
          }
        }, HANDSHAKE_TIMEOUT_MS);

        // Fresh ephemeral keypair per attempt, so a losing socket's key is
        // simply discarded.
        const keyPair = nacl.box.keyPair();

        socket.onopen = () => {
          socket.send(
            JSON.stringify({
              type: "client-hello",
              v: REMOTE_PROTOCOL_VERSION,
              clientPublicKey: b64.encode(keyPair.publicKey),
            })
          );
        };

        socket.onmessage = (event) => {
          let frame: Record<string, unknown>;
          try {
            frame = JSON.parse(String(event.data));
          } catch {
            clearTimeout(timer);
            socket.close();
            oneFailed();
            return;
          }

          if (frame.type !== "server-hello") {
            clearTimeout(timer);
            socket.close();
            oneFailed();
            return;
          }

          // Pin check: the desktop must present the exact key from the QR. This
          // is what makes a direct connection safe over a network we don't
          // control — an impostor at the same address fails here.
          if (frame.hostPublicKey !== this.pairing.hostPublicKey) {
            clearTimeout(timer);
            socket.close();
            oneFailed();
            return;
          }

          clearTimeout(timer);
          const sharedKey = nacl.box.before(
            b64.decode(String(frame.hostPublicKey)),
            keyPair.secretKey
          );
          // Detach the race handlers; connect() installs the real ones.
          socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
          finish({ socket, sharedKey });
        };

        socket.onerror = () => {
          clearTimeout(timer);
          oneFailed();
        };
        socket.onclose = () => {
          clearTimeout(timer);
          if (!settled) oneFailed();
        };
      }
    });
  }

  private handleMessage(event: MessageEvent) {
    if (!this.sharedKey) return;
    let envelope: Record<string, unknown>;
    try {
      envelope = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (envelope.type !== "sealed") return;

    const opened = nacl.box.open.after(
      b64.decode(String(envelope.body)),
      b64.decode(String(envelope.nonce)),
      this.sharedKey
    );
    if (!opened) return;

    let frame: ServerFrame;
    try {
      frame = JSON.parse(decoder.decode(opened)) as ServerFrame;
    } catch {
      return;
    }

    if (frame.type === "auth-ok") {
      this.setState("connected", frame.hostName);
      return;
    }
    if (frame.type === "auth-failed") {
      // A revoked or unknown token will never succeed, so stop retrying and
      // make the phone show the re-pair screen.
      this.closed = true;
      this.setState("auth-failed", frame.reason);
      return;
    }
    this.callbacks.onFrame(frame);
  }

  private scheduleReconnect() {
    if (this.closed) return;
    const delay = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)];
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }
}
