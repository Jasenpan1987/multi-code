// Wire protocol between the desktop app and a paired phone.
//
// Transport is a single WebSocket per phone (see main/remote/ws-server.ts). The
// phone reaches the desktop directly — same LAN, or over Tailscale, which gives
// both machines a routable 100.x address without any third-party server in the
// data path. There is no relay: if neither host can see the other, there is no
// connection.
//
// Every frame after the handshake is sealed with NaCl box (Curve25519 +
// XSalsa20-Poly1305), keyed by the desktop keypair whose public key the phone
// pinned at pairing time. The frames below describe the *plaintext* inside that
// seal.

export const REMOTE_PROTOCOL_VERSION = 2;

export const DEFAULT_REMOTE_PORT = 6768;

// ---------------------------------------------------------------------------
// Pairing
// ---------------------------------------------------------------------------

// Encoded into the QR code the desktop shows, as
// `multicode://pair?code=<base64url(JSON)>`. The phone pins `hostPublicKey`
// from this offer, so a later man-in-the-middle can't impersonate the desktop
// even if it learns the endpoint.
export interface PairingOffer {
  v: typeof REMOTE_PROTOCOL_VERSION;
  // Candidate `ws://host:port` endpoints, best-first: Tailscale addresses come
  // before plain LAN ones because they keep working when the phone leaves the
  // house. The phone races them and keeps the first that answers.
  endpoints: string[];
  // Base64 Curve25519 public key of this desktop.
  hostPublicKey: string;
  // Bearer secret minted for this one device; sent on every authenticated
  // frame and revocable from the desktop.
  deviceToken: string;
  // Human-readable desktop name, shown on the phone's device list.
  hostName: string;
}

// ---------------------------------------------------------------------------
// Handshake (plaintext — the only frames not sealed)
// ---------------------------------------------------------------------------

// Phone -> desktop, first frame. Carries the phone's ephemeral public key so
// both sides can derive the shared box key.
export interface ClientHello {
  type: "client-hello";
  v: number;
  clientPublicKey: string;
}

// Desktop -> phone, in reply. `sessionId` only labels the connection for logs.
export interface ServerHello {
  type: "server-hello";
  v: number;
  hostPublicKey: string;
  hostName: string;
  sessionId: string;
}

export interface HandshakeError {
  type: "handshake-error";
  reason: "version" | "malformed";
}

export type HandshakeFrame = ClientHello | ServerHello | HandshakeError;

// ---------------------------------------------------------------------------
// Sealed envelope
// ---------------------------------------------------------------------------

// What actually goes over the wire once the handshake completes: base64 nonce +
// base64 ciphertext. The ciphertext is a JSON-encoded ClientFrame/ServerFrame.
export interface SealedEnvelope {
  type: "sealed";
  nonce: string;
  body: string;
}

// ---------------------------------------------------------------------------
// Phone -> desktop (sealed)
// ---------------------------------------------------------------------------

// Sent once inside the seal to prove device identity. Until the desktop accepts
// an `auth`, every other frame is dropped.
export interface AuthFrame {
  type: "auth";
  deviceToken: string;
  // Free-form label the desktop stores so the user can tell paired phones
  // apart (e.g. "iPhone 16").
  deviceName?: string;
}

// Ask for the instance list. The desktop also pushes `instances` unprompted
// whenever anything changes.
export interface ListInstancesFrame {
  type: "list-instances";
}

// Start mirroring one instance's terminal. The desktop replies with a
// `snapshot` (the current screen, so the phone isn't blank) and then streams
// `output` deltas until `unsubscribe`.
export interface SubscribeFrame {
  type: "subscribe";
  instanceId: string;
  // Phone viewport, so the desktop can hand back a snapshot trimmed to size.
  cols?: number;
  rows?: number;
}

export interface UnsubscribeFrame {
  type: "unsubscribe";
  instanceId: string;
}

// Raw keystrokes for the agent's PTY — this is what makes remote answering work
// at all: the phone is just another keyboard on the same terminal.
export interface InputFrame {
  type: "input";
  instanceId: string;
  data: string;
}

// Send a full prompt as one unit: bracketed paste, then Enter. Mirrors what the
// desktop compose box does, so multi-line answers don't get eaten by the TUI.
export interface PromptFrame {
  type: "prompt";
  instanceId: string;
  text: string;
}

// Answer a detected interactive prompt by index (0-based over the options the
// desktop reported in `prompt-state`). The desktop translates the index into
// the keystrokes the CLI expects, so the phone never hardcodes TUI key bindings.
export interface ChooseFrame {
  type: "choose";
  instanceId: string;
  optionIndex: number;
}

export interface PingFrame {
  type: "ping";
  at: number;
}

