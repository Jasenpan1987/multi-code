// The desktop half of the phone link.
//
// One HTTP server on port 6768 serving two things:
//   - the mobile web client (a static bundle, so the phone needs no install)
//   - a WebSocket endpoint carrying the sealed frame protocol
//
// Both live on the same port so one origin covers both. Bound to 127.0.0.1 only: the
// phone reaches it through `tailscale serve`, which terminates HTTPS on
// `https://<machine>.<tailnet>.ts.net` and proxies to this port (tailscale.ts), so
// nothing on the LAN or the tailnet can reach the port itself (PRD Story 1). Access
// control on top of that is the device token plus the NaCl seal.

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
  type AckFrame,
  type AckRefusal,
  type ClientFrame,
  type PairedDevice,
  type PairingOffer,
  type PromptStateFrame,
  type RemoteChoice,
  type RemoteDialog,
  type RemoteInstance,
  type RemotePushSubscription,
  type RemoteStatus,
  type ServerFrame,
  type TranscriptEntry,
} from "../../shared/remote-protocol";
import { SealedChannel, getHostIdentity, mintDeviceToken, tokensMatch } from "./crypto";
import { loadDevices, saveDevices, type StoredDevice } from "./device-store";
import { outputBuffer } from "./output-buffer";
import { ChecksCache, type RemoteChecker } from "./tailscale";
import {
  declarativePayload,
  loadVapidKeys,
  sendPush,
  topicOf,
  type PushResult,
  type VapidKeys,
} from "./push";
import type { RemoteHttpsSetup, RemoteTestPush } from "../../shared/types";

// A phone that never completes its handshake + auth in this window gets dropped,
// so a port scanner can't hold sockets open.
const AUTH_TIMEOUT_MS = 10_000;

// An authenticated phone pings every 15 s while it is visible; one that has sent
// nothing for this long is gone (iOS leaves half-open sockets after a lock), and its
// socket is closed so it no longer counts as connected.
const HEARTBEAT_TIMEOUT_MS = 45_000;

// How many acks are kept per device, so a frame resent after a reconnect gets the
// ack it already had instead of being acted on again. In memory: a desktop restart
// forgets them, and the phone resends only what it never saw acked.
const ACKS_KEPT = 200;

// What a subscribe gets when it doesn't say how many turns.
const DEFAULT_TURNS = 10;

// A phone with the app open pings every 15 s and is answered within 5; one that has
// sent nothing for longer isn't looking, whatever its socket says. It gets the push:
// a lock can leave a socket half-open until HEARTBEAT_TIMEOUT_MS, which is too long
// to go without one.
const LOOKING_MS = 20_000;

// A push's lines, at most (Story 7). Well inside the 4 KB a push may carry.
const PUSH_TITLE_CHARS = 120;
const PUSH_BODY_CHARS = 180;

// At most this often per instance, the list's line for a working agent is
// refreshed from its transcript, and only while a phone is connected to see it.
const PREVIEW_REFRESH_MS = 5000;

// The size a terminal is drawn at when its PTY's isn't known (not running): the
// size every PTY starts at.
const DEFAULT_PTY_SIZE = { cols: 120, rows: 30 };

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
  ".webmanifest": "application/manifest+json; charset=utf-8",
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
  // Instances this phone is mirroring, with how many turns of transcript it asked
  // for. Output for anything else is not sent.
  subscriptions: Map<string, number>;
  authTimer: ReturnType<typeof setTimeout> | null;
  // Re-armed by every frame once authed; see HEARTBEAT_TIMEOUT_MS.
  heartbeat: ReturnType<typeof setTimeout> | null;
  // When the phone last sent anything (ms); see LOOKING_MS.
  heardAt: number;
}

// How the desktop answered a frame carrying a `clientMsgId`, before it becomes an
// `ack`.
export type HostAck = { ok: true } | { ok: false; reason: AckRefusal; message: string };

// The dialog an instance is stopped on, as `prompt-state` carries it.
export interface LiveDialog {
  seq: number;
  summary: string;
  dialog?: RemoteDialog;
}

