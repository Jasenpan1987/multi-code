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
import { hookEndpointFor, SELF_TOOL_MATCHER } from "./hook-activity";

// The name the CLI prefixes onto every tool, so the manager sees these as
// `mcp__multi-code__list_sessions`. Short because it shows up in every tool call.
export const MCP_SERVER_NAME = "multi-code";

// Resolved lazily rather than as a module constant: app.getPath is undefined
// under vitest, and a top-level call would break importing this file at all.
// Same reason remote/crypto.ts resolves its path in a function.
function configPath(): string {
  return path.join(app.getPath("userData"), "manager-mcp.json");
}

// The CLI settings the manager spawns with, carrying only the activity hooks.
function settingsPath(): string {
  return path.join(app.getPath("userData"), "manager-settings.json");
}

// curl's own -K config, holding the bearer token and the endpoint for the hook.
//
// A separate file rather than flags in the hook command for the same reason
// --mcp-config is a file: the hook runs as a child process, so anything in its
// command line is visible to `ps` for every process on the machine. A shell
// would expand an environment variable into that argv too, which is why the
// token is not passed that way either. With -K the argv is one path, and the
// token stays behind 0600.
function hookCurlConfigPath(): string {
  return path.join(app.getPath("userData"), "manager-hook.curl");
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

// The settings file the manager spawns with, whose hooks report the tools the
// manager runs itself into the activity feed. Returns the path for `--settings`,
// or null when either file couldn't be written — in which case the manager still
// spawns, just without self-reporting, and the feed is missing those rows.
//
// Only hooks go in here. No `permissions` block, deliberately: the manager is
// meant to be able to verify a session's claim itself and to fix something small
// without handing the job back, and a deny list is how it became the meek
// assistant that told the user to go and run things by hand (T-215). Its bound is
// visibility plus the user's own permission rules, not a narrower sandbox.
export function writeManagerSettings(target: McpConfigTarget | null): string | null {
  if (!target) return null;

  const curlConfig = writeHookCurlConfig(target);
  if (!curlConfig) return null;

  // `|| true` so the hook can never fail the tool it is reporting on. Measured
  // 2026-09-16 against CLI 2.1.273: curl exiting 7 (connection refused) did not
  // block the call, so this is belt and braces rather than the only guard — but
  // exit code 2 *is* a documented block signal, and a reporting path must never
  // be able to disarm the manager. Also why the curl config sets max-time: a
  // hook that hangs is a manager that hangs.
  const command = `curl -K ${shellQuote(curlConfig)} || true`;
  const hook = {
    matcher: SELF_TOOL_MATCHER,
    hooks: [{ type: "command", command, timeout: 5 }],
  };

  const file = settingsPath();
  try {
    fs.writeFileSync(
      file,
      JSON.stringify({ hooks: { PreToolUse: [hook], PostToolUse: [hook] } }, null, 2)
    );
    return file;
  } catch {
    return null;
  }
}

function writeHookCurlConfig(target: McpConfigTarget): string | null {
  const endpoint = hookEndpointFor(target.endpoint);
  if (!endpoint) return null;

  // curl's config format: one long-option-without-dashes per line. Values are
  // double-quoted, and the token is base64url so it needs no escaping — but it is
  // rejected rather than written if that ever stops being true, since a broken
  // quote here would put the token somewhere unintended.
  if (/["\\\r\n]/.test(target.token)) return null;

  const body = [
    `url = "${endpoint}"`,
    `request = "POST"`,
    `header = "Authorization: Bearer ${target.token}"`,
    `header = "Content-Type: application/json"`,
    // The hook delivery arrives on the hook command's stdin.
    `data-binary = "@-"`,
    `silent`,
    // A hook runs on every tool call, so it must never be the slow part.
    `max-time = 2`,
    // Nothing on stdout: a PostToolUse hook's output can be fed back to the model
    // as context, and an HTTP status line would be noise it has to read.
    `output = "/dev/null"`,
    ``,
  ].join("\n");

  const file = hookCurlConfigPath();
  try {
    try {
      fs.unlinkSync(file);
    } catch {
      // Not there, which is the normal case.
    }
    fs.writeFileSync(file, body, { mode: 0o600 });
    fs.chmodSync(file, 0o600);
    return file;
  } catch {
    return null;
  }
}

// Single-quoted for the shell the CLI runs a hook command with. userData paths
// contain a space on macOS ("Application Support"), so this is load-bearing, not
// defensive.
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// Everything written for a manager spawn, all of it stale the moment the server
// stops: the port is OS-assigned and the token is minted per run.
export function removeManagerSpawnFiles(): void {
  for (const file of [configPath(), settingsPath(), hookCurlConfigPath()]) {
    try {
      fs.unlinkSync(file);
    } catch {
      // Already gone, or userData is unwritable — nothing useful to do either way.
    }
  }
}
