export type BackendName = "claude" | "opencode";

export type ThemeName = "light" | "dark" | "sepia";

export interface AppSettings {
  theme: ThemeName;
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
  startInstance: (id: string) => Promise<Instance | null>;
  killInstance: (id: string) => Promise<void>;
  removeInstance: (id: string) => Promise<void>;
  restartInstance: (id: string) => Promise<Instance | null>;
  listInstances: () => Promise<Instance[]>;
  loadContacts: () => Promise<Instance[]>;
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
  onInstanceActivity: (callback: (id: string, type: string) => void) => () => void;
  onInstanceSessionId: (callback: (id: string, sessionId: string) => void) => () => void;
  onShellOutput: (callback: (id: string, data: string) => void) => () => void;
  onShellExit: (callback: (id: string) => void) => () => void;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
