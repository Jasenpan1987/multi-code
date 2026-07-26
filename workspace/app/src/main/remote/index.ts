// Wires the remote server to the rest of the main process and owns its
// lifecycle. Kept separate from ws-server.ts so that module has no dependency on
// process-manager (which imports it, to broadcast PTY output — going both ways
// directly would be a cycle).

import { BrowserWindow } from "electron";
import { processManager } from "../process-manager";
import { loadSettings, saveSettings } from "../settings-store";
import { remoteServer } from "./ws-server";
import type { RemoteInstance } from "../../shared/remote-protocol";

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
  remoteServer.setHost({
    listInstances: (): RemoteInstance[] =>
      processManager.listInstances().map((i) => ({
        id: i.id,
        name: i.name,
        cwd: i.cwd,
        backend: i.backend,
        status: i.status,
      })),
    writeToInstance: (id, data) => processManager.writeToInstance(id, data),
    sendPrompt: (id, text) => processManager.sendPrompt(id, text),
  });

  remoteServer.setStatusListener(emitStatus);

  // Auto-start when the user left it on. Failures (port taken) surface as
  // `error` on the status object rather than blocking app startup.
  const settings = loadSettings();
  if (settings.remoteEnabled) {
    void remoteServer.start().then(emitStatus);
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
