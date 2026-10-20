import fs from "fs";
import crypto from "crypto";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import Database from "better-sqlite3";
import type {
  Backend,
  BackendAvailability,
  BuilderTurn,
  HookAttention,
  SessionDiscovery,
  SessionStart,
  SpawnConfig,
  SpawnOptions,
} from "./types";
import {
  keystrokeForPermission,
  keystrokeForQuestion,
  PERMISSION_TOOL,
  QUESTION_TOOL_LABEL,
} from "./opencodePrompt";
import { OpencodePluginAttention } from "./opencodeAttention";
import type { TranscriptEntry } from "../../shared/remote-protocol";
import type { ContextUsage } from "../../shared/types";
import { resolvePath } from "./resolvePath";
import { debugTrace } from "../debug-trace";
import { ALERT_FILE_ENV, INSTANCE_ENV, SPAWN_ENV, withUtf8Locale } from "./instance-env";
import { opencodeCliConfig, opencodeCliConfigPath } from "./opencodePlugin";
import { latestRootSession } from "./opencodeDb";
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

const OPENCODE_DB = path.join(HOME, ".local/share/opencode/opencode.db");
// The user's own config, where a model's context limit is stated exactly. Read only.
const OPENCODE_CONFIG = path.join(HOME, ".config/opencode/opencode.json");

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
// to 2.x only"). The one command that upgrades a 1.x install, also named by the New
// Instance dialog.
export const OPENCODE_UPGRADE_COMMAND = "curl -fsSL https://opencode.ai/v2/install | bash";

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

// Open a read-only sqlite handle. Throws on failure (caller decides how to handle).
// `dbPath` is overridable so tests can point a reader at a scratch database;
// production always uses the real OpenCode store.
function openDb(dbPath: string = OPENCODE_DB): Database.Database {
  return new Database(dbPath, { readonly: true, fileMustExist: true });
}


