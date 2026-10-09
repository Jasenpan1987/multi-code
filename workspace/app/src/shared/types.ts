import type { RemoteStatus } from "./remote-protocol";

export type BackendName = "claude" | "opencode";

export type ThemeName = "light" | "dark" | "sepia";

export interface AppSettings {
  theme: ThemeName;
  remoteEnabled: boolean;
  secretaryMode: boolean;
  speechServerUrl: string;
}

// ---------------------------------------------------------------------------
// Secretary (epic voice-secretary)
// ---------------------------------------------------------------------------

// The language a brief is written and spoken in, named as the speech server
// takes it.
export type BriefLanguage = "Chinese" | "English";

// What the renderer learns about the secretary's settings. The speech key never
// leaves main: only whether one is saved.
export interface SecretarySettings {
  secretaryMode: boolean;
  // Base address of the speech server; "" means none, and briefs are text only.
  speechServerUrl: string;
  hasSpeechKey: boolean;
}

// What saving the server settings does to the saved key. "unchanged" is what an
// untouched key field sends, so leaving the field empty can never wipe the key;
// a "set" with a blank key counts as unchanged too.
export type SpeechKeyChange =
  | { kind: "unchanged" }
  | { kind: "set"; key: string }
  | { kind: "clear" };

// The Test button's one line: the step that failed and why ("address" covers no
// server set and an unusable address), or the round trip time.
export type SpeechTestResult =
  | { ok: true; ms: number }
  | { ok: false; step: "address" | "health" | "speech"; reason: string };

// One instance's latest brief, as main pushes it on `secretary-brief` (and returns
// from getSecretaryBriefs). Exists only while Secretary Mode is on. It goes away
// (null) when a newer event replaces it, the mode goes off or the instance is
// removed, not when its event clears: then it stays, `handled`, so the builder can
// still read and replay it.
//
// `seq` is the event's: ask for the audio with it, and treat a state with a new
// `seq` as a different brief. The text is there from "ready" on, while the audio
// may still be coming: "pending" until the speech server answers, then "ready"
// (fetch it with getSecretaryAudio) or "unavailable" with the reason (no server
// set, or it failed). The wav itself never rides this update.
//
// `handled`: the event has cleared (the builder typed in the session or answered
// the dialog, or the session exited). Work in flight still finishes.
export type SecretaryBriefState = (
  | { seq: number; kind: SecretaryEventKind; status: "preparing" }
  | {
      seq: number;
      kind: SecretaryEventKind;
      status: "ready";
      text: string;
      language: BriefLanguage;
      audio: "pending" | "ready" | "unavailable";
      voiceReason?: string;
    }
  | { seq: number; kind: SecretaryEventKind; status: "failed"; reason: string }
) & { handled?: true };

export type SecretaryEventKind = "finished" | "needs-you";

// Result of minting a pairing offer: the QR image the user scans plus the same
// payload as text, for the case where scanning isn't practical.
export interface RemotePairing {
  pairingUrl: string;
  webUrl: string | null;
  qrDataUrl: string | null;
  endpoints: string[];
}

// How full a session's context window is, read from the newest assistant turn in
// its transcript.
//
// `inputTokens` is the input side only — prompt plus cache reads and writes —
// because that is what occupies the window. Output tokens are excluded so the
// figure means the same thing on both backends. Note this is per-turn, not
// cumulative: both CLIs also record lifetime totals, and those run to millions
// against a 200k–1M window, so they say nothing about fullness.
export interface ContextUsage {
  inputTokens: number;
  // When that turn happened (ms since epoch), so the UI can tell a live figure
  // from one left over by a session that stopped days ago.
  updatedAt: number;
  // Model that produced the turn. The transcript never records the window size,
  // so a caller wanting a percentage has to map from this. Absent when the
  // transcript didn't name one, in which case there is no percentage to show.
  model?: string;
  // Total window this model has, in tokens, when the backend could establish it
  // from the user's own configuration.
  //
  // **Absent means "we don't know", and a caller must then show no percentage
  // rather than assume a default.** Neither CLI records the window size in its
  // transcript, so this is resolved from config that can be missing or stale —
  // and 45% shown for a session actually at 226% is worse than no percentage.
  contextWindow?: number;
}

export interface Instance {
  id: string;
  cwd: string;
  alias?: string;
  status: "running" | "stopped";
  startedAt: number;
  name: string;
  sessionId?: string;
  backend: BackendName;
  // Absent until the session has an assistant turn, or when its transcript
  // can't be read. The main process caches this: reading it touches a
  // multi-megabyte transcript, and listInstances() is called on every phone
  // broadcast.
  contextUsage?: ContextUsage;
  // Last time this instance reported activity — a turn ending, or blocking on a
  // prompt. Not every PTY repaint. Absent until the first one.
  lastActivityAt?: number;
  // The coordinator. At most one, sorted first in the contact list, and the only
  // instance that gets the fleet-driving MCP tools.
  isManager?: boolean;
  // Finer-grained than `status`, and only present while running: whether it is idle,
  // working, blocked on a decision, or still starting up.
  runState?: "starting" | "idle" | "busy" | "blocked";
  // Its hooks aren't reaching Multi-Code, so it raises no alerts. Shown as a bar on
  // its page. Only set while running.
  alertsDegraded?: boolean;
}

