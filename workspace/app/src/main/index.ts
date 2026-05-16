import { app, BrowserWindow } from "electron";
import path from "path";
import { processManager } from "./process-manager";
import { shellManager } from "./shell-manager";
import { registerIpcHandlers } from "./ipc-handlers";

const iconPath = path.join(__dirname, "../renderer/assets/gaming.png");

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    titleBarStyle: "hiddenInset",
    icon: iconPath,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  processManager.setMainWindow(win);
  shellManager.setMainWindow(win);
  win.loadFile(path.join(__dirname, "../renderer/index.html"));
}

app.whenReady().then(() => {
  if (process.platform === "darwin" && app.dock) {
    try {
      app.dock.setIcon(iconPath);
    } catch {
      // ignore — icon may not be loadable in dev
    }
  }
  registerIpcHandlers();
  createWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

app.on("before-quit", () => {
  processManager.cleanup();
  shellManager.cleanup();
});
