export interface Instance {
  id: string;
  cwd: string;
  alias?: string;
  status: "running" | "stopped";
  startedAt: number;
  name: string;
  sessionId?: string;
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

export interface ElectronAPI {
  // Instance management
  createInstance: (cwd: string, alias?: string) => Promise<Instance>;
  startInstance: (id: string) => Promise<Instance | null>;
  killInstance: (id: string) => Promise<void>;
  removeInstance: (id: string) => Promise<void>;
  restartInstance: (id: string) => Promise<Instance | null>;
  listInstances: () => Promise<Instance[]>;
  loadContacts: () => Promise<Instance[]>;
  hasRunningInstanceAt: (cwd: string) => Promise<boolean>;
  setAlias: (id: string, alias: string) => Promise<void>;
  selectDirectory: () => Promise<string | null>;
  getGitStatus: (id: string) => Promise<GitStatus>;
  openInVSCode: (target: string) => Promise<{ ok: boolean; error?: string }>;
  bounceDock: () => void;

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
