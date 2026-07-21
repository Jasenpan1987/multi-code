import { app, BrowserWindow } from "electron";
import path from "path";
import { processManager } from "./process-manager";
import { shellManager } from "./shell-manager";
import { registerIpcHandlers } from "./ipc-handlers";
import {
  registerMdimgSchemePrivileged,
  registerMdimgProtocol,
} from "./mdimg-protocol";

// Must run before app 'ready' — privileged scheme registration is only honored
// pre-ready. The handler itself is installed after ready (in whenReady).
registerMdimgSchemePrivileged();

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

  // Swallow the browser-style reload shortcuts. Multi-Code is an app, not a web
  // page — a reload wipes the renderer state (selected instance, terminals,
  // unread flags) while leaving the PTYs orphaned. Cmd/Ctrl+R and
  // Cmd/Ctrl+Shift+R are intercepted here rather than by rebuilding the whole
  // app menu, which would mean re-declaring every default edit/window item.
  win.webContents.on("before-input-event", (event, input) => {
    const mod = process.platform === "darwin" ? input.meta : input.control;
    if (mod && input.key.toLowerCase() === "r") {
      event.preventDefault();
    }
  });

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
  registerMdimgProtocol();
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
