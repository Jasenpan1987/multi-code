// Owns the manager MCP server's lifecycle and registers its tools.
//
// Kept separate from server.ts for the same reason remote/index.ts is separate
// from ws-server.ts: the server module must not import process-manager, because
// the tools added by later tasks will be wired from the side that already knows
// about instances. Going both ways directly would be a cycle.
//
// The server starts at app launch and lives as long as the app. It used to start
// lazily on the first manager spawn, so that a user with no manager had no
// listening socket, but every Claude session now reports its state to `/alert`
// through hooks (epic attention-alerts), and a session can be spawned before any
// manager exists. A manager's MCP tools stay closed without one all the same: their
// token is written to disk only when a manager spawns.
//
// Order still matters: the spawn needs the port, which only exists after listen, to
// write the files a CLI is launched with. So it is always start server, read port,
// write config, spawn.

import { BrowserWindow } from "electron";
import { managerMcpServer } from "./server";
import {
  MCP_SERVER_NAME,
  removeSpawnFiles,
  writeAlertSettings,
  writeManagerSettings,
  writeMcpConfig,
} from "./config";
import { buildReadTools } from "./read-tools";
import { buildWriteTools } from "./write-tools";
import { buildWaitTools } from "./wait-tools";
import { managerActivityLog } from "./activity-log";
import { processManager } from "../process-manager";
import { debugTrace } from "../debug-trace";
import type { McpServerInfo } from "./server";
import type { SpawnOptions } from "../backends";
import type { ManagerActivityEntry } from "../../shared/types";

let toolsRegistered = false;

// Registered once per process. This is the only layer that knows about
// process-manager, and the dependency must stay one-directional: a manager spawn
// needs the server's port, so process-manager importing this module would close a
// cycle. Spawn wiring belongs above both, in main/index.ts or ipc-handlers.
function registerTools() {
  if (toolsRegistered) return;
  toolsRegistered = true;

  for (const tool of buildReadTools({
    listInstances: () => processManager.listInstances(),
    readTranscript: (id, limit) => processManager.readTranscript(id, limit),
    hasReadableTranscript: (id) => processManager.hasReadableTranscript(id),
  })) {
    managerMcpServer.registerTool(tool);
  }

  // Write tools go through the try* methods, never sendPrompt or writeToInstance:
  // that is where the write-safety gate lives. Registering them here rather than
  // inside the read builder keeps the distinction visible at the call site.
  for (const tool of buildWriteTools({
    listInstances: () => processManager.listInstances(),
    sendTask: (id, text) => processManager.trySendTask(id, text),
    runCommand: (id, command) => processManager.tryRunCommand(id, command),
    // Not gated: starting a stopped process writes nothing into anyone's terminal,
    // and it is the capability whose absence made the manager tell the user to go
    // and start sessions by hand.
    startSession: (id) => processManager.startInstance(id),
    runStateOf: (id) => processManager.runStateOf(id),
    onActivity: (listener) => processManager.onActivity(listener),
    msSincePtyByte: (id) => processManager.msSincePtyByte(id),
  })) {
    managerMcpServer.registerTool(tool);
  }

  for (const tool of buildWaitTools({
    listInstances: () => processManager.listInstances(),
    runStateOf: (id) => processManager.runStateOf(id),
    onActivity: (listener) => processManager.onActivity(listener),
    msSincePtyByte: (id) => processManager.msSincePtyByte(id),
  })) {
    managerMcpServer.registerTool(tool);
  }

  managerMcpServer.registerTool({
    name: "manager_health",
    description:
      "Check that the Multi-Code manager tool server is reachable and see which tools it exposes. Use this to confirm the connection before reporting a tool problem to the user.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: () => {
      const info = managerMcpServer.getInfo();
      return [
        `status: ok`,
        `endpoint: ${info.endpoint ?? "(not listening)"}`,
        `tools: ${info.toolNames.length} (${info.toolNames.join(", ")})`,
        `uptime: ${Math.round(managerMcpServer.uptimeMs() / 1000)}s`,
      ].join("\n");
    },
  });
}

