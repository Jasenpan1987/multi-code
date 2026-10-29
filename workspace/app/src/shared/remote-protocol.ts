// Wire protocol between the desktop app and a paired phone (mobile-v2).
//
// Transport is a single WebSocket per phone (see main/remote/ws-server.ts), on the
// same origin that serves the phone app: `https://<machine>.<tailnet>.ts.net`, which
// `tailscale serve` proxies to Multi-Code's port on this Mac. So only devices on the
// builder's tailnet reach it, over TLS, and there is no relay. During development the
// app is also reachable at `http://127.0.0.1:<port>` on the Mac itself.
//
// Every frame after the handshake is sealed with NaCl box (Curve25519 +
// XSalsa20-Poly1305), keyed by the desktop keypair whose public key the phone
// pinned at pairing time. The frames below describe the *plaintext* inside that
// seal.

export const REMOTE_PROTOCOL_VERSION = 3;

export const DEFAULT_REMOTE_PORT = 6768;

// ---------------------------------------------------------------------------
// Pairing
// ---------------------------------------------------------------------------

// Encoded into the QR code the desktop shows, as
// `<origin>/#pair=<base64url(JSON)>`. The phone pins `hostPublicKey` from this
// offer, so a later man-in-the-middle can't impersonate the desktop even if it
// learns the address.
export interface PairingOffer {
  v: typeof REMOTE_PROTOCOL_VERSION;
  // `https://<machine>.<tailnet>.ts.net`, no trailing slash. The phone app is served
  // from it and its WebSocket dials it (wss:), so this is the only address there is.
  origin: string;
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

// Open one instance: the desktop replies with its `transcript`, a terminal
// `snapshot`, and the `prompt-state` of a dialog that is open, then streams
// `output`, `resize` and fresh `transcript`s until `unsubscribe`. Sent again on every
// reconnect: the desktop holds all state, so a resubscribe is how the phone catches
// up on what it missed. Opening a Finished instance marks it seen (it becomes Idle).
export interface SubscribeFrame {
  type: "subscribe";
  instanceId: string;
  // How many of the most recent turns the transcript carries. Default 10; the
  // phone's "Earlier turns" resubscribes with 10 more.
  turns?: number;
}

export interface UnsubscribeFrame {
  type: "unsubscribe";
  instanceId: string;
}

// Raw keystrokes for the agent's PTY, from the terminal fallback's key row and
// input line. Written as given: no paste brackets, no Return added. No ack.
export interface InputFrame {
  type: "input";
  instanceId: string;
  data: string;
}

// A message from the compose box: bracketed paste, then Enter, as the desktop
// compose box sends it. Refused (ack `dialog-open`) while the instance is stopped on
// a dialog, so typed text never lands in one.
export interface PromptFrame {
  type: "prompt";
  instanceId: string;
  text: string;
  clientMsgId: string;
}

// Answer the dialog the desktop reported in `prompt-state`, whole: every question
// of a question box at once, or one option of a permission or plan box. `seq` names
// the dialog: an answer to one that has gone (answered at the desk, or replaced) is
// refused (`gone`) instead of landing on the next one. The desktop turns it into
// keys with the secretary's measured key flows, or OpenCode's API, so the phone never
// knows a key binding. `confirmed`: the builder said yes to the phone's "Are you
// sure?" for an option that widens what the agent may do (`allow-always`,
// `approve-auto`); without it those are refused (`needs-confirm`). The phone never
// resends an `answer` (nor an `interrupt`) after a disconnect: whether it landed is
// unknown, and the builder looks again instead.
export interface AnswerFrame {
  type: "answer";
  instanceId: string;
  seq: number;
  choice: RemoteChoice;
  confirmed?: boolean;
  clientMsgId: string;
}

// Stop the running turn, as Esc does at the desk. Refused (`not-working`) unless
// the instance is in a turn, and (`dialog-open`) while a dialog is open: there Esc
// would answer the dialog.
export interface InterruptFrame {
  type: "interrupt";
  instanceId: string;
  clientMsgId: string;
}

// This phone's Web Push subscription (`PushSubscription.toJSON()`), sent after the
// builder turns notifications on and again on every launch (iOS can drop a
// subscription silently). Null: notifications are off on this phone.
export interface PushSubscribeFrame {
  type: "push-subscribe";
  subscription: RemotePushSubscription | null;
  clientMsgId: string;
}

export interface RemotePushSubscription {
  endpoint: string;
  expirationTime?: number | null;
  keys: { p256dh: string; auth: string };
}

// Sent every 15 s while the app is visible. No pong within 5 s means the socket
// is dead (iOS leaves half-open sockets after a lock), and the phone reconnects.
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
  | AnswerFrame
  | InterruptFrame
  | PushSubscribeFrame
  | PingFrame;

// ---------------------------------------------------------------------------
// Desktop -> phone (sealed)
// ---------------------------------------------------------------------------

export interface AuthOkFrame {
  type: "auth-ok";
  hostName: string;
  // The desktop's VAPID public key (base64url), for `pushManager.subscribe`.
  vapidPublicKey: string;
  // Whether the desktop holds a push subscription for this phone.
  pushEnabled: boolean;
}

export interface AuthFailedFrame {
  type: "auth-failed";
  reason: "unknown-token" | "revoked";
}

// The four states of the phone's list, in its order (PRD Story 2):
//   needs-you — stopped on a dialog
//   working   — in the middle of a turn
//   finished  — its turn ended and no phone has opened it since
//   idle      — anything else, stopped instances included
export type RemoteSessionState = "needs-you" | "working" | "finished" | "idle";

// One entry per instance, mirroring what the desktop contact list shows. The
// Manager is not listed (phase 2).
export interface RemoteInstance {
  id: string;
  name: string;
  cwd: string;
  backend: string;
  status: "running" | "stopped";
  state: RemoteSessionState;
  // When `state` began (ms since epoch), for the row's age. Absent when unknown.
  since?: number;
  // The row's one line: needs-you → what the dialog asks ("Bash: pnpm test:e2e",
  // the question); working → the tool it is on; finished → the first sentence of
  // its conclusion; idle → the last thing it said.
  preview?: string;
}

export interface InstancesFrame {
  type: "instances";
  instances: RemoteInstance[];
}

// The terminal's recent output for a freshly subscribed instance, and the PTY's size:
// the CLIs paint absolutely positioned cells for that width, so the phone's terminal
// must be exactly that wide (and scroll sideways) for the replay to land right.
export interface SnapshotFrame {
  type: "snapshot";
  instanceId: string;
  data: string;
  cols: number;
  rows: number;
}

// Incremental PTY bytes.
export interface OutputFrame {
  type: "output";
  instanceId: string;
  data: string;
}

// The desktop resized the instance's PTY.
export interface ResizeFrame {
  type: "resize";
  instanceId: string;
  cols: number;
  rows: number;
}

export interface ExitFrame {
  type: "exit";
  instanceId: string;
  code: number;
}

// One entry of the readable transcript, from the CLI's own record (Claude's session
// JSONL, OpenCode's database), which reflows like text where the 120-column terminal
// can't. The phone groups entries into turns: a turn starts at each "user" entry.
// Also read by the manager's tools and the secretary.
export interface TranscriptEntry {
  kind: "assistant" | "user" | "tool";
  // Stable for the life of the session (the record's own id where it has one), so the
  // phone keeps a fold open and its place across refreshes.
  id?: string;
  // When the record was written, ms since epoch.
  at?: number;
  // For "tool": the tool's name. Omitted otherwise.
  tool?: string;
  // Assistant/user prose, or a one-line summary of what the tool is doing (its
  // command, file path or pattern).
  text: string;
  // Set on the tool entry the agent is currently blocked on or running.
  pending?: boolean;
  // "tool" only: how it ended. Absent while pending, or when the record doesn't say.
  outcome?: "ok" | "error";
  // "tool" only, for edits and writes: lines added and removed.
  added?: number;
  removed?: number;
  // Not a message to or from the model: a CLI command the builder ran ("user",
  // e.g. "/compact", "/token") or the CLI's own output for it ("assistant", e.g.
  // "Unknown command: /token"). The phone shows these as small grey lines.
  local?: boolean;
}

export interface TranscriptFrame {
  type: "transcript";
  instanceId: string;
  entries: TranscriptEntry[];
  // More turns exist before the first one sent.
  hasEarlier: boolean;
  // The CLI session these entries come from. It changes when the builder starts a
  // new one (`/new`, `/clear`): the phone then drops what it showed for the old one
  // and starts the chat afresh, even before the new session has any entries.
  session?: string;
}

// A dialog option as the CLI labels it. Kept for the secretary and the prompt
// detectors, which share it.
export interface PromptOption {
  label: string;
  description?: string;
}

// What an option of a permission or plan dialog does (secretary/dialog.ts).
export type RemoteEffect =
  | "allow-once"
  | "allow-always"
  | "deny"
  | "approve"
  | "approve-auto"
  | "revise";

export interface RemoteEffectOption {
  effect: RemoteEffect;
  // The CLI's exact label.
  label: string;
  description?: string;
}

export interface RemoteQuestion {
  question: string;
  // The CLI's short tag for the question ("Storage").
  header?: string;
  multiSelect: boolean;
  options: PromptOption[];
}

// The dialog in full, as the phone draws it (PRD Story 5).
export type RemoteDialog =
  | {
      kind: "permission";
      // "Bash", "Edit", "webfetch", …
      tool: string;
      // What the tool acts on, as the CLI shows it: the command, file path or URL.
      subject?: string;
      // The CLI's description of the call ("Clean and rebuild the bundle").
      description?: string;
      options: RemoteEffectOption[];
      // Whether a denial can carry a reason.
      reasonAllowed: boolean;
    }
  | { kind: "plan"; plan: string; options: RemoteEffectOption[] }
  | {
      kind: "questions";
      questions: RemoteQuestion[];
      // Whether each question takes typed text ("Type something").
      textAllowed: boolean;
    };

// The phone's answer. Question and option numbers are 1-based, as the dialog shows
// them. `feedback` is a denial's reason or what a plan should change; `text` is what
// goes in a question's "Type something" row.
export type RemoteChoice =
  | { effect: RemoteEffect; feedback?: string }
  | { answers: { question: number; picks: number[]; text?: string }[] };

// The instance is stopped on a dialog. Sent when it opens, on subscribe while it is
// open, and again when the agent restates it.
export interface PromptStateFrame {
  type: "prompt-state";
  instanceId: string;
  // The needs-you event this dialog belongs to, echoed in `answer`. Never repeats,
  // across desktop restarts included, so an answer to a dialog from before a restart
  // can't name a new one.
  seq: number;
  // One line, the same as the list row's preview.
  summary: string;
  // Absent when the desktop can't answer this dialog (an MCP form, an unknown
  // shape): the phone then says to use the terminal and offers it.
  dialog?: RemoteDialog;
}

// The dialog closed (answered on either side, or the instance stopped).
export interface PromptClearedFrame {
  type: "prompt-cleared";
  instanceId: string;
  seq?: number;
}

// Why the desktop refused a `prompt`, `answer`, `interrupt` or `push-subscribe`:
//   dialog-open   — a dialog is open; answer it first
//   gone          — the dialog the answer names is no longer open
//   needs-confirm — a widening option without `confirmed`
//   not-running   — the instance isn't running
//   not-working   — nothing to stop
//   unsupported   — the desktop can't do this for this dialog or backend
//   failed        — tried and failed (the CLI couldn't be reached, or refused)
export type AckRefusal =
  | "dialog-open"
  | "gone"
  | "needs-confirm"
  | "not-running"
  | "not-working"
  | "unsupported"
  | "failed";

// The desktop's answer to every frame carrying a `clientMsgId`, once it has handled
// it. A frame resent with an id the desktop already handled gets the same ack again
// and is not acted on twice.
export type AckFrame =
  | { type: "ack"; clientMsgId: string; ok: true }
  | { type: "ack"; clientMsgId: string; ok: false; reason: AckRefusal; message: string };

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
  | ResizeFrame
  | ExitFrame
  | TranscriptFrame
  | PromptStateFrame
  | PromptClearedFrame
  | AckFrame
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
  // Whether the desktop holds a push subscription for it.
  pushEnabled: boolean;
  // The last push to it that failed, and why; cleared by the next one that works.
  lastPushError?: string;
}

// The three checks the Phone section shows before it offers a QR (PRD Story 9).
export interface RemoteChecks {
  tailscale:
    | { state: "running"; dnsName: string; ip?: string }
    | { state: "stopped" | "missing" | "unknown"; detail?: string };
  https:
    // `tailscale serve` fronts Multi-Code's port at `origin`.
    | { state: "ready"; origin: string }
    // The tailnet's HTTPS Certificates are off: the builder enables them in the
    // admin console (`adminUrl`).
    | { state: "certs-off"; adminUrl: string }
    // Certificates are on, nothing serves Multi-Code yet: `command` is what the
    // Phone section's button runs.
    | { state: "serve-missing"; command: string }
    // Port 443 of this machine already serves something else; `detail` says what.
    | { state: "serve-conflict"; detail: string }
    | { state: "unknown"; detail?: string };
  push: { state: "ready" } | { state: "error"; detail: string };
}

export interface RemoteStatus {
  enabled: boolean;
  // Null until the server has actually bound a port.
  port: number | null;
  checks: RemoteChecks;
  devices: PairedDevice[];
  // Set when the server failed to start (e.g. port already in use).
  error?: string;
}
