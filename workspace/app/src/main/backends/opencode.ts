import fs from "fs";
import crypto from "crypto";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import type {
  Backend,
  BackendAvailability,
  HookAttention,
  SessionDiscovery,
  SessionStart,
  SpawnConfig,
  SpawnOptions,
} from "./types";
import { OpencodeAttention } from "./opencodeAttention";
import { debugTrace } from "../debug-trace";
import { OPENCODE_UPGRADE_COMMAND } from "../../shared/types";
import { ALERT_FILE_ENV, INSTANCE_ENV, SPAWN_ENV, withUtf8Locale } from "./instance-env";
import { opencodeCliConfig, opencodeCliConfigPath } from "./opencodePlugin";
import {
  latestRootSession,
  readOpencodeBuilderTurn,
  readOpencodeContextUsage,
  readOpencodeTranscript,
} from "./opencodeDb";
import { registrationPath } from "./opencodeService";
import { cachedOpencodeShellEnv, opencodeShellEnv, warmOpencodeShellEnv } from "./opencodeShellEnv";

const HOME = process.env.HOME || "";

// Where OpenCode is commonly installed, added to the PATH of every OpenCode spawn
// after what it already has. A Dock launch's PATH is launchd's bare one, so without
// these a missing login-shell env would also mean a missing binary.
function searchPathEntries(): string[] {
  return [
    // opencode's official install script drops the binary here by default; it's
    // added to the user's shell rc, so it's on the login-shell PATH but NOT on
    // the sparse PATH Electron inherits when launched from Finder/Dock.
    path.join(HOME, ".opencode/bin"),
    path.join(HOME, ".local/bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    ...(process.env.PATH || "").split(":"),
  ].filter(Boolean);
}

const SEARCH_PATH = searchPathEntries().join(":");

// Claude Code's IDE-integration port. OpenCode's TUI reads it too and connects to
// that socket as its editor (`packages/tui/src/context/editor.ts:117`), so a
// Multi-Code started from a Claude Code terminal would hand every OpenCode contact
// someone else's IDE.
const CLAUDE_IDE_PORT_ENV = "CLAUDE_CODE_SSE_PORT";

// The TUI's per-process settings (backends/opencodePlugin.ts).
const CLI_CONFIG_ENV = "OPENCODE_CLI_CONFIG_CONTENT";

// What a spawn takes out of the env it starts from: every variable of Multi-Code's
// own (process-manager adds this spawn's ids itself; a dev build launched from inside
// a Multi-Code session would otherwise pass the parent's on), and the IDE port.
function withoutMulticode(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (key.startsWith("MULTICODE_") || key === CLAUDE_IDE_PORT_ENV) continue;
    out[key] = value;
  }
  return out;
}

// The env when the login shell's can't be had: Multi-Code's own, as every OpenCode
// spawn got before 2026-10-20.
function buildEnv(): Record<string, string> {
  return withUtf8Locale({ ...withoutMulticode(process.env), PATH: SEARCH_PATH });
}

// The env an OpenCode spawn starts from: the builder's login-shell env when it could
// be read (opencodeShellEnv.ts), its PATH extended by the usual install directories it
// doesn't already list, else `fallback`. Multi-Code's variables stripped either way,
// and a UTF-8 locale filled in when there is none.
export function opencodeBaseEnv(
  login: Record<string, string> | null,
  fallback: () => Record<string, string> = buildEnv,
  extraPath: string[] = searchPathEntries()
): Record<string, string> {
  if (!login) return fallback();
  const env = withoutMulticode(login);
  const entries = (env.PATH || "").split(":").filter(Boolean);
  for (const entry of extraPath) if (!entries.includes(entry)) entries.push(entry);
  env.PATH = entries.join(":");
  return withUtf8Locale(env);
}

// The `opencode` this env would run: the first executable one on its PATH, found
// in-process so no shell is needed. Null when there is none.
export function findOpencodeBinary(env: Record<string, string | undefined>): string | null {
  for (const dir of (env.PATH || "").split(":")) {
    if (!dir || !path.isAbsolute(dir)) continue;
    const candidate = path.join(dir, "opencode");
    try {
      if (!fs.statSync(candidate).isFile()) continue;
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Not here.
    }
  }
  return null;
}