// What the server needs from the rest of the app, in the protocol's own terms.
// Injected rather than imported so this module stays testable and doesn't reach
// into process-manager directly; remote/remote-host.ts is the desktop's.
export interface RemoteHost {
  // The phone's list: every instance but the Manager, with its state and one line.
  // Runs on every broadcast, so it reads nothing from disk.
  listInstances: () => RemoteInstance[];
  // The dialog the instance is stopped on, or null.
  liveDialog: (id: string) => LiveDialog | null;
  // A phone opened the instance: Finished becomes Idle.
  markSeen: (id: string) => void;
  // The last `turns` turns of the reflowable transcript, which is what the phone
  // shows instead of the 120-column terminal.
  readTranscript: (
    id: string,
    turns: number
  ) => { entries: TranscriptEntry[]; hasEarlier: boolean };
  // The PTY's size, or null when it isn't running.
  ptySize: (id: string) => { cols: number; rows: number } | null;
  // The instance streams output and a phone is connected: refresh the list's line
  // if a turn runs. Throttled here (PREVIEW_REFRESH_MS); the host pushes
  // `broadcastInstances` itself when the line changed.
  refreshPreview: (id: string) => void;
  // Raw keys from the terminal fallback, as given.
  writeToInstance: (id: string, data: string) => void;
  // A message from the compose box, as one paste + Enter.
  sendPrompt: (id: string, text: string) => Promise<HostAck>;
  // Answer the dialog `seq` names, whole.
  answer: (id: string, seq: number, choice: RemoteChoice, confirmed: boolean) => Promise<HostAck>;
  // Stop the running turn.
  interrupt: (id: string) => Promise<HostAck>;
}

export interface RemoteServerOptions {
  heartbeatTimeoutMs?: number;
}

// A session finished or needs the builder (remote-host.ts): what its push says. The
// server adds where tapping it goes and sends it to every phone that isn't looking.
export interface SessionPush {
  instanceId: string;
  // `<name> · Needs you` / `<name> · Finished`.
  title: string;
  // The list row's line: what the dialog asks, or the conclusion's first sentence.
  body?: string;
  // How many sessions need the builder now: the Home Screen icon's number.
  badge: number;
}

// Trailing delay before refreshing a watched instance's transcript. Long enough
// that a fast-scrolling agent costs one file read per second rather than
// thousands, short enough that the summary tracks what's on screen.
const TRANSCRIPT_REFRESH_MS = 1000;

function ackFrame(clientMsgId: string, result: HostAck): AckFrame {
  return result.ok
    ? { type: "ack", clientMsgId, ok: true }
    : { type: "ack", clientMsgId, ok: false, reason: result.reason, message: result.message };
}

const MALFORMED: HostAck = { ok: false, reason: "failed", message: "Malformed frame" };

export class RemoteServer {
  private httpServer: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private connections = new Set<Connection>();
  private devices: StoredDevice[] = loadDevices();
  private port: number | null = null;
  private startError: string | undefined;
  private host: RemoteHost | null = null;
  private onStatusChange: (() => void) | null = null;
  // Told each session a phone has just read, so the desk counts it read too
  // (index.ts): opened, or shown again after the phone went quiet.
  private onRead: ((instanceId: string) => void) | null = null;
  // Pending throttled transcript refreshes, one per instance.
  private transcriptTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // Tailscale and HTTPS, checked in the background while listening; a change is
  // pushed like any other status change.
  private checks = new ChecksCache(() => this.notifyStatus());
  // When each instance's list line was last refreshed (PREVIEW_REFRESH_MS).
  private previewRefreshedAt = new Map<string, number>();
  // Per device, the ack of each frame it sent, by clientMsgId, oldest first: settled,
  // or still being worked on (an answer takes seconds of measured key gaps).
  private acks = new Map<string, Map<string, Promise<AckFrame>>>();
  // The list as last broadcast. One change is often reported several ways at once
  // (the event, the agent's working flag, the refreshed line), and a phone needs
  // the list again only when it differs. Forgotten whenever a phone is sent the list
  // directly, so the next change reaches every phone whatever it was last sent.
  private lastInstances = "";
  // The VAPID keypair once loaded (push.ts), or why it couldn't be.
  private vapid: VapidKeys | null = null;
  private vapidError = "";
  // Per device, the push being sent to it, so the next one goes after it: a session's
  // older push must never land after its newer one, which it would replace.
  private pushQueues = new Map<string, Promise<unknown>>();
  private readonly heartbeatTimeoutMs: number;

