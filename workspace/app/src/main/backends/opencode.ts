import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import Database from "better-sqlite3";
import type {
  Backend,
  CompletionDetector,
  SessionDiscovery,
  SpawnConfig,
} from "./types";

const HOME = process.env.HOME || "";

const SEARCH_PATH = [
  path.join(HOME, ".local/bin"),
  "/opt/homebrew/bin",
  "/usr/local/bin",
  process.env.PATH || "",
].join(":");

const OPENCODE_DB = path.join(HOME, ".local/share/opencode/opencode.db");

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
  return {
    ...process.env,
    PATH: SEARCH_PATH,
  } as Record<string, string>;
}

// Open a read-only sqlite handle. Throws on failure (caller decides how to handle).
function openDb(): Database.Database {
  return new Database(OPENCODE_DB, { readonly: true, fileMustExist: true });
}

// Find the most recently created session whose `directory` matches `cwd`.
// Returns null if not found or if the db is currently inaccessible (e.g.
// not yet created on first opencode launch).
function findLatestSessionForCwd(
  cwd: string,
  isClaimed?: (sessionId: string) => boolean
): string | null {
  let db: Database.Database | null = null;
  try {
    db = openDb();
    const rows = db
      .prepare(
        "SELECT id FROM session WHERE directory = ? ORDER BY time_created DESC LIMIT 8"
      )
      .all(cwd) as Array<{ id: string }>;
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
    let attempts = 0;
    this.interval = setInterval(() => {
      attempts++;
      if (attempts > 30) {
        this.cancel();
        return;
      }
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

interface OpencodeMessageData {
  role?: string;
  finish?: string;
  content?: unknown;
}

class OpencodeCompletionDetector implements CompletionDetector {
  private lastSeenTime = 0;
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private pendingNotify: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(
    private readonly sessionId: string,
    private readonly onActivity: (type: string) => void
  ) {
    // Snapshot the latest message timestamp so existing rows don't trigger.
    this.lastSeenTime = this.getCurrentLatestTime();
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

  private getCurrentLatestTime(): number {
    let db: Database.Database | null = null;
    try {
      db = openDb();
      const row = db
        .prepare(
          "SELECT MAX(time_created) AS t FROM message WHERE session_id = ?"
        )
        .get(this.sessionId) as { t: number | null } | undefined;
      return row?.t ?? 0;
    } catch {
      return this.lastSeenTime;
    } finally {
      db?.close();
    }
  }

  private checkForChanges() {
    let db: Database.Database | null = null;
    try {
      db = openDb();
      const rows = db
        .prepare(
          "SELECT time_created, data FROM message WHERE session_id = ? AND time_created > ? ORDER BY time_created ASC"
        )
        .all(this.sessionId, this.lastSeenTime) as Array<{
        time_created: number;
        data: string;
      }>;

      if (rows.length === 0) return;

      let shouldScheduleNotify = false;

      for (const row of rows) {
        this.lastSeenTime = row.time_created;
        let parsed: OpencodeMessageData;
        try {
          parsed = JSON.parse(row.data);
        } catch {
          continue;
        }

        if (parsed.role === "assistant") {
          // finish === "stop"        -> assistant truly done, schedule notify
          // finish === "tool-calls"  -> still working, ignore
          // finish === undefined     -> intermediate streaming row, ignore
          if (parsed.finish === "stop") {
            shouldScheduleNotify = true;
          }
        } else if (parsed.role === "user") {
          // Distinguish a real user prompt from a tool result. In opencode,
          // user prompts have no `content` field at the top level (the prompt
          // text lives in linked `part` rows); tool results carry payload.
          // We treat any user-role message as "user has acted" → cancel
          // pending notify, since it means the user already responded.
          shouldScheduleNotify = false;
          this.cancelPending();
        }
      }

      if (shouldScheduleNotify) {
        this.cancelPending();
        this.pendingNotify = setTimeout(() => {
          this.pendingNotify = null;
          if (!this.stopped) this.onActivity("waiting");
        }, 2000);
      }
    } catch {
      // sqlite locked / db missing / etc — silent retry next tick
    } finally {
      db?.close();
    }
  }
}

export const opencodeBackend: Backend = {
  name: "opencode",

  spawn(_cwd: string): SpawnConfig {
    // OpenCode handles "no prior session" gracefully — always pass --continue.
    return {
      command: opencodePath,
      args: ["--continue"],
      env: buildEnv(),
    };
  },

  discoverSessionId(cwd, onFound, isClaimed): SessionDiscovery {
    return new OpencodeSessionDiscovery(cwd, onFound, isClaimed);
  },

  createCompletionDetector(sessionId, onActivity, _isPtyIdle): CompletionDetector {
    return new OpencodeCompletionDetector(sessionId, onActivity);
  },

  buildResumeCommand(sessionId: string): string {
    return `opencode --session ${sessionId}`;
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
