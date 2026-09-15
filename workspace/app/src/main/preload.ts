import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("electronAPI", {
  // Instance management
  createInstance: (cwd: string, alias?: string, backend?: string) =>
    ipcRenderer.invoke("create-instance", cwd, alias, backend),
  createManager: () => ipcRenderer.invoke("create-manager"),
  hasManager: () => ipcRenderer.invoke("has-manager"),
  isBackendAvailable: (backend: string) =>
    ipcRenderer.invoke("is-backend-available", backend),
  startInstance: (id: string) => ipcRenderer.invoke("start-instance", id),
  killInstance: (id: string) => ipcRenderer.invoke("kill-instance", id),
  removeInstance: (id: string) => ipcRenderer.invoke("remove-instance", id),
  restartInstance: (id: string) => ipcRenderer.invoke("restart-instance", id),
  listInstances: () => ipcRenderer.invoke("list-instances"),
  loadContacts: () => ipcRenderer.invoke("load-contacts"),
  moveContact: (dragId: string, targetId: string, placeBefore: boolean) =>
    ipcRenderer.invoke("move-contact", dragId, targetId, placeBefore),
  hasRunningInstanceAt: (cwd: string, backend?: string) =>
    ipcRenderer.invoke("has-running-instance-at", cwd, backend),
  setAlias: (id: string, alias: string) =>
    ipcRenderer.invoke("set-alias", id, alias),
  selectDirectory: () => ipcRenderer.invoke("select-directory"),
  getGitStatus: (id: string) => ipcRenderer.invoke("get-git-status", id),
  getResumeCommand: (id: string) =>
    ipcRenderer.invoke("get-resume-command", id),
  readFile: (instanceId: string, path: string) =>
    ipcRenderer.invoke("read-file", instanceId, path),
  openInVSCode: (target: string, projectRoot?: string) =>
    ipcRenderer.invoke("open-in-vscode", target, projectRoot),
  openExternal: (url: string) => ipcRenderer.invoke("open-external", url),

  bounceDock: () => ipcRenderer.send("bounce-dock"),

  // App
  getAppVersion: () => ipcRenderer.invoke("get-app-version"),

  // Settings
  getSettings: () => ipcRenderer.invoke("settings-get"),
  setTheme: (theme: string) => ipcRenderer.invoke("settings-set-theme", theme),

  // Phone link
  getRemoteStatus: () => ipcRenderer.invoke("remote-get-status"),
  setRemoteEnabled: (enabled: boolean) =>
    ipcRenderer.invoke("remote-set-enabled", enabled),
  createRemotePairing: () => ipcRenderer.invoke("remote-create-pairing"),
  revokeRemoteDevice: (deviceId: string) =>
    ipcRenderer.invoke("remote-revoke-device", deviceId),
  hasTailscale: () => ipcRenderer.invoke("remote-has-tailscale"),

  // Manager activity feed
  getManagerActivity: () => ipcRenderer.invoke("manager-activity-list"),

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
  onInstanceStarted: (callback: (instance: unknown) => void) => {
    const listener = (_event: unknown, instance: unknown) => callback(instance);
    ipcRenderer.on("instance-started", listener);
    return () => {
      ipcRenderer.removeListener("instance-started", listener);
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
  onRemoteStatus: (callback: (status: unknown) => void) => {
    const listener = (_event: unknown, status: unknown) => callback(status);
    ipcRenderer.on("remote-status", listener);
    return () => {
      ipcRenderer.removeListener("remote-status", listener);
    };
  },
  onManagerActivity: (callback: (entry: unknown) => void) => {
    const listener = (_event: unknown, entry: unknown) => callback(entry);
    ipcRenderer.on("manager-activity", listener);
    return () => {
      ipcRenderer.removeListener("manager-activity", listener);
    };
  },
});
