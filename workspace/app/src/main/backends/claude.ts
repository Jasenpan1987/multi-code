import fs from "fs";
import path from "path";
import type {
  Backend,
  SessionDiscovery,
  SpawnConfig,
  SpawnOptions,
} from "./types";
import { keystrokeForOption } from "../remote/promptExtract";
import { ClaudeHookAttention } from "./claudeHooks";
import type { TranscriptEntry } from "../../shared/remote-protocol";
import type { ContextUsage } from "../../shared/types";
import { resolvePath } from "./resolvePath";
import { INSTANCE_ENV, SPAWN_ENV } from "./instance-env";

const HOME = process.env.HOME || "";
const SESSIONS_DIR = path.join(HOME, ".claude/sessions");
// Where the CLI keeps the model overrides that reveal the context window size. Read
// rather than written — it is the user's file.
const CLAUDE_SETTINGS_PATH = path.join(HOME, ".claude/settings.json");
const PROJECTS_DIR = path.join(HOME, ".claude/projects");

function findClaudeBinary(): string {
  const candidates = [
    path.join(HOME, ".local/bin/claude"),
    "/usr/local/bin/claude",
    "/opt/homebrew/bin/claude",
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return "claude";
}

const claudePath = findClaudeBinary();

// Claude names its per-project directory after the cwd with slashes replaced.
// It uses the path it resolved, so the encoding has to start from the resolved
// form too: on macOS `/tmp` is a symlink to `/private/tmp`, and encoding the
// unresolved path yields a directory that doesn't exist.
export function encodeProjectDir(cwd: string): string {
  return resolvePath(cwd).replace(/\//g, "-");
}

function hasExistingSession(cwd: string): boolean {
  const projectDir = path.join(PROJECTS_DIR, encodeProjectDir(cwd));
  try {
    return fs.readdirSync(projectDir).some((f) => f.endsWith(".jsonl"));
  } catch {
    return false;
  }
}

// The session a running claude is working in *now*, from the CLI's own registry.
//
// `~/.claude/sessions/<pid>.json` is maintained by the CLI and carries a
// `sessionId` that it rewrites when the session changes. Measured 2026-09-17
// against 2.1.274: after `/new`, the same pid's entry moved from
// `89f7d163…` to `75e23772…` while the old transcript stopped growing entirely.
// That makes this authoritative, where picking the newest file by mtime is a
// guess that can land on another instance's transcript.
//
// Keyed on the pty child's pid, verified to be the pid the registry uses. The
// cwd is checked as well, because pids are recycled and a stale entry from a
// dead process would otherwise point every read at an unrelated session.
export function findClaudeLiveSessionId(
  cwd: string,
  pid: number
): string | null {
  const target = resolvePath(cwd);

  try {
    const data = JSON.parse(
      fs.readFileSync(path.join(SESSIONS_DIR, `${pid}.json`), "utf8")
    );
    if (
      typeof data.sessionId === "string" &&
      typeof data.cwd === "string" &&
      resolvePath(data.cwd) === target
    ) {
      return data.sessionId;
    }
  } catch {
    // No entry for this pid. Falls through to the cwd scan below, which covers a
    // CLI that ever keys the registry on something other than the process we
    // spawned.
  }

  // Fallback: a single entry for this directory is unambiguous. Two or more and
  // there is no way to tell which process is ours, so nothing is returned —
  // guessing here would silently point one instance at another's transcript.
  try {
    const matches: string[] = [];
    for (const file of fs.readdirSync(SESSIONS_DIR)) {
      if (!file.endsWith(".json")) continue;
      try {
        const data = JSON.parse(
          fs.readFileSync(path.join(SESSIONS_DIR, file), "utf8")
        );
        if (typeof data.cwd !== "string") continue;
        if (typeof data.sessionId !== "string") continue;
        if (resolvePath(data.cwd) !== target) continue;
        matches.push(data.sessionId);
      } catch {
        continue;
      }
    }
    return matches.length === 1 ? matches[0] : null;
  } catch {
    return null;
  }
}

function findJsonlByCwd(
  cwd: string,
  isClaimed?: (sessionId: string) => boolean
): string | null {
  try {
    const files = fs.readdirSync(SESSIONS_DIR);
    let bestMatch: { sessionId: string; startedAt: number } | null = null;
    const target = resolvePath(cwd);

    for (const file of files) {
      try {
        const data = JSON.parse(
          fs.readFileSync(path.join(SESSIONS_DIR, file), "utf8")
        );
        // Compare resolved paths: the session file records the path Claude
        // resolved, which can differ from the one the instance was configured
        // with. A literal compare silently finds nothing, and the instance then
        // gets no completion or prompt detection at all.
        if (typeof data.cwd !== "string") continue;
        if (resolvePath(data.cwd) !== target) continue;
        if (isClaimed && isClaimed(data.sessionId)) continue;
        if (data.startedAt > (bestMatch?.startedAt || 0)) {
          bestMatch = { sessionId: data.sessionId, startedAt: data.startedAt };
        }
      } catch {
        continue;
      }
    }

    if (!bestMatch) return null;

    const jsonlPath = path.join(
      PROJECTS_DIR,
      encodeProjectDir(cwd),
      `${bestMatch.sessionId}.jsonl`
    );
    if (fs.existsSync(jsonlPath)) return jsonlPath;
    return null;
  } catch {
    return null;
  }
}

// The newest session this directory has on disk, by transcript mtime.
//
// Deliberately *not* the `~/.claude/sessions/` registry that `findJsonlByCwd`
// above reads: that only lists live processes, so it answers nothing for a stopped
// instance — which is the whole case this exists for. The project directory keeps
// one JSONL per session and outlives the process.
//
// mtime rather than the id or the name: a session's file is touched on every turn,
// so the most recently written one is the most recently worked in, which is the
// history a user asking "what was this repo doing" means.
// `projectsRoot` is overridable so tests can point at a scratch tree; production
// always uses the real one.
export function findLatestJsonlSessionId(
  cwd: string,
  projectsRoot: string = PROJECTS_DIR
): string | null {
  const projectDir = path.join(projectsRoot, encodeProjectDir(cwd));
  let best: { sessionId: string; mtimeMs: number } | null = null;
  try {
    for (const file of fs.readdirSync(projectDir)) {
      if (!file.endsWith(".jsonl")) continue;
      try {
        const { mtimeMs } = fs.statSync(path.join(projectDir, file));
        if (mtimeMs > (best?.mtimeMs ?? -1)) {
          best = { sessionId: file.slice(0, -".jsonl".length), mtimeMs };
        }
      } catch {
        // A file that vanished between readdir and stat. Skip it.
        continue;
      }
    }
  } catch {
    // No project directory: this cwd has never been used with claude.
    return null;
  }
  return best?.sessionId ?? null;
}

// Markers the CLI sets on its own child processes. Multi-Code may itself have been
// launched from inside a Claude Code session — `pnpm start` typed at an agent's
// prompt is enough — and then every agent it spawns inherits them, with real
// consequences:
//
//   CLAUDE_CODE_CHILD_SESSION  turns transcript saving OFF, which silently breaks
//                              session discovery, completion detection and context
//                              usage, since all three read that transcript
//   CLAUDE_CODE_EXECPATH       pins the child to the parent's CLI version instead
//                              of whatever the launcher resolves to
//   CLAUDE_CODE_SESSION_ID     hands the child an id that isn't its own
//   CLAUDE_EFFORT              forces the parent's effort level, and its cost
//
// Observed 2026-09-15: an app started this way produced agents with "Transcript
// saving is off" and no session file at all. Each instance we spawn is its own
// top-level session, so these are cleared rather than passed through.
const INHERITED_CLI_MARKERS = [
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDECODE",
  "CLAUDE_PID",
  "CLAUDE_EFFORT",
];

function buildEnv(): Record<string, string> {
  const env = { ...process.env } as Record<string, string>;
  for (const key of INHERITED_CLI_MARKERS) delete env[key];
  delete env[INSTANCE_ENV];
  delete env[SPAWN_ENV];
  return {
    ...env,
    PATH: [
      path.join(HOME, ".local/bin"),
      "/opt/homebrew/bin",
      "/usr/local/bin",
      process.env.PATH || "",
    ].join(":"),
  };
}

// The registry status of a running claude: `idle`, `busy`, `waiting`, `shell`, or
// null when the entry can't be read. Read only to confirm a `Stop` the CLI
// reported through a hook (see claudeHooks.ts), never as an event source.
export function readClaudeRegistryStatus(pid: number): string | null {
  try {
    const data = JSON.parse(
      fs.readFileSync(path.join(SESSIONS_DIR, `${pid}.json`), "utf8")
    );
    return typeof data.status === "string" ? data.status : null;
  } catch {
    return null;
  }
}

class ClaudeSessionDiscovery implements SessionDiscovery {
  private interval: ReturnType<typeof setInterval> | null = null;

  constructor(
    cwd: string,
    onFound: (sessionId: string) => void,
    isClaimed?: (sessionId: string) => boolean
  ) {
    // Poll until the session appears, for as long as the instance lives.
    //
    // There is deliberately NO attempt cap. The session jsonl is only created
    // once the first user message lands, and that can come minutes after the
    // CLI spawns (a fresh project sitting at the input prompt). Giving up
    // after a fixed window — as an earlier version did — silently killed
    // completion AND prompt notifications for the instance's whole lifetime:
    // the user types their first message, the agent finishes the turn, and
    // nothing ever beeps. Cleanup is safe without a cap because the process
    // manager cancels this handle on instance exit/restart/removal.
    this.interval = setInterval(() => {
      const jsonlPath = findJsonlByCwd(cwd, isClaimed);
      if (!jsonlPath) return;

      const sessionId = path.basename(jsonlPath, ".jsonl");
      // Final claim check — another instance's discovery may have committed
      // to this sessionId on the same tick. If so, keep polling.
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

export const claudeBackend: Backend = {
  name: "claude",

  spawn(cwd: string, opts?: SpawnOptions): SpawnConfig {
    const args = hasExistingSession(cwd) ? ["--continue"] : [];

    // No --strict-mcp-config: it would hide the user's own MCP servers from the
    // manager, and those are theirs to make use of. Ours is additive.
    if (opts?.mcpConfigPath) {
      args.push("--mcp-config", opts.mcpConfigPath);
    }
    if (opts?.allowedTools?.length) {
      args.push("--allowedTools", opts.allowedTools.join(","));
    }
    // Additive, like --mcp-config above: the CLI merges this on top of the user's
    // own settings files rather than replacing them, so their hooks and rules for
    // this directory still apply. Only one --settings ever: a second would replace
    // this one outright (measured 2026-10-07).
    if (opts?.settingsPath) {
      args.push("--settings", opts.settingsPath);
    }

    return {
      command: claudePath,
      args,
      env: buildEnv(),
    };
  },

  discoverSessionId(cwd, onFound, isClaimed) {
    return new ClaudeSessionDiscovery(cwd, onFound, isClaimed);
  },

  // The CLI reports its own state through the alert hooks every instance is
  // spawned with. Nothing here reads the transcript or the terminal for it.
  createHookAttention(pid, onActivity, onHooksHealth) {
    return new ClaudeHookAttention(
      onActivity,
      () => readClaudeRegistryStatus(pid),
      undefined,
      onHooksHealth
    );
  },

  // Claude's option boxes accept the option's number directly, for every kind of
  // prompt it raises, so the tool name doesn't change the answer.
  keystrokeForChoice(_tool, index, optionCount): string | null {
    return keystrokeForOption(index, optionCount);
  },

  readTranscript(sessionId, limit): TranscriptEntry[] {
    const jsonlPath = findJsonlBySessionId(sessionId);
    if (!jsonlPath) return [];
    return readClaudeTranscript(jsonlPath, limit);
  },

  readContextUsage(sessionId): ContextUsage | null {
    const jsonlPath = findJsonlBySessionId(sessionId);
    if (!jsonlPath) return null;
    return readClaudeContextUsage(jsonlPath);
  },

  findLatestSessionId(cwd: string): string | null {
    return findLatestJsonlSessionId(cwd);
  },

  findLiveSessionId(cwd: string, pid: number): string | null {
    return findClaudeLiveSessionId(cwd, pid);
  },

  buildResumeCommand(sessionId: string): string {
    return `claude --resume ${sessionId}`;
  },
};

// Turn the tail of a session JSONL into reflowable lines for the phone.
//
// Only the entry kinds a human skims for are kept: what the agent said, what the
// user asked, and which tools ran. Thinking blocks, tool results, and the CLI's
// own bookkeeping rows (file-history-delta, attachment, mode, …) are dropped —
// on a phone they'd bury the two lines that matter.
export function readClaudeTranscript(
  jsonlPath: string,
  limit: number
): TranscriptEntry[] {
  let raw: string;
  try {
    raw = fs.readFileSync(jsonlPath, "utf8");
  } catch {
    return [];
  }

  const lines = raw.split("\n");
  const entries: TranscriptEntry[] = [];
  // Tool uses still awaiting a result, so they can be marked pending — that's
  // the tool the agent is currently on, which is what a phone is for.
  const unpaired = new Set<string>();
  // Entry index -> tool_use id, so the pending flags can be resolved after the
  // whole file is read. Local to the call: two instances read concurrently.
  const toolEntryIds = new Map<number, string>();

  for (const line of lines) {
    if (!line.trim()) continue;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }

    const message = msg.message as Record<string, unknown> | undefined;
    const content = message?.content;

    if (msg.type === "user") {
      // A string body is something the user actually typed. Array bodies are
      // tool results, which only matter here for pairing.
      if (typeof content === "string") {
        const text = content.trim();
        if (text) entries.push({ kind: "user", text });
      } else if (Array.isArray(content)) {
        for (const item of content) {
          const entry = item as Record<string, unknown>;
          if (entry?.type === "tool_result" && typeof entry.tool_use_id === "string") {
            unpaired.delete(entry.tool_use_id);
          }
        }
      }
      continue;
    }

    if (msg.type !== "assistant" || !Array.isArray(content)) continue;

    for (const item of content) {
      const entry = item as Record<string, unknown>;
      if (entry?.type === "text" && typeof entry.text === "string") {
        const text = entry.text.trim();
        if (text) entries.push({ kind: "assistant", text });
        continue;
      }
      if (entry?.type === "tool_use" && typeof entry.name === "string") {
        if (typeof entry.id === "string") unpaired.add(entry.id);
        const summary = summarizeTranscriptTool(entry.name, entry.input);
        entries.push({
          kind: "tool",
          tool: entry.name,
          text: summary ?? "",
        });
        if (typeof entry.id === "string") {
          toolEntryIds.set(entries.length - 1, entry.id);
        }
      }
    }
  }

  // Resolve pending only now: a tool_use paired further down the file must not
  // stay flagged from when it was first seen.
  for (const [index, id] of toolEntryIds) {
    const entry = entries[index];
    if (entry && unpaired.has(id)) entry.pending = true;
  }

  return entries.slice(-limit);
}

// How full the window is, from the newest assistant turn that reported usage.
//
// The three input fields are summed because they are disjoint parts of the same
// prompt: `input_tokens` is what wasn't cached, `cache_read_input_tokens` what was
// served from cache, `cache_creation_input_tokens` what was written into it this
// turn. Their sum is what the model actually read. `output_tokens` is excluded —
// it isn't occupying the window on the next turn.
export function readClaudeContextUsage(
  jsonlPath: string,
  settingsPath: string = CLAUDE_SETTINGS_PATH
): ContextUsage | null {
  let raw: string;
  try {
    raw = fs.readFileSync(jsonlPath, "utf8");
  } catch {
    return null;
  }

  const lines = raw.split("\n");
  // Backwards, stopping at the first usable record. These files reach 8MB+, and
  // only the newest turn answers the question, so parsing forward to the end
  // would be most of the cost for none of the benefit.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;

    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record.type !== "assistant") continue;

    const message = record.message as Record<string, unknown> | undefined;
    const usage = message?.usage as Record<string, unknown> | undefined;
    if (!usage) continue;

    const inputTokens =
      finiteNumber(usage.input_tokens) +
      finiteNumber(usage.cache_creation_input_tokens) +
      finiteNumber(usage.cache_read_input_tokens);
    // A turn that reported all zeros (an errored request, for instance) tells us
    // nothing, so keep walking back to one that does.
    if (inputTokens <= 0) continue;

    const model = typeof message?.model === "string" ? message.model : undefined;
    return {
      inputTokens,
      updatedAt: parseIsoMs(record.timestamp),
      model,
      contextWindow: readClaudeContextWindow(model, settingsPath) ?? undefined,
    };
  }

  return null;
}

// How large this model's context window is, inferred from the user's own settings.
//
// **Inferred, and fragile — which is why it returns null so readily.** The transcript
// records only a family name (`claude-opus-5`), and the CLI keeps the real model id
// in `env.ANTHROPIC_DEFAULT_<FAMILY>_MODEL` in `~/.claude/settings.json`, where a
// `[1m]` suffix is what asks for the million-token window. Observed on this machine:
// `ANTHROPIC_DEFAULT_OPUS_MODEL = au.anthropic.claude-opus-5[1m]`.
//
// Two ways this goes stale, both of which must produce null rather than a guess:
// the user switching model mid-session with `/model`, and a family with no entry in
// settings at all. Showing 45% for a session actually at 226% is worse than showing
// no percentage.
export function readClaudeContextWindow(
  model: string | undefined,
  settingsPath: string = CLAUDE_SETTINGS_PATH
): number | null {
  const family = claudeFamily(model);
  if (!family) return null;

  let env: Record<string, unknown>;
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    env = (parsed?.env ?? {}) as Record<string, unknown>;
  } catch {
    return null;
  }

  const configured = env[`ANTHROPIC_DEFAULT_${family}_MODEL`];
  if (typeof configured !== "string" || configured === "") return null;

  // The suffix is the only thing in reach that distinguishes the two windows.
  if (/\[1m\]/i.test(configured)) return 1_000_000;

  // No suffix on a model this family recognises means the standard window. Guarded
  // on the id actually naming the family, so an unrelated override doesn't get a
  // number attached to it.
  if (configured.toLowerCase().includes(family.toLowerCase())) return 200_000;

  return null;
}

// `claude-opus-5` → `OPUS`. The family is the segment after `claude-`, which is how
// the settings keys are named.
function claudeFamily(model: string | undefined): string | null {
  if (!model) return null;
  const match = /claude-([a-z]+)/i.exec(model);
  return match ? match[1].toUpperCase() : null;
}

function finiteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

// Claude writes an ISO 8601 timestamp on every record. 0 means "unknown", which
// the UI shows as a usage figure with no age rather than pretending it's now.
function parseIsoMs(value: unknown): number {
  if (typeof value !== "string") return 0;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

// One-line description of a tool call, matching what the desktop shows.
function summarizeTranscriptTool(name: string, input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const record = input as Record<string, unknown>;
  const str = (value: unknown): string | undefined =>
    typeof value === "string" && value.length > 0 ? value : undefined;

  switch (name) {
    case "Bash":
      return str(record.command);
    case "Read":
    case "Write":
    case "Edit":
    case "NotebookEdit":
      return str(record.file_path);
    case "Grep":
      return str(record.pattern);
    case "Glob":
      return str(record.pattern);
    case "WebFetch":
      return str(record.url);
    case "Task":
      return str(record.description);
    default:
      return str(record.description) ?? str(record.command);
  }
}

function findJsonlBySessionId(sessionId: string): string | null {
  try {
    const projectDirs = fs.readdirSync(PROJECTS_DIR);
    for (const dir of projectDirs) {
      const candidate = path.join(PROJECTS_DIR, dir, `${sessionId}.jsonl`);
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch {
    // ignore
  }
  return null;
}