// Find the most recently created session whose `directory` matches `cwd`.
// Returns null if not found or if the db is currently inaccessible (e.g.
// not yet created on first opencode launch).
//
// Both the stored and the requested path are resolved before comparing, because
// OpenCode records the path it resolved rather than the one it was given. On
// macOS `/tmp` is a symlink to `/private/tmp`, so an instance whose cwd is
// `/tmp/x` writes `/private/tmp/x` and a plain string compare never matches —
// session discovery then silently times out and the instance gets no prompt
// detection at all.
// `dbPath` is overridable for tests, like everywhere else in this file.
export function findLatestSessionForCwd(
  cwd: string,
  isClaimed?: (sessionId: string) => boolean,
  dbPath?: string
): string | null {
  let db: Database.Database | null = null;
  try {
    db = dbPath ? openDb(dbPath) : openDb();
    const target = resolvePath(cwd);
    // Query both spellings so the common case still hits the index: `cwd` as
    // given, and its resolved form (what OpenCode actually stored). Only when
    // neither matches literally does this fall back to resolving candidates.
    const rows = db
      .prepare(
        "SELECT id, directory FROM session WHERE directory IN (?, ?) " +
          "ORDER BY time_created DESC LIMIT 8"
      )
      .all(cwd, target) as Array<{ id: string; directory: string }>;
    for (const row of rows) {
      if (!isClaimed || !isClaimed(row.id)) return row.id;
    }
    return null;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

// The newest session for `cwd` made at or after `since` (ms, like OpenCode's own
// timestamps), or null.
export function findSessionCreatedSince(
  cwd: string,
  since: number,
  dbPath?: string
): string | null {
  let db: Database.Database | null = null;
  try {
    db = dbPath ? openDb(dbPath) : openDb();
    const row = db
      .prepare(
        "SELECT id FROM session WHERE directory IN (?, ?) AND time_created >= ? " +
          "ORDER BY time_created DESC LIMIT 1"
      )
      .get(cwd, resolvePath(cwd), since) as { id: string } | undefined;
    return row?.id ?? null;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

class OpencodeSessionDiscovery implements SessionDiscovery {
  private interval: ReturnType<typeof setInterval> | null = null;

  constructor(
    cwd: string,
    onFound: (sessionId: string) => void,
    isClaimed?: (sessionId: string) => boolean
  ) {
    // Poll until the session appears, for as long as the instance lives.
    // No attempt cap, for the same reason as the Claude backend: session
    // rows can appear long after spawn, and giving up silently kills every
    // notification for the instance's lifetime. The process manager cancels
    // this handle on exit/restart/removal, so an uncapped poll can't leak.
    this.interval = setInterval(() => {
      const sessionId = findLatestSessionForCwd(cwd, isClaimed);
      if (!sessionId) return;
      if (isClaimed && isClaimed(sessionId)) return;

      this.cancel();
      onFound(sessionId);
    }, 1000);
  }

  cancel() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }
}

// The tool OpenCode asks a question with, as its transcript names it.
const QUESTION_TOOL = "question";

// A tool part's state while the tool runs, which is how the transcript marks a call
// still in flight.
const IN_FLIGHT_STATUS = "running";

// One-line description of an OpenCode tool call. Its tool names are lowercase
// and its inputs use different keys than Claude's, so this can't be shared.
function summarizeOpencodeTool(
  tool: string,
  input: Record<string, unknown> | undefined
): string {
  if (!input) return "";
  const str = (value: unknown): string | undefined =>
    typeof value === "string" && value.length > 0 ? value : undefined;
  switch (tool) {
    case "bash":
      return str(input.command) ?? str(input.description) ?? "";
    case "read":
      return str(input.filePath) ?? "";
    case "write":
    case "edit":
    case "apply_patch":
      return str(input.filePath) ?? str(input.path) ?? "";
    case "grep":
      return str(input.pattern) ?? "";
    case "glob":
      return str(input.pattern) ?? "";
    case "webfetch":
      return str(input.url) ?? "";
    case "task":
      return str(input.description) ?? str(input.prompt) ?? "";
    case QUESTION_TOOL: {
      // Show what was asked. Without this the transcript renders a bare
      // "question" line, which is the least useful entry on the screen given
      // it's usually the one the agent is blocked on.
      const questions = input.questions;
      if (!Array.isArray(questions) || questions.length === 0) return "";
      const first = questions[0] as Record<string, unknown>;
      return str(first.question) ?? str(first.header) ?? "";
    }
    default:
      return str(input.description) ?? str(input.command) ?? "";
  }
}

// A message row's role; "assistant" when it can't be read.
function messageRole(data: string): string {
  try {
    const message = JSON.parse(data) as { role?: unknown };
    return typeof message.role === "string" ? message.role : "assistant";
  } catch {
    return "assistant";
  }
}

// One part as a transcript entry, or null for bookkeeping (step-start /
// step-finish / reasoning / patch / file / compaction). `role` is only read for a
// text part, so a caller can defer parsing the message.
function partEntry(part: Record<string, unknown>, role: () => string): TranscriptEntry | null {
  if (part.type === "text") {
    const text = typeof part.text === "string" ? part.text.trim() : "";
    if (!text) return null;
    return { kind: role() === "user" ? "user" : "assistant", text };
  }
  if (part.type === "tool" && typeof part.tool === "string") {
    const state = part.state as Record<string, unknown> | undefined;
    const input = state?.input as Record<string, unknown> | undefined;
    return {
      kind: "tool",
      tool: part.tool,
      text: summarizeOpencodeTool(part.tool, input),
      pending: state?.status === IN_FLIGHT_STATUS ? true : undefined,
    };
  }
  return null;
}

// Read the tail of an OpenCode session as reflowable lines.
//
// The `part` table holds the conversation broken into typed pieces, which maps
// onto transcript entries directly. Rows are fetched newest-first (that's what
// the index supports) and reversed, so the phone gets chronological order.
export function readOpencodeTranscript(
  sessionId: string,
  limit: number
): TranscriptEntry[] {
  let db: Database.Database | null = null;
  try {
    db = openDb();
    // Over-fetch: many rows are step markers or reasoning that get dropped, so
    // fetching exactly `limit` would usually return fewer usable entries.
    const rows = db
      .prepare(
        "SELECT p.data AS data, m.data AS message FROM part p " +
          "JOIN message m ON p.message_id = m.id " +
          "WHERE p.session_id = ? ORDER BY p.time_created DESC LIMIT ?"
      )
      .all(sessionId, limit * 6) as Array<{ data: string; message: string }>;

    const entries: TranscriptEntry[] = [];
    for (const row of rows) {
      if (entries.length >= limit) break;
      let part: Record<string, unknown>;
      try {
        part = JSON.parse(row.data);
      } catch {
        continue;
      }

      const entry = partEntry(part, () => messageRole(row.message));
      if (entry) entries.push(entry);
    }

    return entries.reverse();
  } catch {
    return [];
  } finally {
    db?.close();
  }
}

// For the language rule only, as on the Claude side: a bare "B" as the latest
// message falls back to these, newest first.
const EARLIER_MESSAGES = 3;

// How many of a session's newest messages the builder-turn reader looks at. Each
// step of an agent's turn is a message of its own, so a long turn runs to a few
// hundred; past this the turn is read without the message that started it.
export const BUILDER_TURN_SCAN_MESSAGES = 300;

// One message of a session as the builder-turn reader takes it, newest first. The
// parts are fetched only when asked for: an older assistant message's parts (its
// tool output included) are never needed.
export interface OpencodeTurnMessage {
  role: string;
  parts(): Record<string, unknown>[];
}

// What the builder typed in a user message: its text parts, minus the ones
// OpenCode wrote itself. Those are marked `synthetic` ("<system-reminder>Note: The
// user opened the file …", "Continue if you have next steps, or stop and ask …"
// after a compaction); `ignored` is honoured the same way. Null when nothing is
// left: a message of only synthetic text, a file or a compaction marker.
export function opencodeTypedText(parts: Record<string, unknown>[]): string | null {
  const text = parts
    .filter(
      (part) =>
        part.type === "text" &&
        typeof part.text === "string" &&
        part.synthetic !== true &&
        part.ignored !== true
    )
    .map((part) => part.text as string)
    .join("\n")
    .trim();
  return text || null;
}

export function opencodeBuilderTurn(newestFirst: OpencodeTurnMessage[]): BuilderTurn {
  const typed: { index: number; text: string }[] = [];
  for (let i = 0; i < newestFirst.length && typed.length <= EARLIER_MESSAGES; i++) {
    const message = newestFirst[i];
    if (message.role !== "user") continue;
    const text = opencodeTypedText(message.parts());
    if (text !== null) typed.push({ index: i, text });
  }

  const [latest, ...earlier] = typed;
  const since = newestFirst.slice(0, latest ? latest.index : newestFirst.length).reverse();
  const turn: TranscriptEntry[] = [];
  for (const message of since) {
    for (const part of message.parts()) {
      const entry = partEntry(part, () => message.role);
      if (entry) turn.push(entry);
    }
  }
  return {
    builderLatestMessage: latest?.text,
    builderEarlierMessages: earlier.reverse().map((message) => message.text),
    turn,
  };
}

// The builder's turn from OpenCode's database. Null when the session can't be read.
// `dbPath` is overridable for tests, like everywhere else in this file.
export function readOpencodeBuilderTurn(sessionId: string, dbPath?: string): BuilderTurn | null {
  let db: Database.Database | null = null;
  try {
    db = dbPath ? openDb(dbPath) : openDb();
    const rows = db
      .prepare(
        "SELECT id, data FROM message WHERE session_id = ? " +
          "ORDER BY time_created DESC, id DESC LIMIT ?"
      )
      .all(sessionId, BUILDER_TURN_SCAN_MESSAGES) as Array<{ id: string; data: string }>;
    if (rows.length === 0) return null;
    const partsOf = db.prepare("SELECT data FROM part WHERE message_id = ? ORDER BY id");
    const messages: OpencodeTurnMessage[] = rows.map((row) => {
      let cached: Record<string, unknown>[] | null = null;
      return {
        role: messageRole(row.data),
        parts: () => {
          cached ??= (partsOf.all(row.id) as Array<{ data: string }>).flatMap((part) => {
            try {
              const parsed: unknown = JSON.parse(part.data);
              return typeof parsed === "object" && parsed !== null
                ? [parsed as Record<string, unknown>]
                : [];
            } catch {
              return [];
            }
          });
          return cached;
        },
      };
    });
    return opencodeBuilderTurn(messages);
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

// How full the window is, from the newest assistant message that reported usage.
//
// Summed from the input side only: `tokens.input` plus `tokens.cache.read` and
// `tokens.cache.write`. The JSON also carries a pre-summed `tokens.total`, which
// is deliberately not used because it includes `output` — output isn't occupying
// the window on the next turn, and including it would make this number
// incomparable with the claude backend's.
//
// Do NOT use the `session` table's `tokens_*` columns for this. Those are lifetime
// totals: a real session was observed at `tokens_cache_read` of 17.1M against a
// 200k–1M window, which would read as "impossibly full" every time.
//
// `dbPath` is overridable for tests, like everywhere else in this file.
// This model's context window, from the user's opencode config.
//
// Exact rather than inferred, unlike the claude side: the config states
// `provider.<providerID>.models.<modelID>.limit.context` outright (observed 1000000
// for the Bedrock 1M models, 200000 for Haiku).
//
// Returns null for a model the config doesn't mention, which is the common case —
// the config only carries models the user has overridden, while OpenCode itself
// knows the rest from its bundled models.dev data, which we can't read. A bare token
// count is the right answer there.
export function readOpencodeContextWindow(
  model: string | undefined,
  providerId: string | undefined,
  configPath: string = OPENCODE_CONFIG
): number | null {
  if (!model) return null;

  let providers: Record<string, unknown>;
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
    providers = (parsed?.provider ?? {}) as Record<string, unknown>;
  } catch {
    return null;
  }

  // The transcript's providerID first, then any provider — the same model id under
  // two providers would carry the same limit, and a session whose provider wasn't
  // recorded still deserves an answer.
  const order = providerId
    ? [providerId, ...Object.keys(providers).filter((k) => k !== providerId)]
    : Object.keys(providers);

  for (const key of order) {
    const provider = providers[key] as Record<string, unknown> | undefined;
    const models = provider?.models as Record<string, unknown> | undefined;
    const entry = models?.[model] as Record<string, unknown> | undefined;
    const limit = entry?.limit as Record<string, unknown> | undefined;
    const context = limit?.context;
    if (typeof context === "number" && Number.isFinite(context) && context > 0) {
      return context;
    }
  }
  return null;
}

export function readOpencodeContextUsage(
  sessionId: string,
  dbPath?: string,
  configPath: string = OPENCODE_CONFIG
): ContextUsage | null {
  let db: Database.Database | null = null;
  try {
    db = dbPath ? openDb(dbPath) : openDb();
    // Newest first, then pick. The most recent row is frequently a user message
    // carrying no usage at all, so `LIMIT 1` would report nothing for a session
    // that has perfectly good numbers one row back.
    const rows = db
      .prepare(
        "SELECT data, time_updated FROM message WHERE session_id = ? " +
          "ORDER BY time_updated DESC LIMIT 40"
      )
      .all(sessionId) as Array<{ data: string; time_updated: number }>;

    for (const row of rows) {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(row.data);
      } catch {
        continue;
      }
      if (message.role !== "assistant") continue;

      const tokens = message.tokens as Record<string, unknown> | undefined;
      if (!tokens) continue;
      const cache = tokens.cache as Record<string, unknown> | undefined;

      const inputTokens =
        finiteNumber(tokens.input) +
        finiteNumber(cache?.read) +
        finiteNumber(cache?.write);
      // All zeros says nothing; keep walking back to a turn that does.
      if (inputTokens <= 0) continue;

      const model =
        typeof message.modelID === "string" ? message.modelID : undefined;
      return {
        inputTokens,
        updatedAt: finiteNumber(row.time_updated),
        model,
        contextWindow:
          readOpencodeContextWindow(
            model,
            typeof message.providerID === "string"
              ? message.providerID
              : undefined,
            configPath
          ) ?? undefined,
      };
    }

    return null;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

function finiteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
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

  discoverSessionId(cwd, onFound, isClaimed): SessionDiscovery {
    return new OpencodeSessionDiscovery(cwd, onFound, isClaimed);
  },

  // From Multi-Code's plugin, which every OpenCode spawn loads (opencodePlugin.ts).
  // Per process like Claude's, and `pid` is unused: the plugin's deliveries already
  // carry the instance and spawn they belong to.
  createHookAttention(_pid, onActivity, onHooksHealth): HookAttention {
    return new OpencodePluginAttention(onActivity, undefined, onHooksHealth);
  },

  readTranscript(sessionId, limit): TranscriptEntry[] {
    return readOpencodeTranscript(sessionId, limit);
  },

  async readBuilderTurn(sessionId) {
    return readOpencodeBuilderTurn(sessionId);
  },

  readContextUsage(sessionId): ContextUsage | null {
    return readOpencodeContextUsage(sessionId);
  },

  // The `session` table is a durable record, not a list of live processes, so the
  // query discovery already uses answers this too — just without a claim filter,
  // since here we want the directory's newest session whether or not another
  // instance owns it.
  findLatestSessionId(cwd: string): string | null {
    return findLatestSessionForCwd(cwd);
  },

  // OpenCode keeps no per-pid registry, so `pid` is unused and the newest session
  // for the directory is the best available answer. Weaker than claude's, and the
  // caller's claim check is what stops one instance adopting another's session in
  // a directory with two of them.
  //
  // Only sessions made since this process started: a contact resumed by id is
  // often in an older session than the directory's newest, and that newest one is
  // somebody else's. A session this process makes itself (`/new`) is newer than
  // its start. The session it opened is discovery's to find, not this.
  findLiveSessionId(cwd: string, _pid: number, startedAt: number): string | null {
    return findSessionCreatedSince(cwd, startedAt);
  },

  keystrokeForChoice(tool, index, optionCount): string | null {
    // The dialogs navigate on different axes, verified on a live TUI: permission
    // is a horizontal row (left/right), a single-select question is a vertical
    // list (up/down). Digits do nothing in either.
    if (tool === PERMISSION_TOOL) {
      return keystrokeForPermission(index, optionCount);
    }
    if (tool === QUESTION_TOOL_LABEL) {
      return keystrokeForQuestion(index, optionCount);
    }
    // Multi-select and unknown dialogs: decline rather than fire keystrokes at a
    // layout we haven't confirmed. For multi-select specifically, one tap can't
    // express the toggle-then-confirm flow, and half-answering would leave the
    // agent blocked while the phone showed the prompt as handled.
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

export function isOpencodeAvailable(): boolean {
  return findOpencodeBinary(opencodeBaseEnv(cachedOpencodeShellEnv())) !== null;
}