// Called once from app.whenReady, before the first window can spawn anything.
// Never throws: a server that can't bind is traced, sessions then spawn without
// alert hooks (getAlertTarget is null), and the manager's own path retries the
// start when it spawns.
//
// Also writes the alert settings every Claude project session spawns with, and
// hands them to process-manager: the port and token exist only once the server is
// listening, and this runs before anything can spawn.
export async function startManagerMcpServer(): Promise<void> {
  registerTools();
  managerMcpServer.onAlertDelivery((delivery) => processManager.handleAlertDelivery(delivery));
  const info = await managerMcpServer.start();
  if (!info.running) {
    debugTrace(`[alert-hook] server failed to start: ${info.error ?? "unknown"}`);
  }
  const settingsPath = writeAlertSettings(getAlertTarget());
  if (!settingsPath && info.running) {
    debugTrace("[alert-hook] alert settings could not be written; sessions spawn without alert hooks");
  }
  processManager.setSessionSpawnOptions(settingsPath ? { settingsPath } : null);
}

// Where a Claude instance's alert hooks deliver to, and the token they carry.
// Null when the server isn't listening; callers spawn without alert hooks then.
export function getAlertTarget(): { endpoint: string; token: string } | null {
  const endpoint = managerMcpServer.getAlertEndpoint();
  const token = managerMcpServer.getAlertToken();
  return endpoint && token ? { endpoint, token } : null;
}

// Starts the server if it isn't already up and returns everything the manager's
// spawn needs, or null when the server couldn't bind or the config couldn't be
// written. Null is not fatal: the caller spawns the manager without the flags, and
// getManagerMcpInfo carries the reason for the UI to show.
//
// Returns both the config path and the tool allowlist together, because either
// without the other is useless. Measured 2026-09-02: with the config alone, the CLI
// answers "Claude requested permissions to use mcp__multi-code__manager_health, but
// you haven't granted it yet" and the handler never runs.
export async function ensureManagerMcpStarted(): Promise<SpawnOptions | null> {
  registerTools();

  if (!managerMcpServer.isRunning()) {
    await managerMcpServer.start();
  }

  const endpoint = managerMcpServer.getEndpoint();
  const token = managerMcpServer.getToken();
  if (!endpoint || !token) return null;

  const mcpConfigPath = writeMcpConfig({ endpoint, token });
  if (!mcpConfigPath) return null;

  // Not null-checked into an early return: a manager with tools but no
  // self-reporting is worse than one with both and better than one with neither,
  // so a failure here degrades the feed rather than the manager. The UI shows the
  // server state either way.
  // Carries the alert hooks too: the CLI takes only one --settings file.
  const settingsPath =
    writeManagerSettings({ endpoint, token }, getAlertTarget()) ?? undefined;

  return { mcpConfigPath, settingsPath, allowedTools: managerToolNames() };
}

// Fully-qualified names, as the CLI addresses them: `mcp__<server>__<tool>`.
// Derived from what is actually registered rather than a hardcoded list, so a tool
// added in a later task can't be left un-allowed and silently prompt-blocked.
export function managerToolNames(): string[] {
  return managerMcpServer
    .getInfo()
    .toolNames.map((name) => `mcp__${MCP_SERVER_NAME}__${name}`);
}

export function getManagerMcpInfo(): McpServerInfo {
  return managerMcpServer.getInfo();
}

// Pushes each tool call to the renderer so the Manager section is live without
// polling. Called once at startup, not on the first manager spawn: the log itself
// costs nothing when empty, and a listener attached late would drop the calls the
// manager makes in its opening turn.
export function initManagerActivityFeed() {
  managerActivityLog.setListener((entry: ManagerActivityEntry) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send("manager-activity", entry);
      }
    }
  });
}

// The whole feed, for a renderer that just mounted. The log lives in main
// precisely so this survives a reload.
export function getManagerActivity(): ManagerActivityEntry[] {
  return managerActivityLog.list();
}

export async function shutdownManagerMcp(): Promise<void> {
  await managerMcpServer.stop();
  // Three of these files carry a bearer token that is now dead. Remove them rather
  // than leave a stale credential on disk between runs.
  removeSpawnFiles();
}
