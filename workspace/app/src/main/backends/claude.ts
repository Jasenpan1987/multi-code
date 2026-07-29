import fs from "fs";
import path from "path";
import type {
  ActivityCallback,
  Backend,
  CompletionDetector,
  SessionDiscovery,
  SpawnConfig,
} from "./types";
import { extractPromptDetail, keystrokeForOption } from "../remote/promptExtract";
import type { TranscriptEntry } from "../../shared/remote-protocol";
import { resolvePath } from "./resolvePath";

const HOME = process.env.HOME || "";
const SESSIONS_DIR = path.join(HOME, ".claude/sessions");
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

function buildEnv(): Record<string, string> {
  return {
    ...process.env,
    PATH: [
      path.join(HOME, ".local/bin"),
      "/opt/homebrew/bin",
      "/usr/local/bin",
      process.env.PATH || "",
    ].join(":"),
  } as Record<string, string>;
}

// A tool_use that is unpaired for this long is treated as "Claude is blocked
// on an interactive prompt" (permission box, AskUserQuestion, plan approval).
// Auto-approved tools pair within ~200ms; this threshold sits well above that.
const PROMPT_PENDING_MS = 1500;

// PTY must have been silent for at least this long before a pending tool_use
// is treated as a real user-waiting prompt. The CLI's spinner repaints at
// least once per second while a tool/subagent is running, so this cleanly
// separates "screen static (waiting on user)" from "spinner ticking".
const PTY_IDLE_MS = 800;

interface PendingToolUse {
  name: string;
  writtenAt: number;
  // Raw tool input, kept so a paired phone can be shown the actual question and
  // its options rather than just "the agent is waiting".
  input: unknown;
}

export class ClaudeCompletionDetector implements CompletionDetector {
  private fileSize = 0;
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private pendingNotify: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  // Tool uses written by the assistant that haven't yet been paired with a
  // matching tool_result from the user. While anything sits here long enough
  // and the PTY is silent, Claude is waiting on us.
  private pendingToolUses = new Map<string, PendingToolUse>();
  // Edge-trigger latch: once we fire "prompt" for the current waiting state,
  // don't fire again until every pending tool_use clears (i.e. user answered
  // and Claude resumed).
  private promptArmed = true;
  // True between firing "prompt" and the pending set draining. Used to emit
  // exactly one "prompt-cleared" when the question is answered, so a paired
  // phone can drop its option buttons instead of leaving a stale prompt up.
  private promptOutstanding = false;

  constructor(
    private readonly jsonlPath: string,
    private readonly onActivity: ActivityCallback,
    private readonly isPtyIdle: (ms: number) => boolean
  ) {
    try {
      const stat = fs.statSync(jsonlPath);
      this.fileSize = stat.size;
    } catch {
      this.fileSize = 0;
    }
    this.pollInterval = setInterval(() => this.tick(), 500);
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    if (this.pollInterval) clearInterval(this.pollInterval);
    if (this.pendingNotify) clearTimeout(this.pendingNotify);
    this.pollInterval = null;
    this.pendingNotify = null;
  }

  private cancelPending() {
    if (this.pendingNotify) {
      clearTimeout(this.pendingNotify);
      this.pendingNotify = null;
    }
  }

  private tick() {
    this.checkForChanges();
    this.checkForPrompt();
  }