// One tool call made by the manager agent, as shown in the toolbox's Manager
// section. Refusals are entries too — `status: "error"` with the reason in
// `result` — because a dispatch that was blocked is the thing the user most needs
// to see.
export interface ManagerActivityEntry {
  id: number;
  // When the call started, not when it finished.
  at: number;
  tool: string;
  // Session the call was aimed at, for the tools that take one.
  target?: string;
  // The arguments as JSON, truncated. Verbatim rather than prettified: for a write
  // the user needs to read exactly what was sent.
  payload: string;
  // `running` while the handler is still working, which matters for the tools that
  // wait on another session rather than answering immediately.
  status: "running" | "ok" | "error";
  // What the tool returned, or the refusal reason when `status` is `error`.
  result?: string;
  durationMs?: number;
  // Which hand the manager used.
  //
  // `mcp` — one of our tools, so the work happened in another session and that
  // session's own terminal shows it too.
  // `self` — the manager's own Bash/Edit/Write, reported by a hook in its CLI.
  // Nothing else in the app records these, so without them the most privileged
  // thing the manager does is also the only invisible thing it does.
  origin: "mcp" | "self";
}

// Result of creating the manager.
//
// `seededWorkspace` is true only on the run that created its guidance file, which is
// exactly the run whose CLI will stop on the workspace-trust dialog. The renderer
// uses it to show that warning once and never again.
export interface CreateManagerResult {
  instance: Instance;
  seededWorkspace: boolean;
}

export interface GitFileEntry {
  path: string;
  code: string;
  // Set only for a rename: where the file came from.
  oldPath?: string;
}

export type GitStatus =
  | { available: false }
  | {
      available: true;
      branch: string;
      untracked: number;
      unstaged: number;
      staged: number;
      ahead: number;
      behind: number;
      newFiles: GitFileEntry[];
      modifiedFiles: GitFileEntry[];
      stagedFiles: GitFileEntry[];
    };

// Diff view. Which comparison a Git-section row is asking about: a Modified row
// means working tree vs index, Staged means index vs HEAD, New has nothing to
// compare against and shows the whole file as added.
export type DiffSide = "unstaged" | "staged" | "untracked";

// `replace` is a deletion paired with the addition that took its place, so a
// changed line occupies one visual row with old text left and new text right.
// Unpaired lines stay `add` / `del`.
export type DiffLineKind = "context" | "add" | "del" | "replace";

export interface DiffRow {
  kind: DiffLineKind;
  // Line number in the old version; null for a pure addition.
  oldLine: number | null;
  // Line number in the new version; null for a pure deletion. This is the side
  // an @path:start-end reference is built from.
  newLine: number | null;
  oldText: string | null;
  newText: string | null;
}

export type FileDiffFailReason =
  | "binary"
  | "too-large"
  | "no-changes"
  | "not-found"
  | "failed";

export type FileDiff =
  | {
      ok: true;
      rows: DiffRow[];
      oldPath: string;
      newPath: string;
      // Human wording for the overlay header, e.g. "working tree vs index".
      comparison: string;
      // True when the row list was cut short at the display limit.
      truncated: boolean;
    }
  | { ok: false; reason: FileDiffFailReason; detail?: string };

// Compose box: a pasted clipboard image saved to a temp file. `path` is the
// temp file (referenced as `@<path>` on send + cleaned up on cancel); `dataUrl`
// is the same bytes as a data: URL for the chip thumbnail.
export interface SavedClipboardImage {
  path: string;
  dataUrl: string;
}

export type ReadFileError = "not-found" | "unsupported" | "too-large";

export type ReadFileResult =
  | { ok: true; path: string; content: string }
  | { ok: false; path: string; error: ReadFileError };

