// Wires the remote server to the rest of the main process and owns its
// lifecycle. Kept separate from ws-server.ts so that module has no dependency on
// process-manager (which imports it, to broadcast PTY output — going both ways
// directly would be a cycle).

import { app, BrowserWindow } from "electron";
import { processManager } from "../process-manager";
import { loadSettings, saveSettings } from "../settings-store";
import { devOverrides } from "./dev-overrides";
import { createRemoteHost } from "./remote-host";
import { remoteServer, type RemoteHost } from "./ws-server";
import { createTailscaleChecker } from "./tailscale";

let host: RemoteHost | null = null;
// The port a dev build binds instead of the default (dev-overrides.ts); undefined in
// a packaged app.
let port: number | undefined;

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
  host = createRemoteHost(processManager, remoteServer);
  remoteServer.setHost(host);

  remoteServer.setStatusListener(emitStatus);
  const dev = devOverrides(app.isPackaged);
  port = dev.port;
  remoteServer.setChecker(dev.checker ?? createTailscaleChecker());

  // Auto-start when the user left it on. Failures (port taken) surface as
  // `error` on the status object rather than blocking app startup — so this must
  // never reject: an unhandled rejection here would fire before any window
  // exists to report it, and the user would see a crash dialog instead of the
  // Phone section saying the port is busy.
  const settings = loadSettings();
  if (settings.remoteEnabled) {
    void remoteServer
      .start(port)
      .catch(() => undefined)
      .finally(emitStatus);
  }
}

export async function setRemoteEnabled(enabled: boolean) {
  const settings = loadSettings();
  saveSettings({ ...settings, remoteEnabled: enabled });
  if (enabled) {
    await remoteServer.start(port);
  } else {
    await remoteServer.stop();
  }
  return remoteServer.getStatus();
}

// The builder acknowledged the instance at the desk (the renderer's markRead): a
// Finished session stops being Finished on the phone, as when a phone opens it.
export function acknowledgeInstance(id: string) {
  host?.markSeen(id);
}

export async function shutdownRemote() {
  await remoteServer.stop();
}
