import { ipcMain, dialog, BrowserWindow, app } from "electron";
import { spawn } from "child_process";
import { processManager } from "./process-manager";
import { shellManager } from "./shell-manager";
import { getGitStatus } from "./git-status";

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

  ipcMain.handle("get-git-status", async (_event, id: string) => {
    const instance = processManager
      .listInstances()
      .find((i) => i.id === id);
    if (!instance) return { available: false };
    return getGitStatus(instance.cwd);
  });

  ipcMain.handle("open-in-vscode", async (_event, target: string) => {
    return new Promise<{ ok: boolean; error?: string }>((resolve) => {
      const child = spawn("code", [target], {
        detached: true,
        stdio: "ignore",
        env: {
          ...process.env,
          PATH: [
            "/opt/homebrew/bin",
            "/usr/local/bin",
            process.env.PATH || "",
          ].join(":"),
        },
      });
      child.once("error", (err: NodeJS.ErrnoException) => {
        resolve({
          ok: false,
          error: err.code === "ENOENT" ? "not-found" : err.message,
        });
      });
      child.once("spawn", () => {
        child.unref();
        resolve({ ok: true });
      });
    });
  });

  ipcMain.on("bounce-dock", () => {
    if (process.platform === "darwin" && app.dock) {
      // "informational" bounces once briefly. Use "critical" for sustained
      // bouncing until the user activates the app — matches QQ behavior.
      app.dock.bounce("critical");
    }
  });

  ipcMain.on("pty-input", (_event, id: string, data: string) => {
    processManager.writeToInstance(id, data);
  });

  ipcMain.on("pty-resize", (_event, id: string, cols: number, rows: number) => {
    processManager.resizeInstance(id, cols, rows);
  });

  ipcMain.handle("shell-spawn", (_event, id: string) => {
    const instance = processManager
      .listInstances()
      .find((i) => i.id === id);
    if (!instance) return { ok: false };
    shellManager.spawn(id, instance.cwd);
    return { ok: true };
  });

  ipcMain.handle("shell-kill", (_event, id: string) => {
    shellManager.kill(id);
  });

  ipcMain.on("shell-input", (_event, id: string, data: string) => {
    shellManager.write(id, data);
  });

  ipcMain.on(
    "shell-resize",
    (_event, id: string, cols: number, rows: number) => {
      shellManager.resize(id, cols, rows);
    }
  );
}
