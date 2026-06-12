import fs from "fs";
import path from "path";
import type {
  Backend,
  CompletionDetector,
  SessionDiscovery,
  SpawnConfig,
} from "./types";

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

function hasExistingSession(cwd: string): boolean {
  const encodedCwd = cwd.replace(/\//g, "-");
  const projectDir = path.join(PROJECTS_DIR, encodedCwd);
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

    for (const file of files) {
      try {
        const data = JSON.parse(
          fs.readFileSync(path.join(SESSIONS_DIR, file), "utf8")
        );
        if (data.cwd !== cwd) continue;
        if (isClaimed && isClaimed(data.sessionId)) continue;
        if (data.startedAt > (bestMatch?.startedAt || 0)) {
          bestMatch = { sessionId: data.sessionId, startedAt: data.startedAt };
        }
      } catch {
        continue;
      }
    }

    if (!bestMatch) return null;

    const encodedCwd = cwd.replace(/\//g, "-");
    const jsonlPath = path.join(
      PROJECTS_DIR,
      encodedCwd,
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

  constructor(
    private readonly jsonlPath: string,
    private readonly onActivity: (type: string) => void,
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
      // genuinely new "stuck" tool_use should beep again.
      if (this.pendingToolUses.size === 0) {
        this.promptArmed = true;
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
    for (const tu of this.pendingToolUses.values()) {
      const age = now - tu.writtenAt;
      if (age > oldestAge) oldestAge = age;
    }
    if (oldestAge < PROMPT_PENDING_MS) return;

    if (!this.isPtyIdle(PTY_IDLE_MS)) return;

    this.promptArmed = false;
    this.onActivity("prompt");
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

  buildResumeCommand(sessionId: string): string {
    return `claude --resume ${sessionId}`;
  },
};

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
