import fs from "fs";
import path from "path";
import { BrowserWindow } from "electron";

const SESSIONS_DIR = path.join(process.env.HOME || "", ".claude/sessions");
const PROJECTS_DIR = path.join(process.env.HOME || "", ".claude/projects");

/**
 * Watch Claude Code session JSONL files for completed assistant turns.
 * Emits 'instance-activity' when the agent finishes responding or requests permission.
 */
export class SessionWatcher {
  private jsonlPaths = new Map<string, string>();
  private fileSizes = new Map<string, number>();
  private pollIntervals = new Map<string, ReturnType<typeof setInterval>>();
  private pendingNotify = new Map<string, ReturnType<typeof setTimeout>>();
  private mainWindow: BrowserWindow | null = null;

  setMainWindow(win: BrowserWindow) {
    this.mainWindow = win;
  }

  /**
   * Start watching for a spawned instance.
   * We find the session by matching cwd, since node-pty PID != claude's internal PID.
   */
  watchProcess(instanceId: string, cwd: string) {
    // Poll for the session file to appear (claude takes a moment to register)
    let attempts = 0;
    const findSession = setInterval(() => {
      attempts++;
      if (attempts > 30) {
        clearInterval(findSession);
        return;
      }

      const jsonlPath = this.findJsonlByCwd(cwd);
      if (!jsonlPath) return;

      clearInterval(findSession);
      this.startWatching(instanceId, jsonlPath);
    }, 1000);
  }

  private findJsonlByCwd(cwd: string): string | null {
    // Scan sessions dir to find one matching this cwd with most recent startedAt
    try {
      const files = fs.readdirSync(SESSIONS_DIR);
      let bestMatch: { sessionId: string; startedAt: number } | null = null;

      for (const file of files) {
        try {
          const data = JSON.parse(
            fs.readFileSync(path.join(SESSIONS_DIR, file), "utf8")
          );
          if (data.cwd === cwd && data.startedAt > (bestMatch?.startedAt || 0)) {
            bestMatch = { sessionId: data.sessionId, startedAt: data.startedAt };
          }
        } catch {
          continue;
        }
      }

      if (!bestMatch) return null;

      const encodedCwd = cwd.replace(/\//g, "-");
      const jsonlPath = path.join(PROJECTS_DIR, encodedCwd, `${bestMatch.sessionId}.jsonl`);

      if (fs.existsSync(jsonlPath)) return jsonlPath;
      return null;
    } catch {
      return null;
    }
  }

  private startWatching(instanceId: string, jsonlPath: string) {
    // Don't double-watch
    if (this.jsonlPaths.has(instanceId)) return;

    this.jsonlPaths.set(instanceId, jsonlPath);

    // Record current file size (ignore existing content)
    try {
      const stat = fs.statSync(jsonlPath);
      this.fileSizes.set(instanceId, stat.size);
    } catch {
      this.fileSizes.set(instanceId, 0);
    }

    // Poll every 500ms for changes
    const interval = setInterval(() => {
      this.checkForChanges(instanceId);
    }, 500);
    this.pollIntervals.set(instanceId, interval);
  }

  private checkForChanges(instanceId: string) {
    const jsonlPath = this.jsonlPaths.get(instanceId);
    if (!jsonlPath) return;

    try {
      const stat = fs.statSync(jsonlPath);
      const prevSize = this.fileSizes.get(instanceId) || 0;

      if (stat.size <= prevSize) return;

      // Read new content
      const fd = fs.openSync(jsonlPath, "r");
      const buf = Buffer.alloc(stat.size - prevSize);
      fs.readSync(fd, buf, 0, buf.length, prevSize);
      fs.closeSync(fd);

      this.fileSizes.set(instanceId, stat.size);

      const newContent = buf.toString("utf8");
      const lines = newContent.split("\n").filter((l) => l.trim());

      let shouldScheduleNotify = false;

      for (const line of lines) {
        try {
          const msg = JSON.parse(line);
          if (msg.type === "assistant") {
            const stopReason = msg.message?.stop_reason;
            if (stopReason === "end_turn" || stopReason === "tool_use") {
              shouldScheduleNotify = true;
            } else {
              // Non-terminal message (None) — cancel any pending notification
              // because Claude is still working
              shouldScheduleNotify = false;
              const pending = this.pendingNotify.get(instanceId);
              if (pending) {
                clearTimeout(pending);
                this.pendingNotify.delete(instanceId);
              }
            }
          } else if (msg.type === "user") {
            // User responded — cancel pending notification (they already saw it)
            shouldScheduleNotify = false;
            const pending = this.pendingNotify.get(instanceId);
            if (pending) {
              clearTimeout(pending);
              this.pendingNotify.delete(instanceId);
            }
          }
        } catch {
          // skip invalid JSON
        }
      }

      // Schedule notification: wait 2s to confirm Claude really stopped
      if (shouldScheduleNotify && !this.pendingNotify.has(instanceId)) {
        const timer = setTimeout(() => {
          this.pendingNotify.delete(instanceId);
          this.mainWindow?.webContents.send("instance-activity", instanceId, "waiting");
        }, 2000);
        this.pendingNotify.set(instanceId, timer);
      }
    } catch {
      // ignore errors
    }
  }

  unwatch(instanceId: string) {
    const interval = this.pollIntervals.get(instanceId);
    if (interval) clearInterval(interval);
    this.pollIntervals.delete(instanceId);
    this.jsonlPaths.delete(instanceId);
    this.fileSizes.delete(instanceId);
  }

  cleanup() {
    for (const interval of this.pollIntervals.values()) {
      clearInterval(interval);
    }
    this.pollIntervals.clear();
    this.jsonlPaths.clear();
    this.fileSizes.clear();
  }
}

export const sessionWatcher = new SessionWatcher();
