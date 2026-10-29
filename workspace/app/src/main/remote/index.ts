// Wires the remote server to the rest of the main process and owns its
// lifecycle. Kept separate from ws-server.ts so that module has no dependency on
// process-manager (which imports it, to broadcast PTY output — going both ways
// directly would be a cycle).

import { BrowserWindow } from "electron";
import { processManager } from "../process-manager";
import { loadSettings, saveSettings } from "../settings-store";
import { createRemoteHost } from "./remote-host";
import { remoteServer } from "./ws-server";
import { createTailscaleChecker } from "./tailscale";

// Push status to the renderer so the Phone section reflects connect/disconnect
// without polling.
function emitStatus() {
  const status = remoteServer.getStatus();
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send("remote-status", status);
    }
  }
}

export function initRemote() {
  // What the phone sees and may do, from process-manager's own state.
  remoteServer.setHost(createRemoteHost(processManager, remoteServer));

  remoteServer.setStatusListener(emitStatus);
  remoteServer.setChecker(createTailscaleChecker());

  // Auto-start when the user left it on. Failures (port taken) surface as
  // `error` on the status object rather than blocking app startup — so this must
  // never reject: an unhandled rejection here would fire before any window
  // exists to report it, and the user would see a crash dialog instead of the
  // Phone section saying the port is busy.
  const settings = loadSettings();
  if (settings.remoteEnabled) {
    void remoteServer
      .start()
      .catch(() => undefined)
      .finally(emitStatus);
  }
}

export async function setRemoteEnabled(enabled: boolean) {
  const settings = loadSettings();
  saveSettings({ ...settings, remoteEnabled: enabled });
  if (enabled) {
    await remoteServer.start();
  } else {
    await remoteServer.stop();
  }
  return remoteServer.getStatus();
}

export async function shutdownRemote() {
  await remoteServer.stop();
}
