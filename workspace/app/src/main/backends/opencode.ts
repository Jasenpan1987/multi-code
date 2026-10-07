import fs from "fs";
import path from "path";
import { pathToFileURL } from "url";
import { execSync } from "child_process";
import Database from "better-sqlite3";
import type {
  Backend,
  HookAttention,
  SessionDiscovery,
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
import { ALERT_FILE_ENV, INSTANCE_ENV, SPAWN_ENV } from "./instance-env";
import { withMulticodePlugin } from "./opencodePlugin";

const HOME = process.env.HOME || "";

const SEARCH_PATH = [
  // opencode's official install script drops the binary here by default; it's
  // added to the user's shell rc, so it's on the login-shell PATH but NOT on
  // the sparse PATH Electron inherits when launched from Finder/Dock.
  path.join(HOME, ".opencode/bin"),
  path.join(HOME, ".local/bin"),
  "/opt/homebrew/bin",
  "/usr/local/bin",
  process.env.PATH || "",
].join(":");

const OPENCODE_DB = path.join(HOME, ".local/share/opencode/opencode.db");
// The user's own config, where a model's context limit is stated exactly. Read only.
const OPENCODE_CONFIG = path.join(HOME, ".config/opencode/opencode.json");

function findOpencodeBinary(): string {
  // Try PATH-resolve first (handles nvm-installed binaries etc.)
  try {
    const resolved = execSync("command -v opencode", {
      env: { ...process.env, PATH: SEARCH_PATH },
      encoding: "utf8",
    }).trim();
    if (resolved) return resolved;
  } catch {
    // fallthrough
  }

  const candidates = [
    path.join(HOME, ".opencode/bin/opencode"),
    path.join(HOME, ".local/bin/opencode"),
    "/opt/homebrew/bin/opencode",
    "/usr/local/bin/opencode",
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return "opencode";
}

const opencodePath = findOpencodeBinary();

function buildEnv(): Record<string, string> {
  const env = { ...process.env, PATH: SEARCH_PATH } as Record<string, string>;
  delete env[INSTANCE_ENV];
  delete env[SPAWN_ENV];
  delete env[ALERT_FILE_ENV];
  return env;
}

// Points this spawn at Multi-Code's plugin, or leaves the env as built when the
// inherited OPENCODE_CONFIG_CONTENT can't be merged into safely. The instance then
// runs without the plugin, which is a missing alert, not a changed config.
function withAlertPlugin(
  env: Record<string, string>,
  plugin: NonNullable<SpawnOptions["opencodePlugin"]>
): Record<string, string> {
  const content = withMulticodePlugin(
    env.OPENCODE_CONFIG_CONTENT,
    pathToFileURL(plugin.pluginPath).href
  );
  if (!content) {
    debugTrace("[alert-hook] inherited OPENCODE_CONFIG_CONTENT can't be merged; spawning without the plugin");
    return env;
  }
  return { ...env, OPENCODE_CONFIG_CONTENT: content, [ALERT_FILE_ENV]: plugin.targetPath };
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

      if (part.type === "text") {
        const text = typeof part.text === "string" ? part.text.trim() : "";
        if (!text) continue;
        let role = "assistant";
        try {
          const message = JSON.parse(row.message) as { role?: string };
          if (typeof message.role === "string") role = message.role;
        } catch {
          // fall back to assistant
        }
        entries.push({
          kind: role === "user" ? "user" : "assistant",
          text,
        });
        continue;
      }

      if (part.type === "tool" && typeof part.tool === "string") {
        const state = part.state as Record<string, unknown> | undefined;
        const input = state?.input as Record<string, unknown> | undefined;
        entries.push({
          kind: "tool",
          tool: part.tool,
          text: summarizeOpencodeTool(part.tool, input),
          pending: state?.status === IN_FLIGHT_STATUS ? true : undefined,
        });
      }
      // step-start / step-finish / reasoning / patch: bookkeeping, not content.
    }

    return entries.reverse();
  } catch {
    return [];
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
  // Out of the voice secretary's v1 (its PRD, Out of Scope).
  keepsSecretaryEvents: false,

  spawn(_cwd: string, opts?: SpawnOptions): SpawnConfig {
    // OpenCode handles "no prior session" gracefully — always pass --continue.
    //
    // Of SpawnOptions only `opencodePlugin` applies. The settings file is a Claude
    // `--settings` file, and the rest exists for the manager, which is claude-only
    // for now. OpenCode does support MCP, but through a different config shape, and
    // `--allowedTools` has no equivalent — so a manager running here would stop for
    // a permission prompt on every tool call. The create path refuses to make an
    // OpenCode manager rather than silently producing one that can't work.
    const env = buildEnv();
    return {
      command: opencodePath,
      args: ["--continue"],
      env: opts?.opencodePlugin ? withAlertPlugin(env, opts.opencodePlugin) : env,
    };
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
  findLiveSessionId(cwd: string): string | null {
    return findLatestSessionForCwd(cwd);
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

  buildResumeCommand(sessionId: string): string {
    // `opencode tui --session <id>` is the explicit form for resuming a
    // specific session in the interactive TUI (the bare `opencode --session`
    // shorthand also works, but this is unambiguous when pasted elsewhere).
    return `opencode tui --session ${sessionId}`;
  },
};

export function isOpencodeAvailable(): boolean {
  // Re-check at call time (PATH may differ from spawn time).
  try {
    execSync("command -v opencode", {
      env: { ...process.env, PATH: SEARCH_PATH },
      encoding: "utf8",
      stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
}
