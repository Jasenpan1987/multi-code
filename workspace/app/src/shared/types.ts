import type { RemoteStatus } from "./remote-protocol";

export type BackendName = "claude" | "opencode";

export type ThemeName = "light" | "dark" | "sepia";

export interface AppSettings {
  theme: ThemeName;
  remoteEnabled: boolean;
}

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
  openInVSCode: (
    target: string,
    projectRoot?: string
  ) => Promise<{ ok: boolean; error?: string }>;
  openExternal: (url: string) => Promise<{ ok: boolean; error?: string }>;
  bounceDock: () => void;

  // App
  getAppVersion: () => Promise<string>;

  // Settings
  getSettings: () => Promise<AppSettings>;
  setTheme: (theme: ThemeName) => Promise<AppSettings>;

  // Phone link
  getRemoteStatus: () => Promise<RemoteStatus>;
  setRemoteEnabled: (enabled: boolean) => Promise<RemoteStatus>;
  createRemotePairing: () => Promise<RemotePairing | null>;
  revokeRemoteDevice: (deviceId: string) => Promise<RemoteStatus>;
  hasTailscale: () => Promise<boolean>;

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
  onShellOutput: (callback: (id: string, data: string) => void) => () => void;
  onShellExit: (callback: (id: string) => void) => () => void;
  onRemoteStatus: (callback: (status: RemoteStatus) => void) => () => void;
  // One entry per push, inserted or updated. The renderer merges on `id` rather
  // than re-fetching, so a long-running call flips from running to done in place.
  onManagerActivity: (
    callback: (entry: ManagerActivityEntry) => void
  ) => () => void;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