export interface ElectronAPI {
  // Instance management
  createInstance: (
    cwd: string,
    alias?: string,
    backend?: BackendName
  ) => Promise<Instance>;
  // Rejects when one already exists. Takes no arguments: the manager's directory
  // is Multi-Code's own, and it only runs on claude.
  createManager: () => Promise<CreateManagerResult>;
  hasManager: () => Promise<boolean>;
  startInstance: (id: string) => Promise<Instance | null>;
  killInstance: (id: string) => Promise<void>;
  removeInstance: (id: string) => Promise<void>;
  restartInstance: (id: string) => Promise<Instance | null>;
  listInstances: () => Promise<Instance[]>;
  loadContacts: () => Promise<Instance[]>;
  // Drag-to-reorder: one move, applied against the stored order. Returns the list as
  // stored afterwards.
  moveContact: (
    dragId: string,
    targetId: string,
    placeBefore: boolean
  ) => Promise<Instance[]>;
  hasRunningInstanceAt: (cwd: string, backend?: BackendName) => Promise<boolean>;
  setAlias: (id: string, alias: string) => Promise<void>;
  selectDirectory: () => Promise<string | null>;
  isBackendAvailable: (backend: BackendName) => Promise<boolean>;
  getGitStatus: (id: string) => Promise<GitStatus>;
  getResumeCommand: (id: string) => Promise<string | null>;
  readFile: (instanceId: string, path: string) => Promise<ReadFileResult>;
  // `relPath` is repo-relative, as it comes out of the Git section. Paths that
  // escape the instance's cwd are refused in the main process.
  getFileDiff: (
    instanceId: string,
    relPath: string,
    side: DiffSide,
    // Only for a renamed file: git needs both sides in the pathspec to detect
    // the rename at all.
    oldPath?: string
  ) => Promise<FileDiff>;
  openInVSCode: (
    target: string,
    projectRoot?: string
  ) => Promise<{ ok: boolean; error?: string }>;
  openExternal: (url: string) => Promise<{ ok: boolean; error?: string }>;
  bounceDock: () => void;

  // App
  getAppVersion: () => Promise<string>;
  // True for a dev run (`electron .`), false for a packaged build. Drives the DEV
  // marker, since both can run side by side.
  isDevBuild: () => Promise<boolean>;

  // Settings
  getSettings: () => Promise<AppSettings>;
  setTheme: (theme: ThemeName) => Promise<AppSettings>;

  // Phone link
  getRemoteStatus: () => Promise<RemoteStatus>;
  setRemoteEnabled: (enabled: boolean) => Promise<RemoteStatus>;
  createRemotePairing: () => Promise<RemotePairing | null>;
  revokeRemoteDevice: (deviceId: string) => Promise<RemoteStatus>;
  hasTailscale: () => Promise<boolean>;

  // Secretary. setSpeechServer saves the address ("" for text only) and applies
  // the key change; testSpeechServer tests what is saved.
  getSecretarySettings: () => Promise<SecretarySettings>;
  setSecretaryMode: (enabled: boolean) => Promise<SecretarySettings>;
  setSpeechServer: (
    url: string,
    key: SpeechKeyChange
  ) => Promise<SecretarySettings>;
  testSpeechServer: () => Promise<SpeechTestResult>;
  // Each instance's latest brief, by id: for a renderer that mounts or reloads after
  // briefs were prepared. Empty while Secretary Mode is off.
  getSecretaryBriefs: () => Promise<Record<string, SecretaryBriefState>>;
  // The wav of that instance's brief, or null when `seq` is no longer its brief
  // or its audio isn't ready (pending, unavailable, or the brief was dropped).
  getSecretaryAudio: (instanceId: string, seq: number) => Promise<Uint8Array | null>;

  // Manager activity feed
  getManagerActivity: () => Promise<ManagerActivityEntry[]>;

  // Compose box: clipboard image -> temp file (renderer has no fs access)
  saveClipboardImage: () => Promise<SavedClipboardImage | null>;
  deleteTempImage: (path: string) => Promise<void>;

  // Terminal I/O
  writeToInstance: (id: string, data: string) => void;
  resizeInstance: (id: string, cols: number, rows: number) => void;

  // Shell terminal (toolbox Terminal section)
  spawnShell: (id: string) => Promise<{ ok: boolean }>;
  killShell: (id: string) => Promise<void>;
  writeToShell: (id: string, data: string) => void;
  resizeShell: (id: string, cols: number, rows: number) => void;

  // Event listeners
  onPtyOutput: (callback: (id: string, data: string) => void) => () => void;
  onInstanceExit: (callback: (id: string, code: number) => void) => () => void;
  // Fires whenever an instance starts, including when the manager started it
  // through a tool rather than the user clicking play.
  onInstanceStarted: (callback: (instance: Instance) => void) => () => void;
  onInstanceActivity: (callback: (id: string, type: string) => void) => () => void;
  onInstanceSessionId: (callback: (id: string, sessionId: string) => void) => () => void;
  onInstanceAlertsDegraded: (
    callback: (id: string, degraded: boolean) => void
  ) => () => void;
  onShellOutput: (callback: (id: string, data: string) => void) => () => void;
  onShellExit: (callback: (id: string) => void) => () => void;
  onRemoteStatus: (callback: (status: RemoteStatus) => void) => () => void;
  // One entry per push, inserted or updated. The renderer merges on `id` rather
  // than re-fetching, so a long-running call flips from running to done in place.
  onManagerActivity: (
    callback: (entry: ManagerActivityEntry) => void
  ) => () => void;
  // Every change to an instance's brief; null when it is dropped (the event
  // cleared, or Secretary Mode went off).
  onSecretaryBrief: (
    callback: (instanceId: string, state: SecretaryBriefState | null) => void
  ) => () => void;
  // Secretary Mode after every change. The value at mount comes from
  // getSecretarySettings().
  onSecretaryMode: (callback: (enabled: boolean) => void) => () => void;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