// ---------------------------------------------------------------- version

// Multi-Code drives OpenCode 2 only (decisions.md, 2026-10-16 "OpenCode support moves
// to 2.x only"); a 1.x install is refused with the upgrade command.
export { OPENCODE_UPGRADE_COMMAND };

export interface OpencodeVersion {
  version: string;
  major: number;
}

// `opencode --version` prints `opencode v2.0.32` on 2.x and a bare `1.18.35` on 1.x.
// Null for anything without a version in it.
export function parseOpencodeVersion(output: string): OpencodeVersion | null {
  const match = /\bv?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(output);
  if (!match) return null;
  return { version: match[1], major: Number(match[1].split(".")[0]) };
}

export function opencodeRefusal(version: string): string {
  return `Multi-Code needs OpenCode 2 (found ${version}). Upgrade with: ${OPENCODE_UPGRADE_COMMAND}`;
}

// One `--version` run per installed binary, about 60 ms. Keyed on the file's identity,
// not only its mtime: the official installer's binary carries a fixed 1985 mtime, so
// an upgrade in place would keep it, while the inode and ctime change.
const versionCache = new Map<string, OpencodeVersion | null>();

function binaryIdentity(binary: string): string | null {
  try {
    const stat = fs.statSync(binary);
    return `${binary}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  } catch {
    return null;
  }
}

function runVersion(binary: string, env: Record<string, string>): string | null {
  try {
    return execFileSync(binary, ["--version"], {
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    });
  } catch {
    return null;
  }
}

// Null when the version can't be told (no binary, it didn't answer, it printed
// something else). Not cached then, so the next check asks again, and not a refusal:
// an OpenCode Multi-Code can't identify is still started, and a 1.x one prints its
// version.
export function opencodeVersion(
  binary: string,
  env: Record<string, string>,
  run: (binary: string, env: Record<string, string>) => string | null = runVersion
): OpencodeVersion | null {
  const identity = binaryIdentity(binary);
  if (identity && versionCache.has(identity)) return versionCache.get(identity) ?? null;
  const output = run(binary, env);
  const version = output === null ? null : parseOpencodeVersion(output);
  if (identity && version) versionCache.set(identity, version);
  return version;
}

// ---------------------------------------------------------------- session ids

// OpenCode's own id scheme (`packages/schema/src/identifier.ts`, `descending()`):
// `ses_`, 12 hex of the bit-inverted `ms * 4096 + counter`, 14 base62. Inverted so a
// newer id sorts first; the counter keeps ids minted in one millisecond apart and in
// order. `--session <id>` accepts an id minted outside ("Session ID to continue, or to
// create if it does not exist"); the first prompt creates the session under it
// (spike, G-601: the DB row 11 ms after Enter).
const ID_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
let lastIdTimestamp = 0;
let idCounter = 0;

export function mintOpencodeSessionId(
  timestamp: number = Date.now(),
  random: (size: number) => Uint8Array = (size) => crypto.randomBytes(size)
): string {
  if (timestamp !== lastIdTimestamp) {
    lastIdTimestamp = timestamp;
    idCounter = 0;
  }
  idCounter++;
  const value = ~(BigInt(timestamp) * 0x1000n + BigInt(idCounter));
  let time = "";
  for (let i = 0; i < 6; i++) {
    time += Number((value >> BigInt(40 - 8 * i)) & 0xffn).toString(16).padStart(2, "0");
  }
  return "ses_" + time + Array.from(random(14), (byte) => ID_CHARS[byte % 62]).join("");
}

// ---------------------------------------------------------------- the service

// Whether a live shared service is registered: its registration file exists and
// parses, and its pid answers signal 0. EPERM means alive, just not ours.
export function liveServiceRegistered(
  env: Record<string, string | undefined>,
  isAlive: (pid: number) => boolean = pidAlive
): boolean {
  try {
    const raw: unknown = JSON.parse(
      fs.readFileSync(registrationPath(env, env.HOME || os.homedir()), "utf8")
    );
    const pid = (raw as { pid?: unknown } | null)?.pid;
    return typeof pid === "number" && Number.isInteger(pid) && pid > 0 && isAlive(pid);
  } catch {
    return false;
  }
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

// When no service runs, the pty starts one before the TUI (decisions.md, 2026-10-20).
// The service keeps the environment of whoever starts it, for every client, so it
// must not be the TUI: a TUI-started service carried `MULTICODE_*` and
// OPENCODE_CLI_CONFIG_CONTENT into the shells of every client's subagents, a plain
// terminal's too (spike, G-604). `opencode service start` with this env minus those is
// one started from a terminal. It waits until the service answers, and leaves a
// running one alone, so a race with another client costs nothing.
//
// In the pty's own command rather than from main: the start takes a second or so,
// and Electron's main thread must not wait on it. The binary and the TUI's arguments
// travel as positional parameters (`$0`, `$@`), so nothing is quoted; `exec` keeps
// the pty's pid the TUI's. A failed start still runs the TUI, which then starts the
// service itself, as it would in any terminal.
export const SERVICE_START_SCRIPT =
  "/usr/bin/env " +
  [INSTANCE_ENV, SPAWN_ENV, ALERT_FILE_ENV, CLI_CONFIG_ENV, CLAUDE_IDE_PORT_ENV]
    .map((name) => `-u ${name}`)
    .join(" ") +
  ' "$0" service start >/dev/null 2>&1; exec "$0" "$@"';

// ---------------------------------------------------------------- spawn

// Everything a spawn reads from the machine, so tests never touch the real HOME, DB,
// service or shell.
export interface OpencodeSpawnHost {
  // The env the spawn starts from (opencodeBaseEnv).
  env(): Record<string, string>;
  binary(env: Record<string, string>): string | null;
  version(binary: string, env: Record<string, string>): OpencodeVersion | null;
  serviceRunning(env: Record<string, string>): boolean;
  latestRootSession(cwd: string): string | null;
  mintSessionId(): string;
  readFile(file: string): string;
}

export const defaultOpencodeSpawnHost: OpencodeSpawnHost = {
  env: () => opencodeBaseEnv(opencodeShellEnv()),
  binary: findOpencodeBinary,
  version: (binary, env) => opencodeVersion(binary, env),
  serviceRunning: (env) => liveServiceRegistered(env),
  latestRootSession: (cwd) => latestRootSession(cwd),
  mintSessionId: () => mintOpencodeSessionId(),
  readFile: (file) => fs.readFileSync(file, "utf8"),
};

// The session a spawn opens. Always named, so the contact owns it from its first
// moment and discovery never has to guess:
//   - own: the contact's id. Resumed, or created under that id by the first prompt
//     when it is gone or was never typed in (OpenCode allows both).
//   - latest: the directory's newest root session (process-manager already turned one
//     another contact holds into "fresh"), else a new id.
//   - fresh: a new id.
function sessionIdFor(cwd: string, session: SessionStart, host: OpencodeSpawnHost): string {
  if (session.kind === "own") return session.sessionId;
  if (session.kind === "latest") return host.latestRootSession(cwd) ?? host.mintSessionId();
  return host.mintSessionId();
}

export function buildOpencodeSpawn(
  cwd: string,
  opts: SpawnOptions | undefined,
  session: SessionStart | undefined,
  host: OpencodeSpawnHost = defaultOpencodeSpawnHost
): SpawnConfig {
  const base = host.env();
  const binary = host.binary(base) ?? "opencode";

  const version = host.version(binary, base);
  if (version && version.major < 2) {
    return { command: binary, args: [], env: base, refusal: opencodeRefusal(version.version) };
  }

  const sessionId = sessionIdFor(cwd, session ?? { kind: "latest" }, host);
  const args = ["--session", sessionId];

  const plugin = opts?.opencodePlugin;
  const cli = opencodeCliConfig({
    inherited: base[CLI_CONFIG_ENV],
    cliJsonPath: opencodeCliConfigPath(base),
    pluginDir: plugin?.pluginPath,
    readFile: host.readFile,
  });
  const env: Record<string, string> = { ...base };
  if (cli) env[CLI_CONFIG_ENV] = cli.content;
  if (cli?.plugin && plugin) {
    env[ALERT_FILE_ENV] = plugin.targetPath;
  } else if (plugin) {
    debugTrace("[alert-hook] the builder's TUI plugin settings can't be read safely; OpenCode spawns without Multi-Code's plugin");
  }

  if (host.serviceRunning(env)) return { command: binary, args, env, sessionId };
  return { command: "/bin/sh", args: ["-c", SERVICE_START_SCRIPT, binary, ...args], env, sessionId };
}

export const opencodeBackend: Backend = {
  name: "opencode",
  keepsSecretaryEvents: true,

  // Of SpawnOptions only `opencodePlugin` applies. The settings file is a Claude
  // `--settings` file, and the rest exists for the manager, which is claude-only
  // for now. OpenCode does support MCP, but through a different config shape, and
  // `--allowedTools` has no equivalent — so a manager running here would stop for
  // a permission prompt on every tool call. The create path refuses to make an
  // OpenCode manager rather than silently producing one that can't work.
  spawn(cwd: string, opts?: SpawnOptions, session?: SessionStart): SpawnConfig {
    return buildOpencodeSpawn(cwd, opts, session);
  },

  // The login shell takes about 1.4 s; read now, the first start finds it cached.
  warm() {
    void warmOpencodeShellEnv();
  },

  // Never needed: every spawn names its session up front (`--session`, the contact's
  // own id or one minted here), so process-manager skips discovery. A handle that
  // does nothing, for the interface.
  discoverSessionId(): SessionDiscovery {
    return { cancel() {} };
  },

  // Finished and Needs-you from the shared service's event stream, the shown session
  // from Multi-Code's TUI plugin (opencodeAttention.ts). Per process like Claude's;
  // `pid` is unused: the plugin's deliveries carry the instance and spawn they belong
  // to, and the service's events name their sessions.
  createHookAttention(_pid, onActivity, onHooksHealth, context): HookAttention {
    return new OpencodeAttention(onActivity, onHooksHealth, context);
  },

  // OpenCode 2's own tables, read-only (opencodeDb.ts).
  readTranscript(sessionId, limit) {
    return readOpencodeTranscript(sessionId, limit);
  },

  async readBuilderTurn(sessionId) {
    return readOpencodeBuilderTurn(sessionId);
  },

  readContextUsage(sessionId) {
    return readOpencodeContextUsage(sessionId);
  },

  // The directory's newest root session, whoever holds it: a read path, and what
  // `sessionStartFor` checks against the claims before a "latest" spawn opens it.
  findLatestSessionId(cwd: string): string | null {
    return latestRootSession(cwd);
  },

  // The terminal reports the session it shows itself (the TUI plugin's route,
  // `AttentionContext.onSessionShown`), so there is nothing to poll for.
  findLiveSessionId(): string | null {
    return null;
  },

  // OpenCode 2's dialogs are answered through its API by request id
  // (HookAttention.answer, opencodeAnswer.ts), never by keystrokes.
  keystrokeForChoice(): string | null {
    return null;
  },

  // What the TUI itself prints on exit (`Continue  opencode -s <id>`,
  // `packages/tui/src/util/presentation.ts:32`); it works from any directory.
  buildResumeCommand(sessionId: string): string {
    return `opencode -s ${sessionId}`;
  },
};

// Whether OpenCode can be started, and why not: missing, or a 1.x Multi-Code no
// longer drives. Never waits on the login shell: it starts reading it in the
// background (the New Instance dialog asks this first, so the env is ready by the
// spawn) and looks for the binary in what is known now.
export function opencodeAvailability(): BackendAvailability {
  void warmOpencodeShellEnv();
  const env = opencodeBaseEnv(cachedOpencodeShellEnv());
  const binary = findOpencodeBinary(env);
  if (!binary) return { ok: false, reason: "missing" };
  const version = opencodeVersion(binary, env);
  if (version && version.major < 2) return { ok: false, reason: "outdated", version: version.version };
  return { ok: true };
}
