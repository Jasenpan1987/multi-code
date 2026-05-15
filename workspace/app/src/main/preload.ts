import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("electronAPI", {
  // Instance management
  createInstance: (cwd: string, alias?: string) =>
    ipcRenderer.invoke("create-instance", cwd, alias),
  startInstance: (id: string) => ipcRenderer.invoke("start-instance", id),
  killInstance: (id: string) => ipcRenderer.invoke("kill-instance", id),
  removeInstance: (id: string) => ipcRenderer.invoke("remove-instance", id),
  restartInstance: (id: string) => ipcRenderer.invoke("restart-instance", id),
  listInstances: () => ipcRenderer.invoke("list-instances"),
  loadContacts: () => ipcRenderer.invoke("load-contacts"),
  hasRunningInstanceAt: (cwd: string) =>
    ipcRenderer.invoke("has-running-instance-at", cwd),
  setAlias: (id: string, alias: string) =>
    ipcRenderer.invoke("set-alias", id, alias),
  selectDirectory: () => ipcRenderer.invoke("select-directory"),

  // Terminal I/O
  writeToInstance: (id: string, data: string) =>
    ipcRenderer.send("pty-input", id, data),
  resizeInstance: (id: string, cols: number, rows: number) =>
    ipcRenderer.send("pty-resize", id, cols, rows),

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
});
