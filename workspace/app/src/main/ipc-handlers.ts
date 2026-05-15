import { ipcMain, dialog, BrowserWindow } from "electron";
import { processManager } from "./process-manager";

export function registerIpcHandlers() {
  ipcMain.handle("create-instance", (_event, cwd: string, alias?: string) => {
    return processManager.createInstance(cwd, alias);
  });

  ipcMain.handle("kill-instance", (_event, id: string) => {
    processManager.killInstance(id);
  });

  ipcMain.handle("remove-instance", (_event, id: string) => {
    processManager.removeInstance(id);
  });

  ipcMain.handle("restart-instance", (_event, id: string) => {
    return processManager.restartInstance(id);
  });

  ipcMain.handle("list-instances", () => {
    return processManager.listInstances();
  });

  ipcMain.handle("load-contacts", () => {
    return processManager.loadSavedContacts();
  });

  ipcMain.handle("start-instance", (_event, id: string) => {
    return processManager.startInstance(id);
  });

  ipcMain.handle("has-running-instance-at", (_event, cwd: string) => {
    return processManager.hasRunningInstanceAt(cwd);
  });

  ipcMain.handle("set-alias", (_event, id: string, alias: string) => {
    processManager.setAlias(id, alias);
  });

  ipcMain.handle("select-directory", async () => {
    const win = BrowserWindow.getFocusedWindow();
    if (!win) return null;
    const result = await dialog.showOpenDialog(win, {
      properties: ["openDirectory"],
      title: "Select project directory",
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  ipcMain.on("pty-input", (_event, id: string, data: string) => {
    processManager.writeToInstance(id, data);
  });

  ipcMain.on("pty-resize", (_event, id: string, cols: number, rows: number) => {
    processManager.resizeInstance(id, cols, rows);
  });
}