export type ClientFrame =
  | AuthFrame
  | ListInstancesFrame
  | SubscribeFrame
  | UnsubscribeFrame
  | InputFrame
  | PromptFrame
  | ChooseFrame
  | PingFrame;

// ---------------------------------------------------------------------------
// Desktop -> phone (sealed)
// ---------------------------------------------------------------------------

export interface AuthOkFrame {
  type: "auth-ok";
  hostName: string;
}

export interface AuthFailedFrame {
  type: "auth-failed";
  reason: "unknown-token" | "revoked";
}

// One entry per instance, mirroring what the desktop contact list shows.
export interface RemoteInstance {
  id: string;
  name: string;
  cwd: string;
  backend: string;
  status: "running" | "stopped";
  // Latest activity signal from the session watcher: "waiting" = turn ended,
  // "prompt" = blocked on an interactive question. Drives the phone's badges.
  activity?: "waiting" | "prompt" | null;
}

export interface InstancesFrame {
  type: "instances";
  instances: RemoteInstance[];
}

// Full current screen for a freshly subscribed instance.
export interface SnapshotFrame {
  type: "snapshot";
  instanceId: string;
  data: string;
}

// Incremental PTY bytes.
export interface OutputFrame {
  type: "output";
  instanceId: string;
  data: string;
}

export interface ActivityFrame {
  type: "activity";
  instanceId: string;
  activity: "waiting" | "prompt";
}

export interface ExitFrame {
  type: "exit";
  instanceId: string;
  code: number;
}

// One line of the readable transcript. This is what the phone shows INSTEAD of
// the terminal by default.
//
// The terminal mirror is unreadable on a phone for reasons that can't be styled
// away: the PTY is 120 columns wide, and the CLIs paint absolutely-positioned
// cells, so there is no reflow to a narrow screen. Rather than shrink an
// unreadable thing, the phone renders the same information from the CLI's own
// structured record (Claude's session JSONL, OpenCode's sqlite), which reflows
// like normal text. The terminal stays available as the fallback.
export interface TranscriptEntry {
  kind: "assistant" | "user" | "tool";
  // For "tool": the tool's name. Omitted otherwise.
  tool?: string;
  // Assistant/user prose, or a one-line summary of what the tool is doing.
  text: string;
  // Set on the tool entry the agent is currently blocked on or running.
  pending?: boolean;
}

export interface TranscriptFrame {
  type: "transcript";
  instanceId: string;
  entries: TranscriptEntry[];
}

// A structured view of an interactive prompt parsed out of the session JSONL.
// `options` is empty for a plain question (free-text answer) and non-empty for
// a choice, in which case the phone renders one button per entry and replies
// with `choose`.
export interface PromptOption {
  label: string;
  description?: string;
}

export interface PromptStateFrame {
  type: "prompt-state";
  instanceId: string;
  // Which tool blocked: "AskUserQuestion", "ExitPlanMode", a permission
  // request, etc. Shown as a heading on the phone.
  tool: string;
  question?: string;
  options: PromptOption[];
}

// The prompt cleared (someone answered, on either side).
export interface PromptClearedFrame {
  type: "prompt-cleared";
  instanceId: string;
}

export interface PongFrame {
  type: "pong";
  at: number;
}

export interface ErrorFrame {
  type: "error";
  message: string;
}

export type ServerFrame =
  | AuthOkFrame
  | AuthFailedFrame
  | InstancesFrame
  | SnapshotFrame
  | OutputFrame
  | ActivityFrame
  | ExitFrame
  | PromptStateFrame
  | PromptClearedFrame
  | TranscriptFrame
  | PongFrame
  | ErrorFrame;

// ---------------------------------------------------------------------------
// Desktop-side state surfaced to the renderer (Toolbox "Phone" section)
// ---------------------------------------------------------------------------

export interface PairedDevice {
  id: string;
  name: string;
  pairedAt: number;
  lastSeenAt: number;
  connected: boolean;
}

// How far an address actually reaches:
//   tailscale — works from anywhere, including cellular
//   lan       — only while the phone is on this same network
//   vpn       — a corporate tunnel; a personal phone can never use it
export type EndpointKind = "tailscale" | "lan" | "vpn";

export interface RemoteEndpoint {
  url: string;
  kind: EndpointKind;
}

export interface RemoteStatus {
  enabled: boolean;
  // Null until the server has actually bound a port.
  port: number | null;
  // Carries the reachability class so the UI can explain, before pairing, why an
  // address won't work from outside — the renderer can't tell from the IP alone.
  endpoints: RemoteEndpoint[];
  devices: PairedDevice[];
  // Set when the server failed to start (e.g. port already in use).
  error?: string;
}
