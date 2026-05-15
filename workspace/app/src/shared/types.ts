export interface Instance {
  id: string;
  cwd: string;
  alias?: string;
  status: "running" | "stopped";
  startedAt: number;
  name: string;
}

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

  // Terminal I/O
  writeToInstance: (id: string, data: string) => void;
  resizeInstance: (id: string, cols: number, rows: number) => void;

  // Event listeners
  onPtyOutput: (callback: (id: string, data: string) => void) => () => void;
  onInstanceExit: (callback: (id: string, code: number) => void) => () => void;
  onInstanceActivity: (callback: (id: string, type: string) => void) => () => void;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
