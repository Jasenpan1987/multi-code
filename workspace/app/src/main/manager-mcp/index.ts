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

import { managerMcpServer } from "./server";
import { removeMcpConfig, writeMcpConfig } from "./config";
import type { McpServerInfo } from "./server";

let toolsRegistered = false;

// Registered once per process. Later tasks add their tools here — the read-only
// pair (list_sessions, read_session) and then the gated write tools — each taking
// what it needs through a host object injected from this layer, never by
// importing process-manager into server.ts.
function registerTools() {
  if (toolsRegistered) return;
  toolsRegistered = true;

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

// Starts the server if it isn't already up and returns the path to pass as
// `claude --mcp-config`, or null when the server couldn't bind or the config
// couldn't be written. Null is not fatal: the caller spawns the manager without
// the flag, and getManagerMcpInfo carries the reason for the UI to show.
export async function ensureManagerMcpStarted(): Promise<string | null> {
  registerTools();

  if (!managerMcpServer.isRunning()) {
    await managerMcpServer.start();
  }

  const endpoint = managerMcpServer.getEndpoint();
  const token = managerMcpServer.getToken();
  if (!endpoint || !token) return null;

  return writeMcpConfig({ endpoint, token });
}

export function getManagerMcpInfo(): McpServerInfo {
  return managerMcpServer.getInfo();
}

export async function shutdownManagerMcp(): Promise<void> {
  await managerMcpServer.stop();
  // The config file carries a bearer token that is now dead. Remove it rather
  // than leave a stale credential on disk between runs.
  removeMcpConfig();
}