  private checkForChanges() {
    try {
      const stat = fs.statSync(this.jsonlPath);
      if (stat.size <= this.fileSize) return;

      const fd = fs.openSync(this.jsonlPath, "r");
      const buf = Buffer.alloc(stat.size - this.fileSize);
      fs.readSync(fd, buf, 0, buf.length, this.fileSize);
      fs.closeSync(fd);

      this.fileSize = stat.size;

      const lines = buf
        .toString("utf8")
        .split("\n")
        .filter((l) => l.trim());

      let shouldScheduleNotify = false;

      for (const line of lines) {
        try {
          const msg = JSON.parse(line);
          if (msg.type === "assistant") {
            // end_turn = Claude is truly done with this turn → schedule notify
            // tool_use  = Claude is calling a tool, still working → ignore
            const stopReason = msg.message?.stop_reason;
            if (stopReason === "end_turn") {
              shouldScheduleNotify = true;
            }
            // Track every tool_use the assistant emits. They sit in
            // pendingToolUses until a matching tool_result arrives.
            const content = msg.message?.content;
            if (Array.isArray(content)) {
              for (const item of content) {
                if (
                  item?.type === "tool_use" &&
                  typeof item.id === "string"
                ) {
                  this.pendingToolUses.set(item.id, {
                    name: typeof item.name === "string" ? item.name : "",
                    writtenAt: Date.now(),
                    input: item.input,
                  });
                }
              }
            }
          } else if (msg.type === "user") {
            const content = msg.message?.content ?? msg.content;
            // String content = real user input → user already saw the turn.
            if (typeof content === "string") {
              shouldScheduleNotify = false;
              this.cancelPending();
            }
            // Array content may carry tool_result entries; pair them off so
            // their tool_use leaves the pending set.
            if (Array.isArray(content)) {
              for (const item of content) {
                if (
                  item?.type === "tool_result" &&
                  typeof item.tool_use_id === "string"
                ) {
                  this.pendingToolUses.delete(item.tool_use_id);
                }
              }
            }
          }
        } catch {
          // skip invalid JSON
        }
      }

      // Re-arm the prompt latch as soon as nothing is pending — the next
      // genuinely new "stuck" tool_use should beep again. This is also the
      // moment a reported prompt got answered, so tell listeners once.
      if (this.pendingToolUses.size === 0) {
        this.promptArmed = true;
        if (this.promptOutstanding) {
          this.promptOutstanding = false;
          this.onActivity("prompt-cleared");
        }
      }

      // Schedule notification: wait 2s to confirm Claude really stopped.
      // If a pending one already exists, replace it so the timer restarts
      // from the latest end_turn (handles bursts of end_turn in one chunk).
      if (shouldScheduleNotify) {
        this.cancelPending();
        this.pendingNotify = setTimeout(() => {
          this.pendingNotify = null;
          if (!this.stopped) this.onActivity("waiting");
        }, 2000);
      }
    } catch {
      // ignore errors
    }
  }

  // Fire "prompt" once when the JSONL says Claude is stuck on an unpaired
  // tool_use AND the PTY has gone quiet (no spinner, no streaming). The two
  // signals together cleanly separate "waiting on user" from "running a
  // long subagent or tool" — the latter keeps the spinner repainting.
  private checkForPrompt() {
    if (!this.promptArmed) return;
    if (this.pendingToolUses.size === 0) return;

    const now = Date.now();
    let oldestAge = 0;
    // The oldest unpaired tool_use is the one the CLI is blocked on, so it's
    // also the one whose question is on screen — decode that one for the phone.
    let oldest: PendingToolUse | null = null;
    for (const tu of this.pendingToolUses.values()) {
      const age = now - tu.writtenAt;
      if (age > oldestAge) {
        oldestAge = age;
        oldest = tu;
      }
    }
    if (oldestAge < PROMPT_PENDING_MS) return;

    if (!this.isPtyIdle(PTY_IDLE_MS)) return;

    this.promptArmed = false;
    this.promptOutstanding = true;
    const detail = oldest
      ? (extractPromptDetail(oldest.name, oldest.input) ?? undefined)
      : undefined;
    this.onActivity("prompt", detail);
  }
}

class ClaudeSessionDiscovery implements SessionDiscovery {
  private interval: ReturnType<typeof setInterval> | null = null;

  constructor(
    cwd: string,
    onFound: (sessionId: string) => void,
    isClaimed?: (sessionId: string) => boolean
  ) {
    let attempts = 0;
    this.interval = setInterval(() => {
      attempts++;
      if (attempts > 30) {
        this.cancel();
        return;
      }
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

  spawn(cwd: string): SpawnConfig {
    const args = hasExistingSession(cwd) ? ["--continue"] : [];
    return {
      command: claudePath,
      args,
      env: buildEnv(),
    };
  },

  discoverSessionId(cwd, onFound, isClaimed) {
    return new ClaudeSessionDiscovery(cwd, onFound, isClaimed);
  },

  createCompletionDetector(sessionId, onActivity, isPtyIdle) {
    // For claude, sessionId maps directly to a jsonl file under PROJECTS_DIR.
    // We need the cwd to construct the full path, but we only have sessionId
    // here. Solution: store a reverse map at discovery time. For now, find
    // the jsonl by scanning known projects directories for `<sessionId>.jsonl`.
    const jsonlPath = findJsonlBySessionId(sessionId);
    if (!jsonlPath) {
      // Return a no-op detector if we can't locate the file
      return { stop() {} };
    }
    return new ClaudeCompletionDetector(jsonlPath, onActivity, isPtyIdle);
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
