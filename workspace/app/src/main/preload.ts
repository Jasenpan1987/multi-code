import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("electronAPI", {
  // Instance management
  createInstance: (cwd: string, alias?: string, backend?: string) =>
    ipcRenderer.invoke("create-instance", cwd, alias, backend),
  isBackendAvailable: (backend: string) =>
    ipcRenderer.invoke("is-backend-available", backend),
  startInstance: (id: string) => ipcRenderer.invoke("start-instance", id),
  killInstance: (id: string) => ipcRenderer.invoke("kill-instance", id),
  removeInstance: (id: string) => ipcRenderer.invoke("remove-instance", id),
  restartInstance: (id: string) => ipcRenderer.invoke("restart-instance", id),
  listInstances: () => ipcRenderer.invoke("list-instances"),
  loadContacts: () => ipcRenderer.invoke("load-contacts"),
  hasRunningInstanceAt: (cwd: string, backend?: string) =>
    ipcRenderer.invoke("has-running-instance-at", cwd, backend),
  setAlias: (id: string, alias: string) =>
    ipcRenderer.invoke("set-alias", id, alias),
  selectDirectory: () => ipcRenderer.invoke("select-directory"),
  getGitStatus: (id: string) => ipcRenderer.invoke("get-git-status", id),
  openInVSCode: (target: string) => ipcRenderer.invoke("open-in-vscode", target),

  bounceDock: () => ipcRenderer.send("bounce-dock"),

  // Settings
  getSettings: () => ipcRenderer.invoke("settings-get"),
  setTheme: (theme: string) => ipcRenderer.invoke("settings-set-theme", theme),

  // Compose box: clipboard image -> temp file (renderer has no fs access)
  saveClipboardImage: () => ipcRenderer.invoke("save-clipboard-image"),
  deleteTempImage: (path: string) =>
    ipcRenderer.invoke("delete-temp-image", path),

  // Terminal I/O
  writeToInstance: (id: string, data: string) =>
    ipcRenderer.send("pty-input", id, data),
  resizeInstance: (id: string, cols: number, rows: number) =>
    ipcRenderer.send("pty-resize", id, cols, rows),

  // Shell terminal (toolbox Terminal section)
  spawnShell: (id: string) => ipcRenderer.invoke("shell-spawn", id),
  killShell: (id: string) => ipcRenderer.invoke("shell-kill", id),
  writeToShell: (id: string, data: string) =>
    ipcRenderer.send("shell-input", id, data),
  resizeShell: (id: string, cols: number, rows: number) =>
    ipcRenderer.send("shell-resize", id, cols, rows),

  // Event listeners
  onPtyOutput: (callback: (id: string, data: string) => void) => {
    const listener = (_event: unknown, id: string, data: string) =>
      callback(id, data);
    ipcRenderer.on("pty-output", listener);
    return () => {
      ipcRenderer.removeListener("pty-output", listener);
    };
  },
  onInstanceExit: (callback: (id: string, code: number) => void) => {
    const listener = (_event: unknown, id: string, code: number) =>
      callback(id, code);
    ipcRenderer.on("instance-exit", listener);
    return () => {
      ipcRenderer.removeListener("instance-exit", listener);
    };
  },
  onInstanceActivity: (callback: (id: string, type: string) => void) => {
    const listener = (_event: unknown, id: string, type: string) =>
      callback(id, type);
    ipcRenderer.on("instance-activity", listener);
    return () => {
      ipcRenderer.removeListener("instance-activity", listener);
    };
  },
  onInstanceSessionId: (callback: (id: string, sessionId: string) => void) => {
    const listener = (_event: unknown, id: string, sessionId: string) =>
      callback(id, sessionId);
    ipcRenderer.on("instance-session-id", listener);
    return () => {
      ipcRenderer.removeListener("instance-session-id", listener);
    };
  },
  onShellOutput: (callback: (id: string, data: string) => void) => {
    const listener = (_event: unknown, id: string, data: string) =>
      callback(id, data);
    ipcRenderer.on("shell-output", listener);
    return () => {
      ipcRenderer.removeListener("shell-output", listener);
    };
  },
  onShellExit: (callback: (id: string) => void) => {
    const listener = (_event: unknown, id: string) => callback(id);
    ipcRenderer.on("shell-exit", listener);
    return () => {
      ipcRenderer.removeListener("shell-exit", listener);
    };
  },
});
