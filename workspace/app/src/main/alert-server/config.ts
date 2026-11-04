// Writes the files every spawned session reports its state with: the alert hooks'
// `--settings` file and curl config for Claude, and the TUI plugin and its target
// for OpenCode. All of them point at the `/alert` endpoint in server.ts.
//
// They live in the app's userData dir at 0600 and are removed on shutdown. They
// are regenerated on every start because the port is OS-assigned and the token is
// minted fresh, so a stale file is never useful.

import fs from "fs";
import path from "path";
import { app } from "electron";
import {
  OPENCODE_PLUGIN_DIR,
  OPENCODE_PLUGIN_ENTRY,
  opencodePluginSource,
} from "../backends/opencodePlugin";

// The `--settings` file every Claude session spawns with, carrying only the alert
// hooks.
//
// Resolved lazily rather than as a module constant: app.getPath is undefined
// under vitest, and a top-level call would break importing this file at all.
// Same reason remote/crypto.ts resolves its path in a function.
function alertSettingsPath(): string {
  return path.join(app.getPath("userData"), "alert-settings.json");
}

// curl's own -K config for the alert hooks: the `/alert` endpoint and its token.
//
// A separate file rather than flags in the hook command: the hook runs as a child
// process, so anything in its command line is visible to `ps` for every process on
// the machine. A shell would expand an environment variable into that argv too,
// which is why the token is not passed that way either. With -K the argv is one
// path, and the token stays behind 0600.
function alertCurlConfigPath(): string {
  return path.join(app.getPath("userData"), "alert-hook.curl");
}

// OpenCode's counterpart of the two files above: Multi-Code's TUI plugin, and the
// 0600 JSON it reads `/alert`'s endpoint and token from. The plugin gets a directory
// of its own, because OpenCode names TUI plugins by directory and loads
// `<dir>/tui.js` (spike G-601); one holding nothing else, so nothing beside it can
// pass for a plugin entry (`index.js` would be a server entry).
function opencodeDir(): string {
  return path.join(app.getPath("userData"), "opencode");
}

function opencodePluginDir(): string {
  return path.join(opencodeDir(), OPENCODE_PLUGIN_DIR);
}

function opencodePluginPath(): string {
  return path.join(opencodePluginDir(), OPENCODE_PLUGIN_ENTRY);
}

function opencodeAlertPath(): string {
  return path.join(opencodeDir(), "alert.json");
}

// Where Multi-Code before OpenCode 2 wrote its server plugin. Removed with the rest,
// so a run that crashed under an older version doesn't leave it behind.
function legacyOpencodePluginPath(): string {
  return path.join(opencodeDir(), "multicode-plugin.js");
}

// What the retired manager agent spawned with (removed 2026-11-01): its
// `--mcp-config`, its `--settings` and its hook's curl config. Two of them carry a
// bearer token. Removed with the rest for the same reason as the legacy plugin.
function legacyManagerFiles(): string[] {
  const userData = app.getPath("userData");
  return ["manager-mcp.json", "manager-settings.json", "manager-hook.curl"].map((name) =>
    path.join(userData, name)
  );
}

// The hook events a Claude instance reports for attention alerts: exactly the ones
// backends/claudeHooks.ts acts on, plus SessionStart, which tells a session whose
// hooks work from one whose hooks never run. Nothing on every tool call, so the
// alert path costs a turn a handful of deliveries, not one per tool.
export const ALERT_HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "Stop",
  "StopFailure",
  "SubagentStop",
  "PermissionRequest",
  "Elicitation",
  "ElicitationResult",
  "PostCompact",
] as const;

export interface AlertTarget {
  endpoint: string;
  token: string;
}

// The settings file every Claude session spawns with. Returns the path for
// `--settings`, or null when the server isn't up or a file couldn't be written; the
// caller then spawns without alert hooks.
//
// Only hooks, never a `permissions` block: these must not change what an agent may
// do, only report what it is doing.
export function writeAlertSettings(alert: AlertTarget | null): string | null {
  if (!alert) return null;
  const curlConfig = writeCurlConfig(alertCurlConfigPath(), alert.endpoint, alert.token);
  if (!curlConfig) return null;
  return writePrivateFile(
    alertSettingsPath(),
    JSON.stringify({ hooks: alertHooks(curlConfig) }, null, 2)
  );
}

