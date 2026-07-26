// The desktop half of the phone link.
//
// One HTTP server on port 6768 serving two things:
//   - the mobile web client (a static bundle, so the phone needs no install)
//   - a WebSocket endpoint carrying the sealed frame protocol
//
// Both live on the same port so a single QR code covers both, and so there is
// exactly one thing to allow through the firewall. Bound to 0.0.0.0 because the
// point is to be reachable from another device; access control is the device
// token plus the NaCl seal, not the bind address.

import http from "http";
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { WebSocketServer, type WebSocket } from "ws";
import { app } from "electron";
import nacl from "tweetnacl";
import {
  DEFAULT_REMOTE_PORT,
  REMOTE_PROTOCOL_VERSION,
  type ClientFrame,
  type PairedDevice,
  type PairingOffer,
  type PromptOption,
  type RemoteInstance,
  type RemoteStatus,
  type ServerFrame,
} from "../../shared/remote-protocol";
import { SealedChannel, getHostIdentity, mintDeviceToken, tokensMatch } from "./crypto";
import { loadDevices, saveDevices, type StoredDevice } from "./device-store";
import { buildEndpointUrls, buildEndpoints } from "./endpoints";
import { outputBuffer } from "./output-buffer";
import { keystrokeForOption, type PromptDetail } from "./promptExtract";

// A phone that never completes its handshake + auth in this window gets dropped,
// so a port scanner can't hold sockets open.
const AUTH_TIMEOUT_MS = 10_000;