  constructor(options: RemoteServerOptions = {}) {
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? HEARTBEAT_TIMEOUT_MS;
  }

  setHost(host: RemoteHost) {
    this.host = host;
  }

  // What reads Tailscale's state. Until one is set nothing is known and no pairing
  // offer is made: remote/index.ts sets the real one; tests and the phone harness set
  // their own (the harness's says ready at `http://127.0.0.1:<port>`).
  setChecker(checker: RemoteChecker) {
    this.checks.setChecker(checker);
  }

  setStatusListener(listener: () => void) {
    this.onStatusChange = listener;
  }

  setReadListener(listener: (instanceId: string) => void) {
    this.onRead = listener;
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
        server.listen(port, "127.0.0.1", () => {
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
    // Waited for, so the status this returns (the Phone section's toggle shows it)
    // already says what is missing. Bounded by the CLI's timeouts.
    await this.checks.watch(this.port);
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
    this.checks.unwatch();
    this.previewRefreshedAt.clear();
    this.lastInstances = "";

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
  // is visible and revocable in the desktop UI. Null unless HTTPS is ready: the
  // origin is the only address the phone gets, and a pairing to an origin that
  // doesn't answer is a phone that can't connect. `deviceId` is that row's id, so the
  // Phone section can revoke a code it replaces (it never goes in the offer).
  createPairingOffer(): { offer: PairingOffer; deviceId: string } | null {
    const https = this.checks.current().https;
    if (!this.port || https.state !== "ready") return null;

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
      offer: {
        v: REMOTE_PROTOCOL_VERSION,
        origin: https.origin,
        hostPublicKey: identity.publicKeyB64,
        deviceToken: token,
        hostName: this.hostName(),
      },
      deviceId: device.id,
    };
  }

  // "New code" with the code it replaces: revoked only while no phone has used it
  // (never heard from, no socket authenticated with it), checked and done in one
  // step, so a phone that pairs with it a moment earlier keeps its row. True when
  // it was revoked.
  revokeUnusedDevice(deviceId: string): boolean {
    const device = this.devices.find((d) => d.id === deviceId);
    if (!device || device.lastSeenAt !== 0) return false;
    if ([...this.connections].some((c) => c.authed && c.deviceId === deviceId)) return false;
    this.revokeDevice(deviceId);
    return true;
  }

  revokeDevice(deviceId: string) {
    this.devices = this.devices.filter((d) => d.id !== deviceId);
    saveDevices(this.devices);
    this.acks.delete(deviceId);
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
    // First: a new pair forgets the subscriptions listed below (vapidKeys).
    const vapid = this.vapidKeys();
    const connectedIds = new Set(
      [...this.connections].filter((c) => c.authed).map((c) => c.deviceId)
    );
    const devices: PairedDevice[] = this.devices.map((d) => ({
      id: d.id,
      name: d.name,
      pairedAt: d.pairedAt,
      lastSeenAt: d.lastSeenAt,
      connected: connectedIds.has(d.id),
      pushEnabled: !!d.push,
      ...(d.lastPushError ? { lastPushError: d.lastPushError } : {}),
    }));
    return {
      enabled: this.httpServer !== null,
      port: this.port,
      checks: {
        ...this.checks.current(),
        push: vapid ? { state: "ready" } : { state: "error", detail: this.vapidError },
      },
      devices,
      error: this.startError,
    };
  }

  // A status request from the Phone section: the cached status now, and the checks
  // refreshed behind it (at most every 5 s), a change arriving as a status push.
  requestStatus(): RemoteStatus {
    void this.checks.refresh();
    return this.getStatus();
  }

  // The Phone section's "Set up HTTPS": runs the serve command if, checked again
  // first, nothing serves port 443 yet, then checks again.
  async setUpHttps(): Promise<RemoteHttpsSetup> {
    const { error } = await this.checks.setUpHttps();
    return { status: this.getStatus(), ...(error ? { error } : {}) };
  }

  // -------------------------------------------------------------------------
  // Web Push (Story 7)
  // -------------------------------------------------------------------------

  // A session finished or needs the builder: push it to every subscribed phone that
  // isn't looking (one with the app open shows the change itself). Returns at once;
  // the sends run behind it and never throw, so the activity that raised this can't
  // be held up or broken by a push service. Nothing is sent until HTTPS is ready: the
  // origin is both where tapping the push goes and the VAPID subject, and no phone
  // could have subscribed without it.
  pushSession(push: SessionPush): void {
    const origin = this.httpsOrigin();
    const keys = this.vapidKeys();
    if (!origin || !keys) return;
    const payload = declarativePayload({
      title: clip(push.title, PUSH_TITLE_CHARS),
      body: push.body ? clip(push.body, PUSH_BODY_CHARS) : undefined,
      navigate: `${origin}/#/s/${encodeURIComponent(push.instanceId)}`,
      tag: push.instanceId,
      badge: push.badge,
    });
    const topic = topicOf(push.instanceId);
    for (const device of this.devices) {
      if (!device.push || this.isLooking(device.id)) continue;
      void this.deliver(device.id, payload, { keys, subject: origin, topic });
    }
  }

  // The Phone section's "Send test": one push to that phone, open or not, saying
  // whether it went. Its outcome is recorded like any other push's.
  async sendTestPush(deviceId: string): Promise<RemoteTestPush> {
    const device = this.devices.find((d) => d.id === deviceId);
    if (!device) return { ok: false, error: "This phone isn't paired any more." };
    if (!device.push) return { ok: false, error: "Notifications are off on this phone. Turn them on in its app." };
    if (!this.httpServer) return { ok: false, error: "Turn the phone link on first." };
    const origin = this.httpsOrigin();
    if (!origin) return { ok: false, error: "HTTPS isn't set up yet." };
    const keys = this.vapidKeys();
    if (!keys) return { ok: false, error: this.vapidError };
    const payload = declarativePayload({
      title: "Multi-Code · Test",
      body: "Notifications from this Mac work.",
      navigate: `${origin}/#/`,
      tag: "multi-code-test",
    });
    const result = await this.deliver(deviceId, payload, { keys, subject: origin });
    if (result.ok) return { ok: true };
    if (result.gone) {
      return { ok: false, error: "This phone's subscription has expired. Open the app on it to turn notifications on again." };
    }
    return { ok: false, error: result.error };
  }

  private httpsOrigin(): string | null {
    const https = this.checks.current().https;
    return https.state === "ready" ? https.origin : null;
  }

  // Loaded once, on first need. A new pair means every stored subscription was made
  // for a key that no longer exists, so they go, and each phone subscribes again on
  // its next launch (auth-ok says pushEnabled false). Until a pair loads, every call
  // tries again: the folder may be writable by then.
  private vapidKeys(): VapidKeys | null {
    if (this.vapid) return this.vapid;
    const loaded = loadVapidKeys();
    if (!loaded.ok) {
      this.vapidError = loaded.error;
      return null;
    }
    this.vapid = loaded.keys;
    this.vapidError = "";
    if (loaded.created && this.devices.some((d) => d.push)) {
      for (const device of this.devices) {
        delete device.push;
        delete device.lastPushError;
      }
      this.saveDevicesSafely();
    }
    return this.vapid;
  }

  // See LOOKING_MS.
  private isLooking(deviceId: string): boolean {
    const now = Date.now();
    for (const conn of this.connections) {
      if (conn.deviceId === deviceId && looking(conn, now)) return true;
    }
    return false;
  }

  // A phone with the app open is showing this instance: whatever it reports now is
  // read there as it lands, and the desk doesn't count it (process-manager.ts,
  // reportActivity).
  isReading(instanceId: string): boolean {
    const now = Date.now();
    for (const conn of this.connections) {
      if (conn.subscriptions.has(instanceId) && looking(conn, now)) return true;
    }
    return false;
  }

  // Send to the device's subscription as it is now, after whatever is being sent to
  // it already, and record the outcome.
  private deliver(
    deviceId: string,
    payload: string,
    options: { keys: VapidKeys; subject: string; topic?: string }
  ): Promise<PushResult> {
    const send = async (): Promise<PushResult> => {
      // The phone link was turned off while an earlier push to this phone was going out.
      if (!this.httpServer) return { ok: false, gone: false, error: "The phone link is off." };
      // Turned off, or the phone revoked, meanwhile.
      const subscription = this.devices.find((d) => d.id === deviceId)?.push;
      if (!subscription) return { ok: false, gone: false, error: "Notifications are off on this phone." };
      const result = await sendPush(subscription, payload, options);
      this.recordPush(deviceId, subscription.endpoint, result);
      return result;
    };
    const sent = (this.pushQueues.get(deviceId) ?? Promise.resolve()).then(send).catch(
      (err: Error): PushResult => ({ ok: false, gone: false, error: `Couldn't send it: ${err?.message ?? err}` })
    );
    this.pushQueues.set(deviceId, sent);
    void sent.then(() => {
      if (this.pushQueues.get(deviceId) === sent) this.pushQueues.delete(deviceId);
    });
    return sent;
  }

  // 404/410: the subscription is gone, so it is deleted (push off for that phone until
  // it subscribes again). Any other failure is kept on the device until a push to it
  // works. Only for the subscription the push went to: one the phone replaced while it
  // was in flight is the phone's newer word, and a revoked phone has no row.
  private recordPush(deviceId: string, endpoint: string, result: PushResult) {
    const device = this.devices.find((d) => d.id === deviceId);
    if (!device || device.push?.endpoint !== endpoint) return;
    if (result.ok) {
      if (device.lastPushError === undefined) return;
      delete device.lastPushError;
    } else if (result.gone) {
      delete device.push;
      delete device.lastPushError;
    } else {
      if (device.lastPushError === result.error) return;
      device.lastPushError = result.error;
    }
    this.saveDevicesSafely();
    this.notifyStatus();
  }

  // A phone's `push-subscribe`. Sent again on every launch, so an unchanged one
  // writes nothing. A new subscription starts with no error: the last one was about
  // the subscription it replaces. Undone when it can't be saved, and the ack says so:
  // the phone sends it again, and that one must be saved rather than found unchanged.
  private setPushSubscription(deviceId: string | null, subscription: RemotePushSubscription | null) {
    const device = this.devices.find((d) => d.id === deviceId);
    if (!device) return;
    if (JSON.stringify(device.push ?? null) === JSON.stringify(subscription)) return;
    const { push, lastPushError } = device;
    if (subscription) device.push = subscription;
    else delete device.push;
    delete device.lastPushError;
    try {
      saveDevices(this.devices);
    } catch (err) {
      if (push) device.push = push;
      else delete device.push;
      if (lastPushError !== undefined) device.lastPushError = lastPushError;
      throw err;
    }
    this.notifyStatus();
  }

  // From a push's outcome, which must not throw: the change stays in memory, and
  // is written with the next save that works.
  private saveDevicesSafely() {
    try {
      saveDevices(this.devices);
    } catch {
      // See above.
    }
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
    let phones = false;
    let hasWatcher = false;
    for (const conn of this.connections) {
      if (!conn.authed) continue;
      phones = true;
      if (!conn.subscriptions.has(instanceId)) continue;
      hasWatcher = true;
      this.send(conn, { type: "output", instanceId, data });
    }
    // Output means the agent is doing something, so the summary someone is
    // reading has gone stale. Refreshed on a trailing timer rather than per
    // chunk: PTY output arrives thousands of times a second, and each refresh
    // re-reads a session file or queries sqlite.
    if (hasWatcher) this.scheduleTranscriptRefresh(instanceId);
    // And the tool a working agent is on may have changed, which the list shows.
    if (phones) this.refreshPreview(instanceId);
  }

  // The desktop resized the instance's PTY: a phone's terminal follows it.
  broadcastResize(instanceId: string, cols: number, rows: number) {
    this.toSubscribers(instanceId, { type: "resize", instanceId, cols, rows });
  }

  // The instance is stopped on a dialog: it opened, or the agent restated it.
  broadcastPromptState(instanceId: string) {
    const frame = this.promptStateFrame(instanceId);
    if (frame) this.broadcast(frame);
  }

  // The dialog `seq` named closed: answered on either side, or the instance stopped.
  broadcastPromptCleared(instanceId: string, seq: number) {
    this.broadcast({ type: "prompt-cleared", instanceId, seq });
  }

  broadcastExit(instanceId: string, code: number) {
    this.clearTranscriptTimer(instanceId);
    this.previewRefreshedAt.delete(instanceId);
    outputBuffer.clear(instanceId);
    this.broadcast({ type: "exit", instanceId, code });
    this.broadcastInstances();
  }

  broadcastInstances() {
    if (!this.host || !this.hasPhones()) return;
    const instances = this.host.listInstances();
    const json = JSON.stringify(instances);
    if (json === this.lastInstances) return;
    this.lastInstances = json;
    this.broadcast({ type: "instances", instances });
  }

  // Push a refreshed transcript to everyone watching this instance. Called when
  // the agent's state changes, so the phone's summary doesn't go stale while the
  // terminal keeps streaming.
  broadcastTranscript(instanceId: string) {
    this.clearTranscriptTimer(instanceId);
    for (const conn of this.connections) {
      if (!conn.authed) continue;
      const turns = conn.subscriptions.get(instanceId);
      if (turns === undefined) continue;
      this.sendTranscript(conn, instanceId, turns);
    }
  }

  private sendInstances(conn: Connection) {
    if (!this.host) return;
    this.lastInstances = "";
    this.send(conn, { type: "instances", instances: this.host.listInstances() });
  }

  private hasPhones(): boolean {
    for (const conn of this.connections) if (conn.authed) return true;
    return false;
  }

  private refreshPreview(instanceId: string) {
    const now = Date.now();
    if (now - (this.previewRefreshedAt.get(instanceId) ?? 0) < PREVIEW_REFRESH_MS) return;
    this.previewRefreshedAt.set(instanceId, now);
    this.host?.refreshPreview(instanceId);
  }

  private promptStateFrame(instanceId: string): PromptStateFrame | null {
    const live = this.host?.liveDialog(instanceId);
    if (!live) return null;
    return {
      type: "prompt-state",
      instanceId,
      seq: live.seq,
      summary: live.summary,
      ...(live.dialog ? { dialog: live.dialog } : {}),
    };
  }

  private toSubscribers(instanceId: string, frame: ServerFrame) {
    for (const conn of this.connections) {
      if (conn.authed && conn.subscriptions.has(instanceId)) this.send(conn, frame);
    }
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
    // Every file is checked with the server on every load (`no-cache`), and the
    // tag makes that check a 304 when nothing changed. The files keep fixed names
    // across builds (bundle.js, sw.js), so a cached copy must never outlive one:
    // index.html and a stale bundle.js would not match, and a stale sw.js would
    // keep the phone on an old build. Offline starts come from the service
    // worker's own cache, not the HTTP cache.
    const etag = `W/"${stat.size.toString(16)}-${Math.trunc(stat.mtimeMs).toString(16)}"`;
    const headers = { "cache-control": "no-cache", etag };
    if (req.headers["if-none-match"] === etag) {
      res.writeHead(304, headers).end();
      return;
    }
    res.writeHead(200, {
      ...headers,
      "content-type": type,
      "content-length": stat.size,
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
      subscriptions: new Map(),
      authTimer: null,
      heartbeat: null,
      heardAt: Date.now(),
    };
    this.connections.add(conn);

    conn.authTimer = setTimeout(() => {
      if (!conn.authed) socket.close(4001, "auth timeout");
    }, AUTH_TIMEOUT_MS);

    const stopTimers = () => {
      if (conn.authTimer) clearTimeout(conn.authTimer);
      if (conn.heartbeat) clearTimeout(conn.heartbeat);
    };
    socket.on("message", (raw) => {
      conn.heartbeat?.refresh();
      // Heard from again on the same socket after going quiet past LOOKING_MS (a
      // page shown again without a hidden event first, or a gap in the network): it
      // is looking again, and what was sent to it meanwhile has reached it, so its
      // open session is read now, as on a subscribe.
      const now = Date.now();
      const resumed = conn.authed && this.connections.has(conn) && now - conn.heardAt >= LOOKING_MS;
      conn.heardAt = now;
      if (resumed) for (const id of conn.subscriptions.keys()) this.onRead?.(id);
      // Anything a frame's handling throws would surface as an uncaught exception in
      // the main process, and before auth anyone who reaches the port can send one.
      try {
        this.handleMessage(conn, raw.toString());
      } catch {
        conn.socket.close(4002, "malformed");
      }
    });
    socket.on("close", () => {
      stopTimers();
      this.connections.delete(conn);
      this.rememberSeen(conn);
      this.notifyStatus();
    });
    socket.on("error", () => {
      stopTimers();
      this.connections.delete(conn);
    });
  }

  // A phone's socket went: it was last seen when it was last heard from, not when it
  // authenticated, or a phone that had the app open for an hour would read as seen an
  // hour ago. Nothing to keep for a socket that never authenticated, or a phone revoked.
  private rememberSeen(conn: Connection) {
    const device = conn.authed ? this.devices.find((d) => d.id === conn.deviceId) : undefined;
    if (!device || device.lastSeenAt >= conn.heardAt) return;
    device.lastSeenAt = conn.heardAt;
    this.saveDevicesSafely();
  }

  // Nothing from this phone for HEARTBEAT_TIMEOUT_MS. It stops counting as connected
  // at once; the close frame goes to a peer that is most likely gone, so the socket
  // is torn down shortly after rather than when the OS notices.
  private dropSilent(conn: Connection) {
    if (!this.connections.delete(conn)) return;
    conn.socket.close(4004, "heartbeat timeout");
    setTimeout(() => conn.socket.terminate(), 1000).unref?.();
    this.notifyStatus();
  }

  private handleMessage(conn: Connection, raw: string) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      conn.socket.close(4002, "malformed");
      return;
    }
    if (typeof parsed !== "object" || parsed === null) {
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

    let inner: unknown;
    try {
      inner = JSON.parse(opened);
    } catch {
      conn.socket.close(4002, "malformed");
      return;
    }
    if (typeof inner !== "object" || inner === null) {
      conn.socket.close(4002, "malformed");
      return;
    }
    this.handleClientFrame(conn, inner as ClientFrame);
  }

  private handleClientFrame(conn: Connection, frame: ClientFrame) {
    if (frame.type === "auth") {
      const token: unknown = frame.deviceToken;
      const device =
        typeof token === "string" ? this.devices.find((d) => tokensMatch(d.token, token)) : undefined;
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
      // Once per socket: a second auth must not leave the first timer running.
      if (!conn.heartbeat) {
        conn.heartbeat = setTimeout(() => this.dropSilent(conn), this.heartbeatTimeoutMs);
        conn.heartbeat.unref?.();
      }
      device.lastSeenAt = Date.now();
      // First successful connect is when we learn what to call this phone; the
      // placeholder name from pairing is replaced here.
      if (typeof frame.deviceName === "string" && frame.deviceName) device.name = frame.deviceName;
      saveDevices(this.devices);
      // Before `device.push` is read: a new pair forgets every subscription.
      const vapid = this.vapidKeys();
      this.send(conn, {
        type: "auth-ok",
        hostName: this.hostName(),
        // Empty when the keys couldn't be loaded: the phone can't subscribe then, and
        // the Phone section says why (checks.push).
        vapidPublicKey: vapid?.publicKey ?? "",
        pushEnabled: !!device.push,
      });
      this.sendInstances(conn);
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
        this.sendInstances(conn);
        return;

      case "subscribe": {
        if (typeof frame.instanceId !== "string") return;
        const id = frame.instanceId;
        const turns =
          Number.isInteger(frame.turns) && (frame.turns as number) > 0
            ? (frame.turns as number)
            : DEFAULT_TURNS;
        conn.subscriptions.set(id, turns);
        this.host?.markSeen(id);
        // Opened on the phone is read, on the desk too: its red dot goes out.
        this.onRead?.(id);
        // Send the readable transcript first: it's what the phone shows by
        // default, so it should be populated before the terminal replay.
        this.sendTranscript(conn, id, turns);
        // Replay the tail so the terminal fallback isn't blank when opened, at the
        // width the CLI painted it for, then any dialog that's already open.
        const size = this.host?.ptySize(id) ?? DEFAULT_PTY_SIZE;
        this.send(conn, { type: "snapshot", instanceId: id, data: outputBuffer.snapshot(id), ...size });
        const prompt = this.promptStateFrame(id);
        if (prompt) this.send(conn, prompt);
        return;
      }

      case "unsubscribe":
        conn.subscriptions.delete(frame.instanceId);
        return;

      case "input":
        if (typeof frame.instanceId !== "string" || typeof frame.data !== "string") return;
        this.host?.writeToInstance(frame.instanceId, frame.data);
        return;

      case "prompt":
        this.acked(conn, frame.clientMsgId, async () => {
          if (!this.host) return MALFORMED;
          if (typeof frame.instanceId !== "string" || typeof frame.text !== "string") return MALFORMED;
          return this.host.sendPrompt(frame.instanceId, frame.text);
        });
        return;

      case "answer":
        this.acked(conn, frame.clientMsgId, async () => {
          if (!this.host) return MALFORMED;
          if (
            typeof frame.instanceId !== "string" ||
            typeof frame.seq !== "number" ||
            typeof frame.choice !== "object" ||
            frame.choice === null
          ) {
            return MALFORMED;
          }
          return this.host.answer(frame.instanceId, frame.seq, frame.choice, frame.confirmed === true);
        });
        return;

      case "interrupt":
        this.acked(conn, frame.clientMsgId, async () => {
          if (!this.host) return MALFORMED;
          if (typeof frame.instanceId !== "string") return MALFORMED;
          return this.host.interrupt(frame.instanceId);
        });
        return;

      case "push-subscribe":
        this.acked(conn, frame.clientMsgId, async () => {
          const subscription = subscriptionOf(frame.subscription);
          if (subscription === undefined) return MALFORMED;
          this.setPushSubscription(conn.deviceId, subscription);
          return { ok: true };
        });
        return;

      default:
        return;
    }
  }

  // Run a frame that carries a `clientMsgId` once per device, and ack it. A resend
  // (the phone resends `prompt` and `push-subscribe` until acked, on a new socket
  // after a reconnect) gets the ack the first one got, or waits for it while that one
  // is still being worked on, and is not acted on again. A frame without an id can't
  // be acked, and so isn't acted on either.
  private acked(conn: Connection, clientMsgId: unknown, act: () => Promise<HostAck>) {
    if (typeof clientMsgId !== "string" || !clientMsgId || !conn.deviceId) return;
    let acks = this.acks.get(conn.deviceId);
    if (!acks) {
      acks = new Map();
      this.acks.set(conn.deviceId, acks);
    }
    let ack = acks.get(clientMsgId);
    if (!ack) {
      ack = act()
        .catch((): HostAck => ({ ok: false, reason: "failed", message: "Something went wrong on the Mac" }))
        .then((result) => ackFrame(clientMsgId, result));
      acks.set(clientMsgId, ack);
      if (acks.size > ACKS_KEPT) {
        const oldest = acks.keys().next().value;
        if (oldest !== undefined) acks.delete(oldest);
      }
    }
    void ack.then((frame) => this.send(conn, frame));
  }

  private sendTranscript(conn: Connection, instanceId: string, turns: number) {
    if (!this.host) return;
    let read: { entries: TranscriptEntry[]; hasEarlier: boolean };
    try {
      read = this.host.readTranscript(instanceId, turns);
    } catch {
      // A session file that isn't readable yet shouldn't break subscribing; the
      // terminal view still works.
      return;
    }
    this.send(conn, { type: "transcript", instanceId, ...read });
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

// An authenticated phone, still open and heard from lately; see LOOKING_MS.
function looking(conn: Connection, now: number): boolean {
  return conn.authed && conn.socket.readyState === conn.socket.OPEN && now - conn.heardAt < LOOKING_MS;
}

// The phone's `PushSubscription.toJSON()` as stored: only the fields Web Push uses,
// and only an https endpoint (every push service's is). Null turns push off;
// undefined is a malformed frame.
function subscriptionOf(value: unknown): RemotePushSubscription | null | undefined {
  if (value === null) return null;
  if (typeof value !== "object") return undefined;
  const { endpoint, expirationTime, keys } = value as Record<string, unknown>;
  if (typeof endpoint !== "string") return undefined;
  try {
    if (new URL(endpoint).protocol !== "https:") return undefined;
  } catch {
    return undefined;
  }
  const { p256dh, auth } = (typeof keys === "object" && keys !== null ? keys : {}) as Record<string, unknown>;
  if (typeof p256dh !== "string" || !p256dh || typeof auth !== "string" || !auth) return undefined;
  return {
    endpoint,
    ...(typeof expirationTime === "number" ? { expirationTime } : {}),
    keys: { p256dh, auth },
  };
}

// At most `max` characters, by code point, so a cut never splits one.
function clip(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : text;
}

export const remoteServer = new RemoteServer();