// The TUI plugin every OpenCode instance spawns with, and the file it reads its
// target from. `pluginPath` is the plugin's directory, the form OPENCODE_CLI_CONFIG_CONTENT
// names it in. Null when the server isn't up or a file couldn't be written; the
// caller then spawns OpenCode without the plugin.
//
// The plugin holds no secret and is the same on every start, but it is rewritten
// each time with the rest, so a Multi-Code upgrade never runs an older copy. Both
// directories are 0700, the files 0600: only the user's own processes (their TUIs)
// read them.
export function writeOpencodePlugin(
  alert: AlertTarget | null
): { pluginPath: string; targetPath: string } | null {
  if (!alert) return null;
  try {
    for (const dir of [opencodeDir(), opencodePluginDir()]) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      // mkdir's mode is subject to the umask and skipped for a directory already there.
      fs.chmodSync(dir, 0o700);
    }
  } catch {
    return null;
  }
  const targetPath = writePrivateFile(
    opencodeAlertPath(),
    JSON.stringify({ endpoint: alert.endpoint, token: alert.token })
  );
  if (!targetPath) return null;
  if (!writePrivateFile(opencodePluginPath(), opencodePluginSource())) return null;
  return { pluginPath: opencodePluginDir(), targetPath };
}

// One entry per alert event, all running the same command.
//
// The instance travels in a header expanded from MULTICODE_INSTANCE_ID, and the
// spawn it belongs to in one from MULTICODE_SPAWN_ID, both set by process-manager
// in each agent's own environment. Not secrets, so the shell putting them in argv
// is fine; the token stays in the -K file.
//
// `async: true`: measured on 2.1.291, the CLI waits for a synchronous hook (a sync
// Stop hook delays the turn's end by its whole runtime), accepts `async`, and still
// delivers async hooks complete and in order. A report must never make the agent
// wait on Multi-Code. `|| true` so the hook can never fail the turn it reports on,
// and `timeout` so a hook that hangs can't hang the agent.
function alertHooks(curlConfig: string): Record<string, unknown[]> {
  const command =
    `curl -K ${shellQuote(curlConfig)} ` +
    `-H "X-Multicode-Instance: $MULTICODE_INSTANCE_ID" ` +
    `-H "X-Multicode-Spawn: $MULTICODE_SPAWN_ID" || true`;
  const entry = { hooks: [{ type: "command", command, timeout: 5, async: true }] };
  return Object.fromEntries(ALERT_HOOK_EVENTS.map((event) => [event, [entry]]));
}

function writeCurlConfig(file: string, url: string, token: string): string | null {
  // curl's config format: one long-option-without-dashes per line. Values are
  // double-quoted, and the token is base64url so it needs no escaping — but it is
  // rejected rather than written if that ever stops being true, since a broken
  // quote here would put the token somewhere unintended.
  if (/["\\\r\n]/.test(token)) return null;

  const body = [
    `url = "${url}"`,
    `request = "POST"`,
    `header = "Authorization: Bearer ${token}"`,
    `header = "Content-Type: application/json"`,
    // The hook delivery arrives on the hook command's stdin.
    `data-binary = "@-"`,
    `silent`,
    // A report must never be the slow part of a turn.
    `max-time = 2`,
    // Nothing on stdout: a hook's output can be fed back to the model as context,
    // and an HTTP status line would be noise it has to read.
    `output = "/dev/null"`,
    ``,
  ].join("\n");

  return writePrivateFile(file, body);
}

// Unlink, write at 0600, then chmod: writeFileSync's mode applies only when it
// creates the file, and is subject to the umask even then.
function writePrivateFile(file: string, body: string): string | null {
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

// Everything written for a spawn, every Claude session's alert hooks and OpenCode's
// TUI plugin, all of it stale the moment the server stops: the port is OS-assigned
// and the token is minted per run.
export function removeSpawnFiles(): void {
  for (const file of [
    alertSettingsPath(),
    alertCurlConfigPath(),
    opencodePluginPath(),
    opencodeAlertPath(),
    legacyOpencodePluginPath(),
    ...legacyManagerFiles(),
  ]) {
    try {
      fs.unlinkSync(file);
    } catch {
      // Already gone, or userData is unwritable — nothing useful to do either way.
    }
  }
  for (const dir of [opencodePluginDir(), opencodeDir()]) {
    try {
      fs.rmdirSync(dir);
    } catch {
      // Not there, or something else was put in it: leave it.
    }
  }
}
