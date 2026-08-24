// Regression tests for Claude session discovery.
//
// Pins the behavior that broke real-world notifications: Claude creates the
// session jsonl lazily — for a fresh project the file only appears when the
// user sends their FIRST message, which can be minutes after the CLI spawns.
// Discovery must keep polling until the session appears for as long as the
// instance lives; an earlier version gave up after 30 attempts (30s), which
// silently killed completion AND prompt notifications for the instance's
// whole lifetime.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// Bind the claude module's HOME-based paths to a scratch dir BEFORE the module
// loads — those constants are read at import time. Vitest isolates modules
// per test file, so other tests' real-HOME imports are unaffected.
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "claude-discovery-"));
process.env.HOME = fakeHome;

const { claudeBackend } = await import("./claude");

const SESSIONS_DIR = path.join(fakeHome, ".claude", "sessions");
const PROJECTS_DIR = path.join(fakeHome, ".claude", "projects");
const CWD = "/work/myproject";
// encodeProjectDir(cwd) = resolvePath(cwd).replace(/\//g, "-")
const ENCODED_PROJECT_DIR = "-work-myproject";

function writeSessionMetadata(sessionId: string, startedAt: number) {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  // Metadata files are named after the CLI's pid, but the name is irrelevant:
  // findJsonlByCwd parses every file in the directory.
  fs.writeFileSync(
    path.join(SESSIONS_DIR, `meta-${sessionId}.json`),
    JSON.stringify({ sessionId, cwd: CWD, startedAt })
  );
}

function writeJsonl(sessionId: string) {
  const projectDir = path.join(PROJECTS_DIR, ENCODED_PROJECT_DIR);
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, `${sessionId}.jsonl`), "\n");
}

describe("ClaudeSessionDiscovery", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(fakeHome, { recursive: true, force: true });
  });

  it("keeps polling past the old 30s cap and finds a session created later", () => {
    const found: string[] = [];
    const discovery = claudeBackend.discoverSessionId(CWD, (sessionId) => {
      found.push(sessionId);
    });

    // Long past the old 30-attempt window: still nothing (no jsonl yet), and
    // — crucially — still alive.
    vi.advanceTimersByTime(90_000);
    expect(found).toEqual([]);

    // The user sends their first message minutes after spawn; only now does
    // the session file exist.
    writeSessionMetadata("sess-1", Date.now());
    writeJsonl("sess-1");

    vi.advanceTimersByTime(1500);
    expect(found).toEqual(["sess-1"]);

    discovery.cancel();
  });

  it("waits for the jsonl even when session metadata already exists", () => {
    const found: string[] = [];
    const discovery = claudeBackend.discoverSessionId(CWD, (sessionId) => {
      found.push(sessionId);
    });

    // Metadata written at CLI start, jsonl still absent: must not resolve.
    writeSessionMetadata("sess-1", Date.now());
    vi.advanceTimersByTime(3000);
    expect(found).toEqual([]);

    writeJsonl("sess-1");
    vi.advanceTimersByTime(1500);
    expect(found).toEqual(["sess-1"]);

    discovery.cancel();
  });

  it("prefers the newest session for the cwd", () => {
    writeSessionMetadata("older", 1000);
    writeJsonl("older");
    writeSessionMetadata("newer", 2000);
    writeJsonl("newer");

    const found: string[] = [];
    const discovery = claudeBackend.discoverSessionId(CWD, (sessionId) => {
      found.push(sessionId);
    });

    vi.advanceTimersByTime(1500);
    expect(found).toEqual(["newer"]);

    discovery.cancel();
  });
});
