// Owns the manager MCP server's lifecycle and registers its tools.
//
// Kept separate from server.ts for the same reason remote/index.ts is separate
// from ws-server.ts: the server module must not import process-manager, because
// the tools added by later tasks will be wired from the side that already knows
// about instances. Going both ways directly would be a cycle.
//
// The server is started lazily, on the first manager spawn, rather than at app
// launch. Two reasons: a user with no manager instance shouldn't have a listening
// socket at all, and the spawn needs the port — which only exists after listen —
// to write the --mcp-config the manager is launched with. So the order is always
// start server, read port, write config, spawn.

import { BrowserWindow } from "electron";
import { managerMcpServer } from "./server";
import { MCP_SERVER_NAME, removeMcpConfig, writeMcpConfig } from "./config";
import { buildReadTools } from "./read-tools";
import { buildWriteTools } from "./write-tools";
import { managerActivityLog } from "./activity-log";
import { processManager } from "../process-manager";
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
  })) {
    managerMcpServer.registerTool(tool);
  }

  // Write tools go through trySendTask, never sendPrompt: that is where the
  // write-safety gate lives. Registering them here rather than inside the read
  // builder keeps the distinction visible at the call site.
  for (const tool of buildWriteTools({
    listInstances: () => processManager.listInstances(),
    sendTask: (id, text) => processManager.trySendTask(id, text),
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

  return { mcpConfigPath, allowedTools: managerToolNames() };
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
  // The config file carries a bearer token that is now dead. Remove it rather
  // than leave a stale credential on disk between runs.
  removeMcpConfig();
}
