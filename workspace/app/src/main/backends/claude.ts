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

class ClaudeCompletionDetector implements CompletionDetector {
  private fileSize = 0;
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private pendingNotify: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(
    private readonly jsonlPath: string,
    private readonly onActivity: (type: string) => void
  ) {
    try {
      const stat = fs.statSync(jsonlPath);
      this.fileSize = stat.size;
    } catch {
      this.fileSize = 0;
    }
    this.pollInterval = setInterval(() => this.checkForChanges(), 500);
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
          } else if (msg.type === "user") {
            // Distinguish real user input (string content) from tool_result
            // (array content). Only real user input means "user already saw
            // the previous turn", which should cancel a pending notify.
            const content = msg.message?.content ?? msg.content;
            if (typeof content === "string") {
              shouldScheduleNotify = false;
              this.cancelPending();
            }
          }
        } catch {
          // skip invalid JSON
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

  createCompletionDetector(sessionId, onActivity) {
    // For claude, sessionId maps directly to a jsonl file under PROJECTS_DIR.
    // We need the cwd to construct the full path, but we only have sessionId
    // here. Solution: store a reverse map at discovery time. For now, find
    // the jsonl by scanning known projects directories for `<sessionId>.jsonl`.
    const jsonlPath = findJsonlBySessionId(sessionId);
    if (!jsonlPath) {
      // Return a no-op detector if we can't locate the file
      return { stop() {} };
    }
    return new ClaudeCompletionDetector(jsonlPath, onActivity);
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
