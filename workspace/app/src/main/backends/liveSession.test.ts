// Which session is a running process on *right now*.
//
// Multi-Code used to fix an instance's session id once, at discovery, and never
// revisit it. `/new` and `/clear` move the CLI to a fresh transcript under a new
// id and stop writing to the old file, so the instance went on reading a file
// nobody touched again: context usage frozen at the old figure (the reported
// symptom), and — with no symptom at all — the completion detector, notifications,
// phone prompt detection and the write-safety gate all watching a dead file.
//
// The CLI maintains `~/.claude/sessions/<pid>.json` with the current `sessionId`,
// which makes this answerable rather than guessable. Measured 2026-09-17 against
// 2.1.274: after `/new`, one pid's entry moved from 89f7d163… to 75e23772… while
// the first transcript stopped growing at all. Those two ids are used below.
//
// HOME is redirected to a temp dir before importing claude.ts, which resolves
// SESSIONS_DIR at module load — the convention from tech-conventions.md, so this
// never reads the developer's own sessions.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "multicode-live-"));
const realHome = process.env.HOME;
process.env.HOME = home;

const sessionsDir = path.join(home, ".claude/sessions");

const { findClaudeLiveSessionId } = await import("./claude");

const CWD = "/Users/x/code/portals";
const BEFORE_NEW = "89f7d163-85fa-4f21-bbc6-a865fbfb8ed9";
const AFTER_NEW = "75e23772-8db9-4841-8451-4e157247ceaf";

function writeEntry(
  pid: number,
  fields: { sessionId?: unknown; cwd?: unknown; raw?: string }
) {
  fs.mkdirSync(sessionsDir, { recursive: true });
  const file = path.join(sessionsDir, `${pid}.json`);
  if (fields.raw !== undefined) {
    fs.writeFileSync(file, fields.raw);
    return;
  }
  fs.writeFileSync(
    file,
    JSON.stringify({
      pid,
      sessionId: fields.sessionId,
      cwd: fields.cwd,
      status: "idle",
    })
  );
}

beforeEach(() => {
  fs.rmSync(sessionsDir, { recursive: true, force: true });
  fs.mkdirSync(sessionsDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(sessionsDir, { recursive: true, force: true });
});

describe("findClaudeLiveSessionId", () => {
  it("reads the session for this pid", () => {
    writeEntry(60891, { sessionId: BEFORE_NEW, cwd: CWD });
    expect(findClaudeLiveSessionId(CWD, 60891)).toBe(BEFORE_NEW);
  });

  it("follows the same pid to a new session after /new", () => {
    // The whole bug in one assertion. The pid does not change; the session does.
    writeEntry(60891, { sessionId: BEFORE_NEW, cwd: CWD });
    expect(findClaudeLiveSessionId(CWD, 60891)).toBe(BEFORE_NEW);

    writeEntry(60891, { sessionId: AFTER_NEW, cwd: CWD });
    expect(findClaudeLiveSessionId(CWD, 60891)).toBe(AFTER_NEW);
  });

  it("compares resolved paths, so /tmp and /private/tmp agree", () => {
    // findJsonlByCwd learned this the hard way: the CLI records the path it
    // resolved, and a literal compare finds nothing, leaving the instance with no
    // detection at all.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "multicode-cwd-"));
    const resolved = fs.realpathSync(dir);
    writeEntry(4242, { sessionId: BEFORE_NEW, cwd: resolved });
    expect(findClaudeLiveSessionId(dir, 4242)).toBe(BEFORE_NEW);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("ignores an entry for this pid that belongs to another directory", () => {
    // Pids are recycled. A stale entry from a dead process would otherwise point
    // every read at an unrelated session's transcript.
    writeEntry(60891, { sessionId: BEFORE_NEW, cwd: "/Users/x/code/something" });
    expect(findClaudeLiveSessionId(CWD, 60891)).toBeNull();
  });

  it("falls back to a single unambiguous entry for the directory", () => {
    // Covers a CLI that ever keys the registry on a pid other than the process we
    // spawned: one process in this directory leaves no room for doubt.
    writeEntry(99999, { sessionId: AFTER_NEW, cwd: CWD });
    expect(findClaudeLiveSessionId(CWD, 12345)).toBe(AFTER_NEW);
  });

  it("returns null when two processes share the directory", () => {
    // The load-bearing refusal. Guessing would hand one instance the other's
    // transcript, and this user really does have two contacts on one repo.
    writeEntry(1001, { sessionId: BEFORE_NEW, cwd: CWD });
    writeEntry(1002, { sessionId: AFTER_NEW, cwd: CWD });
    expect(findClaudeLiveSessionId(CWD, 5555)).toBeNull();
  });

  it("returns null when there is no registry at all", () => {
    fs.rmSync(sessionsDir, { recursive: true, force: true });
    expect(findClaudeLiveSessionId(CWD, 60891)).toBeNull();
  });

  it("survives a half-written entry", () => {
    // The CLI rewrites these files live, so a truncated read is normal.
    writeEntry(60891, { raw: '{"sessionId":"abc","cwd":' });
    expect(findClaudeLiveSessionId(CWD, 60891)).toBeNull();
  });

  it("skips entries missing the fields it needs", () => {
    writeEntry(1001, { cwd: CWD });
    writeEntry(1002, { sessionId: AFTER_NEW });
    expect(findClaudeLiveSessionId(CWD, 60891)).toBeNull();
  });
});

// Restore, so a later file in the same worker doesn't inherit the temp HOME.
process.env.HOME = realHome;
