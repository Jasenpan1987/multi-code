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
  type TranscriptEntry,
} from "../../shared/remote-protocol";
import { SealedChannel, getHostIdentity, mintDeviceToken, tokensMatch } from "./crypto";
import { loadDevices, saveDevices, type StoredDevice } from "./device-store";
import { buildEndpointUrls, buildEndpoints } from "./endpoints";
import { outputBuffer } from "./output-buffer";
import { type PromptDetail } from "./promptExtract";

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
  // Translate an option index into keystrokes using the backend that owns this
  // instance. Must not be done here: the CLIs disagree on which keys select an
  // option, and guessing wrong can confirm the wrong choice.
  keystrokeForChoice: (
    id: string,
    tool: string,
    index: number,
    optionCount: number
  ) => string | null;
  // Reflowable conversation tail, which is what the phone shows instead of the
  // 120-column terminal.
  readTranscript: (id: string, limit: number) => TranscriptEntry[];
}

// How many transcript entries to send. Enough to see how the agent got to where
// it is, few enough to stay a glance rather than a scroll.
const TRANSCRIPT_LIMIT = 40;

// Trailing delay before refreshing a watched instance's transcript. Long enough
// that a fast-scrolling agent costs one file read per second rather than
// thousands, short enough that the summary tracks what's on screen.
const TRANSCRIPT_REFRESH_MS = 1000;

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
  // Latest activity signal per instance. Kept server-side rather than only in
  // the phone's memory so that reopening the app (or a reconnect after a screen
  // lock) still shows which agents are waiting, instead of a clean list that
  // hides a blocked agent.
  private activity = new Map<string, "waiting" | "prompt">();
  // Pending throttled transcript refreshes, one per instance.
  private transcriptTimers = new Map<string, ReturnType<typeof setTimeout>>();

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

    // Swallow socket errors for the whole lifetime of this server, registered
    // BEFORE listening rather than after a successful listen.
    //
    // A failed bind emits `error` more than once: `listen()`'s own rejection is
    // caught below, but the WebSocketServer attached to this http server reacts
    // to the same failure and a second EADDRINUSE lands with no handler
    // attached. An unhandled 'error' on a net.Server is thrown, which in Electron
    // takes down the main process — so leaving another Multi-Code running (or any
    // process on 6768) turned "phone link unavailable" into "the app won't
    // start". Verified by reproducing it against a real occupied port.
    const swallow = () => {};
    server.on("error", swallow);

    const wss = new WebSocketServer({ server });
    wss.on("connection", (socket) => this.handleConnection(socket));
    wss.on("error", swallow);

    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error) => reject(err);
        server.once("error", onError);
        server.listen(port, "0.0.0.0", () => {
          server.removeListener("error", onError);
          resolve();
        });
      });
    } catch (err) {
      wss.close();
      server.close();
      this.startError =
        (err as NodeJS.ErrnoException)?.code === "EADDRINUSE"
          ? `Port ${port} is already in use — another Multi-Code may be running`
          : ((err as Error)?.message ?? "Failed to start");
      return this.getStatus();
    }

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

    for (const timer of this.transcriptTimers.values()) clearTimeout(timer);
    this.transcriptTimers.clear();

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
    let hasWatcher = false;
    for (const conn of this.connections) {
      if (!conn.authed) continue;
      if (!conn.subscriptions.has(instanceId)) continue;
      hasWatcher = true;
      this.send(conn, { type: "output", instanceId, data });
    }
    // Output means the agent is doing something, so the summary someone is
    // reading has gone stale. Refreshed on a trailing timer rather than per
    // chunk: PTY output arrives thousands of times a second, and each refresh
    // re-reads a session file or queries sqlite.
    if (hasWatcher) this.scheduleTranscriptRefresh(instanceId);
  }

  // Current attention state for an instance, used to fill in the instance list
  // so a freshly-opened phone sees badges immediately.
  activityFor(instanceId: string): "waiting" | "prompt" | null {
    return this.activity.get(instanceId) ?? null;
  }

  broadcastActivity(
    instanceId: string,
    activity: string,
    detail?: PromptDetail
  ) {
    if (activity === "prompt-cleared") {
      this.activePrompts.delete(instanceId);
      this.activity.delete(instanceId);
      this.broadcast({ type: "prompt-cleared", instanceId });
      // The badge lives on the instance list, so that has to be resent too.
      this.broadcastInstances();
      return;
    }

    if (activity !== "waiting" && activity !== "prompt") return;
    this.activity.set(instanceId, activity);
    this.broadcast({ type: "activity", instanceId, activity });
    // The agent just changed state, so whoever is watching wants the updated
    // summary, not the one from when they subscribed.
    this.broadcastTranscript(instanceId);

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
    this.broadcastInstances();
  }

  // Called when the user acts at the desk, so a phone's badge doesn't stay lit
  // for something already handled.
  clearActivity(instanceId: string) {
    if (!this.activity.has(instanceId) && !this.activePrompts.has(instanceId)) {
      return;
    }
    this.activity.delete(instanceId);
    this.activePrompts.delete(instanceId);
    this.broadcast({ type: "prompt-cleared", instanceId });
    this.broadcastInstances();
  }

  broadcastExit(instanceId: string, code: number) {
    this.activePrompts.delete(instanceId);
    this.activity.delete(instanceId);
    this.clearTranscriptTimer(instanceId);
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
        // Send the readable transcript first: it's what the phone shows by
        // default, so it should be populated before the terminal replay.
        this.sendTranscript(conn, frame.instanceId);
        // Replay the tail so the terminal fallback isn't blank when opened, then
        // any prompt that's already on screen.
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
        const keys = detail
          ? this.host?.keystrokeForChoice(
              frame.instanceId,
              detail.tool,
              frame.optionIndex,
              options.length
            ) ?? null
          : null;
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

  private sendTranscript(conn: Connection, instanceId: string) {
    if (!this.host) return;
    let entries: TranscriptEntry[];
    try {
      entries = this.host.readTranscript(instanceId, TRANSCRIPT_LIMIT);
    } catch {
      // A session file that isn't readable yet shouldn't break subscribing; the
      // terminal view still works.
      return;
    }
    if (entries.length === 0) return;
    this.send(conn, { type: "transcript", instanceId, entries });
  }

  // Push a refreshed transcript to everyone watching this instance. Called when
  // the agent's state changes, so the phone's summary doesn't go stale while the
  // terminal keeps streaming.
  private broadcastTranscript(instanceId: string) {
    this.clearTranscriptTimer(instanceId);
    for (const conn of this.connections) {
      if (!conn.authed) continue;
      if (!conn.subscriptions.has(instanceId)) continue;
      this.sendTranscript(conn, instanceId);
    }
  }

  // Coalesce a burst of PTY output into one refresh. A single timer per instance,
  // not reset on every chunk, so a continuously-streaming agent still refreshes
  // at a steady cadence instead of never (which is what resetting would cause).
  private scheduleTranscriptRefresh(instanceId: string) {
    if (this.transcriptTimers.has(instanceId)) return;
    const timer = setTimeout(() => {
      this.transcriptTimers.delete(instanceId);
      this.broadcastTranscript(instanceId);
    }, TRANSCRIPT_REFRESH_MS);
    // Don't let a pending refresh hold the process open at quit time.
    timer.unref?.();
    this.transcriptTimers.set(instanceId, timer);
  }

  private clearTranscriptTimer(instanceId: string) {
    const timer = this.transcriptTimers.get(instanceId);
    if (timer) {
      clearTimeout(timer);
      this.transcriptTimers.delete(instanceId);
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
