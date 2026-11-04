// Owns the alert server's lifecycle and the files every session spawns with.
//
// Kept separate from server.ts for the same reason remote/index.ts is separate
// from ws-server.ts: the server module must not import process-manager, and this
// layer is the one that hands deliveries to it.
//
// The server starts at app launch and lives as long as the app. Order matters:
// the spawn files need the port, which only exists after listen. So it is always
// start server, read port, write files, spawn.

import { alertServer } from "./server";
import { removeSpawnFiles, writeAlertSettings, writeOpencodePlugin } from "./config";
import { processManager } from "../process-manager";
import { debugTrace } from "../debug-trace";

// Called once from app.whenReady, before the first window can spawn anything.
// Never throws: a server that can't bind is traced, and sessions then spawn
// without alert hooks (getAlertTarget is null).
//
// Writes what every session spawns with to report its state, the alert settings
// for Claude and the TUI plugin for OpenCode (its directory and the file it reads
// `/alert`'s target from), and hands them to process-manager. shutdownAlertServer
// removes them again.
export async function startAlertServer(): Promise<void> {
  alertServer.onAlertDelivery((delivery) => processManager.handleAlertDelivery(delivery));
  const info = await alertServer.start();
  if (!info.running) {
    debugTrace(`[alert-hook] server failed to start: ${info.error ?? "unknown"}`);
  }
  const alert = getAlertTarget();
  const settingsPath = writeAlertSettings(alert);
  if (!settingsPath && info.running) {
    debugTrace("[alert-hook] alert settings could not be written; sessions spawn without alert hooks");
  }
  const opencodePlugin = writeOpencodePlugin(alert);
  if (!opencodePlugin && info.running) {
    debugTrace("[alert-hook] OpenCode TUI plugin could not be written; OpenCode spawns without it");
  }
  processManager.setSessionSpawnOptions(
    settingsPath || opencodePlugin
      ? { settingsPath: settingsPath ?? undefined, opencodePlugin: opencodePlugin ?? undefined }
      : null
  );
}

// Where an instance's alert hooks or TUI plugin deliver to, and the token they carry.
// Null when the server isn't listening; callers spawn without alert hooks then.
function getAlertTarget(): { endpoint: string; token: string } | null {
  const endpoint = alertServer.getAlertEndpoint();
  const token = alertServer.getAlertToken();
  return endpoint && token ? { endpoint, token } : null;
}

export async function shutdownAlertServer(): Promise<void> {
  await alertServer.stop();
  // These files carry a token that is now dead. Remove them rather than leave a
  // stale credential on disk between runs.
  removeSpawnFiles();
}