// Static files for the mobile client are only served from this directory, and
// only for paths that resolve inside it.
function mobileRoot(): string {
  return path.join(__dirname, "..", "..", "renderer-mobile");
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

interface Connection {
  socket: WebSocket;
  channel: SealedChannel | null;
  deviceId: string | null;
  authed: boolean;
  // Instances this phone is mirroring. Output for anything else is not sent.
  subscriptions: Set<string>;
  authTimer: ReturnType<typeof setTimeout> | null;
}

// What the server needs from the rest of the app. Injected rather than imported
// so this module stays testable and doesn't reach into process-manager directly.
export interface RemoteHost {
  listInstances: () => RemoteInstance[];
  writeToInstance: (id: string, data: string) => void;
  // Send a whole prompt as one paste + Enter (same path as the compose box).
  sendPrompt: (id: string, text: string) => void;
}

export class RemoteServer {
  private httpServer: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private connections = new Set<Connection>();
  private devices: StoredDevice[] = loadDevices();
  private port: number | null = null;
  private startError: string | undefined;
  private host: RemoteHost | null = null;
  private onStatusChange: (() => void) | null = null;
  // Latest prompt per instance, so a phone that connects while the agent is
  // already blocked still gets the buttons.
  private activePrompts = new Map<string, PromptDetail>();

  setHost(host: RemoteHost) {
    this.host = host;
  }

  setStatusListener(listener: () => void) {
    this.onStatusChange = listener;
  }

  isRunning(): boolean {
    return this.httpServer !== null;
  }

  async start(port = DEFAULT_REMOTE_PORT): Promise<RemoteStatus> {
    if (this.httpServer) return this.getStatus();

    this.startError = undefined;
    const server = http.createServer((req, res) => this.handleHttp(req, res));
    const wss = new WebSocketServer({ server });
    wss.on("connection", (socket) => this.handleConnection(socket));

    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "0.0.0.0", () => {
          server.removeListener("error", reject);
          resolve();
        });
      });
    } catch (err) {
      wss.close();
      server.close();
      this.startError =
        (err as NodeJS.ErrnoException)?.code === "EADDRINUSE"
          ? `Port ${port} is already in use`
          : ((err as Error)?.message ?? "Failed to start");
      return this.getStatus();
    }

    // Keep the process from being held open by an idle listener at quit time.
    server.on("error", () => {});

    this.httpServer = server;
    this.wss = wss;
    const address = server.address();
    this.port = typeof address === "object" && address ? address.port : port;
    this.notifyStatus();
    return this.getStatus();
  }

  async stop(): Promise<void> {
    for (const conn of this.connections) {
      conn.socket.close(1001, "server stopping");
    }
    this.connections.clear();

    const wss = this.wss;
    const server = this.httpServer;
    this.wss = null;
    this.httpServer = null;
    this.port = null;

    if (wss) await new Promise<void>((resolve) => wss.close(() => resolve()));
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    this.notifyStatus();
  }

  // -------------------------------------------------------------------------
  // Pairing
  // -------------------------------------------------------------------------

  // Mint a token for a new device and return the offer to encode as a QR. The
  // device row is written immediately (rather than on first connect) so the
  // token is valid the moment the phone scans, and so a half-finished pairing
  // is visible and revocable in the desktop UI.
  createPairingOffer(): PairingOffer | null {
    if (!this.port) return null;

    const identity = getHostIdentity();
    const token = mintDeviceToken();
    const device: StoredDevice = {
      id: crypto.randomUUID(),
      name: "New device",
      token,
      pairedAt: Date.now(),
      lastSeenAt: 0,
    };
    this.devices.push(device);
    saveDevices(this.devices);
    this.notifyStatus();

    return {
      v: REMOTE_PROTOCOL_VERSION,
      endpoints: buildEndpointUrls(this.port),
      hostPublicKey: identity.publicKeyB64,
      deviceToken: token,
      hostName: this.hostName(),
    };
  }

  revokeDevice(deviceId: string) {
    this.devices = this.devices.filter((d) => d.id !== deviceId);
    saveDevices(this.devices);
    // Drop any live connection using the revoked token. Snapshot first: the loop
    // deletes from the same set it iterates.
    const live = Array.from(this.connections);
    for (const conn of live) {
      if (conn.deviceId === deviceId) {
        this.send(conn, { type: "auth-failed", reason: "revoked" });
        conn.socket.close(4003, "revoked");
        this.connections.delete(conn);
      }
    }
    this.notifyStatus();
  }

  getStatus(): RemoteStatus {
    const connectedIds = new Set(
      [...this.connections].filter((c) => c.authed).map((c) => c.deviceId)
    );
    const devices: PairedDevice[] = this.devices.map((d) => ({
      id: d.id,
      name: d.name,
      pairedAt: d.pairedAt,
      lastSeenAt: d.lastSeenAt,
      connected: connectedIds.has(d.id),
    }));
    return {
      enabled: this.httpServer !== null,
      port: this.port,
      endpoints: this.port ? buildEndpoints(this.port) : [],
      devices,
      error: this.startError,
    };
  }

  private hostName(): string {
    return `${app.getName()} on ${os.hostname()}`;
  }

  private notifyStatus() {
    this.onStatusChange?.();
  }

  // -------------------------------------------------------------------------
  // Broadcast entry points, called by process-manager
  // -------------------------------------------------------------------------

  broadcastOutput(instanceId: string, data: string) {
    outputBuffer.append(instanceId, data);
    for (const conn of this.connections) {
      if (!conn.authed) continue;
      if (!conn.subscriptions.has(instanceId)) continue;
      this.send(conn, { type: "output", instanceId, data });
    }
  }

  broadcastActivity(
    instanceId: string,
    activity: string,
    detail?: PromptDetail
  ) {
    if (activity === "prompt-cleared") {
      this.activePrompts.delete(instanceId);
      this.broadcast({ type: "prompt-cleared", instanceId });
      return;
    }

    if (activity !== "waiting" && activity !== "prompt") return;
    this.broadcast({ type: "activity", instanceId, activity });

    if (activity === "prompt" && detail) {
      this.activePrompts.set(instanceId, detail);
      this.broadcast({
        type: "prompt-state",
        instanceId,
        tool: detail.tool,
        question: detail.question,
        options: detail.options,
      });
    }
  }

  broadcastExit(instanceId: string, code: number) {
    this.activePrompts.delete(instanceId);
    outputBuffer.clear(instanceId);
    this.broadcast({ type: "exit", instanceId, code });
    this.broadcastInstances();
  }

  broadcastInstances() {
    if (!this.host) return;
    this.broadcast({ type: "instances", instances: this.host.listInstances() });
  }

  private broadcast(frame: ServerFrame) {
    for (const conn of this.connections) {
      if (!conn.authed) continue;
      this.send(conn, frame);
    }
  }

  // -------------------------------------------------------------------------
  // HTTP: serve the mobile client
  // -------------------------------------------------------------------------

  private handleHttp(req: http.IncomingMessage, res: http.ServerResponse) {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405).end();
      return;
    }

    const root = mobileRoot();
    let requested: string;
    try {
      requested = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (requested === "/" || requested === "") requested = "/index.html";

    // Contain the resolved path inside the mobile bundle dir, so a crafted
    // `..` path can't read the rest of the filesystem off an open port.
    const resolved = path.resolve(root, "." + requested);
    const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
    if (resolved !== root && !resolved.startsWith(rootWithSep)) {
      res.writeHead(403).end();
      return;
    }

    let stat: fs.Stats;
    try {
      stat = fs.statSync(resolved);
    } catch {
      res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
      return;
    }
    if (!stat.isFile()) {
      res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
      return;
    }

    const type = CONTENT_TYPES[path.extname(resolved).toLowerCase()] ?? "application/octet-stream";
    res.writeHead(200, {
      "content-type": type,
      "content-length": stat.size,
      // The client is served over plain HTTP on a LAN/Tailscale address, so
      // there's no TLS to lean on; keep it from being cached across versions.
      "cache-control": "no-store",
    });
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    fs.createReadStream(resolved).pipe(res);
  }

  // -------------------------------------------------------------------------
  // WebSocket: handshake, auth, frame dispatch
  // -------------------------------------------------------------------------

  private handleConnection(socket: WebSocket) {
    const conn: Connection = {
      socket,
      channel: null,
      deviceId: null,
      authed: false,
      subscriptions: new Set(),
      authTimer: null,
    };
    this.connections.add(conn);

    conn.authTimer = setTimeout(() => {
      if (!conn.authed) socket.close(4001, "auth timeout");
    }, AUTH_TIMEOUT_MS);

    socket.on("message", (raw) => this.handleMessage(conn, raw.toString()));
    socket.on("close", () => {
      if (conn.authTimer) clearTimeout(conn.authTimer);
      this.connections.delete(conn);
      this.notifyStatus();
    });
    socket.on("error", () => {
      if (conn.authTimer) clearTimeout(conn.authTimer);
      this.connections.delete(conn);
    });
  }

  private handleMessage(conn: Connection, raw: string) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      conn.socket.close(4002, "malformed");
      return;
    }
    const frame = parsed as Record<string, unknown>;

    // Pre-seal: the only frame accepted is the hello that establishes the key.
    if (!conn.channel) {
      if (frame.type !== "client-hello" || typeof frame.clientPublicKey !== "string") {
        this.sendPlain(conn, { type: "handshake-error", reason: "malformed" });
        conn.socket.close(4002, "malformed");
        return;
      }
      if (frame.v !== REMOTE_PROTOCOL_VERSION) {
        this.sendPlain(conn, { type: "handshake-error", reason: "version" });
        conn.socket.close(4002, "version");
        return;
      }

      let clientKey: Buffer;
      try {
        clientKey = Buffer.from(frame.clientPublicKey, "base64");
      } catch {
        conn.socket.close(4002, "malformed");
        return;
      }
      if (clientKey.length !== nacl.box.publicKeyLength) {
        conn.socket.close(4002, "malformed");
        return;
      }

      const identity = getHostIdentity();
      conn.channel = new SealedChannel(new Uint8Array(clientKey), identity.secretKey);
      this.sendPlain(conn, {
        type: "server-hello",
        v: REMOTE_PROTOCOL_VERSION,
        hostPublicKey: identity.publicKeyB64,
        hostName: this.hostName(),
        sessionId: crypto.randomUUID(),
      });
      return;
    }

    // Post-handshake everything must be a sealed envelope. Anything else means
    // a peer that doesn't hold the key, so drop the socket rather than answer.
    if (frame.type !== "sealed" || typeof frame.nonce !== "string" || typeof frame.body !== "string") {
      conn.socket.close(4002, "expected sealed frame");
      return;
    }
    const opened = conn.channel.open(frame.nonce, frame.body);
    if (opened === null) {
      conn.socket.close(4002, "decrypt failed");
      return;
    }

    let inner: ClientFrame;
    try {
      inner = JSON.parse(opened) as ClientFrame;
    } catch {
      conn.socket.close(4002, "malformed");
      return;
    }
    this.handleClientFrame(conn, inner);
  }

  private handleClientFrame(conn: Connection, frame: ClientFrame) {
    if (frame.type === "auth") {
      const device = this.devices.find((d) => tokensMatch(d.token, frame.deviceToken));
      if (!device) {
        this.send(conn, { type: "auth-failed", reason: "unknown-token" });
        conn.socket.close(4003, "unknown token");
        return;
      }
      if (conn.authTimer) {
        clearTimeout(conn.authTimer);
        conn.authTimer = null;
      }
      conn.authed = true;
      conn.deviceId = device.id;
      device.lastSeenAt = Date.now();
      // First successful connect is when we learn what to call this phone; the
      // placeholder name from pairing is replaced here.
      if (frame.deviceName) device.name = frame.deviceName;
      saveDevices(this.devices);
      this.send(conn, { type: "auth-ok", hostName: this.hostName() });
      if (this.host) {
        this.send(conn, { type: "instances", instances: this.host.listInstances() });
      }
      this.notifyStatus();
      return;
    }

    // Everything below requires a completed auth.
    if (!conn.authed) {
      conn.socket.close(4003, "not authenticated");
      return;
    }

    switch (frame.type) {
      case "ping":
        this.send(conn, { type: "pong", at: frame.at });
        return;

      case "list-instances":
        if (this.host) {
          this.send(conn, { type: "instances", instances: this.host.listInstances() });
        }
        return;

      case "subscribe": {
        conn.subscriptions.add(frame.instanceId);
        // Replay the tail first so the phone's terminal isn't blank, then any
        // prompt that's already on screen.
        this.send(conn, {
          type: "snapshot",
          instanceId: frame.instanceId,
          data: outputBuffer.snapshot(frame.instanceId),
        });
        const prompt = this.activePrompts.get(frame.instanceId);
        if (prompt) {
          this.send(conn, {
            type: "prompt-state",
            instanceId: frame.instanceId,
            tool: prompt.tool,
            question: prompt.question,
            options: prompt.options,
          });
        }
        return;
      }

      case "unsubscribe":
        conn.subscriptions.delete(frame.instanceId);
        return;

      case "input":
        this.host?.writeToInstance(frame.instanceId, frame.data);
        return;

      case "prompt":
        this.host?.sendPrompt(frame.instanceId, frame.text);
        return;

      case "choose": {
        const detail = this.activePrompts.get(frame.instanceId);
        const options: PromptOption[] = detail?.options ?? [];
        const keys = keystrokeForOption(frame.optionIndex, options.length);
        if (keys === null) {
          // Either the prompt already cleared or the index doesn't map to a
          // key we trust. Say so instead of firing a guess into the PTY.
          this.send(conn, {
            type: "error",
            message: "That choice is no longer available — use the terminal view.",
          });
          return;
        }
        this.host?.writeToInstance(frame.instanceId, keys);
        return;
      }

      default:
        return;
    }
  }

  private send(conn: Connection, frame: ServerFrame) {
    if (!conn.channel) return;
    if (conn.socket.readyState !== conn.socket.OPEN) return;
    const sealed = conn.channel.seal(JSON.stringify(frame));
    conn.socket.send(JSON.stringify({ type: "sealed", ...sealed }));
  }

  private sendPlain(conn: Connection, frame: unknown) {
    if (conn.socket.readyState !== conn.socket.OPEN) return;
    conn.socket.send(JSON.stringify(frame));
  }
}

export const remoteServer = new RemoteServer();
