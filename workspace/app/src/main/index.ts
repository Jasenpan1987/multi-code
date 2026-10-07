import { app, BrowserWindow, dialog, type MessageBoxOptions } from "electron";
import path from "path";
import { processManager } from "./process-manager";
import { shellManager } from "./shell-manager";
import { registerIpcHandlers } from "./ipc-handlers";
import {
  registerMdimgSchemePrivileged,
  registerMdimgProtocol,
} from "./mdimg-protocol";
import { initRemote, shutdownRemote } from "./remote";
import {
  initManagerActivityFeed,
  shutdownManagerMcp,
  startManagerMcpServer,
} from "./manager-mcp";
import { secretary } from "./secretary";
import { loadSettings } from "./settings-store";

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

app.whenReady().then(async () => {
  if (process.platform === "darwin" && app.dock) {
    try {
      app.dock.setIcon(iconPath);
    } catch {
      // ignore — icon may not be loadable in dev
    }
  }
  registerMdimgProtocol();
  registerIpcHandlers();
  initRemote();
  initManagerActivityFeed();
  // Subscribed before anything can spawn an instance. With the mode saved on, it
  // prepares whatever is live: at startup, normally nothing.
  secretary.start(loadSettings().secretaryMode);
  // Before the window, because the window is what spawns instances, and each
  // Claude instance needs the server's port and alert token in its launch files.
  await startManagerMcpServer();
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

// Set once the user has said yes, so the app.quit() that follows the dialog goes
// straight through instead of asking again.
let quitConfirmed = false;
let confirmingQuit = false;

async function confirmQuit(
  unfinished: { name: string; state: "busy" | "blocked" }[]
) {
  confirmingQuit = true;
  const lines = unfinished.map(
    ({ name, state }) =>
      `• ${name}${state === "blocked" ? " (waiting for your answer)" : ""}`
  );
  const count = unfinished.length;
  const options: MessageBoxOptions = {
    type: "warning",
    message: `${count} session${count === 1 ? " is" : "s are"} still working`,
    detail: `${lines.join("\n")}\n\nQuitting stops ${count === 1 ? "it" : "them"} mid-task.`,
    buttons: ["Quit Anyway", "Cancel"],
    // Cancel is the default, so a reflexive Enter after Cmd+Q doesn't kill the work.
    defaultId: 1,
    cancelId: 1,
  };
  // Free-standing rather than a sheet on the window: a quit from the Dock can come
  // while the window is minimized or closed, and a sheet on it would never be seen.
  app.focus({ steal: true });
  const { response } = await dialog.showMessageBox(options);
  confirmingQuit = false;
  if (response === 0) {
    quitConfirmed = true;
    app.quit();
  }
}

app.on("before-quit", (event) => {
  if (!quitConfirmed) {
    const unfinished = processManager.unfinishedInstances();
    if (unfinished.length > 0) {
      event.preventDefault();
      if (!confirmingQuit) void confirmQuit(unfinished);
      return;
    }
  }
  // First, so the instances' exits below don't reach it, and so no brief
  // writer's CLI outlives the app.
  secretary.stop();
  processManager.cleanup();
  shellManager.cleanup();
  void shutdownRemote();
  // Stops the listener and deletes the mcp-config file, which holds a bearer
  // token that grants tool access to every managed session.
  void shutdownManagerMcp();
});
