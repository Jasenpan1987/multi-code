// Writes the --mcp-config payload that points the manager instance at our
// server.
//
// A file, not the JSON-string form of --mcp-config. The string form would put
// the bearer token into the process's argv, where `ps` shows it to every process
// running as any user on the machine. Anything that read it could then drive
// every session Multi-Code manages — dispatch tasks, run slash commands — which
// is precisely the authority this token exists to fence off.
//
// The file lives in the app's userData dir at 0600 and is removed on shutdown.
// It is regenerated on every start because the port is OS-assigned and the token
// is minted fresh, so a stale file is never useful.

import fs from "fs";
import path from "path";
import { app } from "electron";

// The name the CLI prefixes onto every tool, so the manager sees these as
// `mcp__multi-code__list_sessions`. Short because it shows up in every tool call.
export const MCP_SERVER_NAME = "multi-code";

// Resolved lazily rather than as a module constant: app.getPath is undefined
// under vitest, and a top-level call would break importing this file at all.
// Same reason remote/crypto.ts resolves its path in a function.
function configPath(): string {
  return path.join(app.getPath("userData"), "manager-mcp.json");
}

export interface McpConfigTarget {
  endpoint: string;
  token: string;
}

// Returns the path to hand to `claude --mcp-config`, or null when the server
// isn't up. Null is a normal outcome (server failed to bind), and the caller
// spawns the manager without the flag rather than not spawning it — a manager
// with no tools can still be talked to, and the UI reports why it's toolless.
export function writeMcpConfig(target: McpConfigTarget | null): string | null {
  if (!target) return null;

  const payload = {
    mcpServers: {
      [MCP_SERVER_NAME]: {
        type: "http",
        url: target.endpoint,
        headers: { Authorization: `Bearer ${target.token}` },
      },
    },
  };

  const file = configPath();
  try {
    // Unlink first so the mode below applies to a genuinely new file: an
    // existing file keeps its old permissions through writeFileSync, so a file
    // that was once world-readable would stay that way.
    try {
      fs.unlinkSync(file);
    } catch {
      // Not there, which is the normal case.
    }
    fs.writeFileSync(file, JSON.stringify(payload, null, 2), { mode: 0o600 });
    // Belt and braces: writeFileSync's mode is subject to the process umask, so
    // assert the permissions rather than assume them.
    fs.chmodSync(file, 0o600);
    return file;
  } catch {
    return null;
  }
}

export function removeMcpConfig(): void {
  try {
    fs.unlinkSync(configPath());
  } catch {
    // Already gone, or userData is unwritable — nothing useful to do either way.
  }
}
