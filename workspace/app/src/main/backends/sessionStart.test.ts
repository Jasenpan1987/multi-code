// Which conversation a claude spawn opens (SessionStart in types.ts).
//
// The point: a contact goes back to its own session, so two contacts on one
// project stay apart across restarts instead of both taking the directory's
// newest with `--continue`. And a fresh session is named up front, so the contact
// has it on record before anyone types in it.

import { describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// Bind the claude module's HOME-based paths to a scratch dir before it loads, as
// claudeDiscovery.test.ts does: the constants are read at import time.
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "claude-session-start-"));
process.env.HOME = fakeHome;

const { claudeBackend } = await import("./claude");

const PROJECTS_DIR = path.join(fakeHome, ".claude", "projects");
const OWN = "6f1c2b9e-3a4d-4e5f-8a7b-1c2d3e4f5a6b";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// A project directory of its own per test, with these transcripts in it.
let projectCount = 0;
function project(...transcripts: string[]): string {
  const cwd = `/work/project-${++projectCount}`;
  const dir = path.join(PROJECTS_DIR, cwd.replace(/\//g, "-"));
  fs.mkdirSync(dir, { recursive: true });
  for (const id of transcripts) fs.writeFileSync(path.join(dir, `${id}.jsonl`), "");
  return cwd;
}

describe("claude spawn: which session", () => {
  it("resumes the contact's own session while its transcript exists", () => {
    const cwd = project(OWN, "someone-elses-newer-session");
    const { args, sessionId } = claudeBackend.spawn(cwd, undefined, {
      kind: "own",
      sessionId: OWN,
    });
    expect(args).toEqual(["--resume", OWN]);
    expect(sessionId).toBe(OWN);
  });

  it("starts the contact's own session under its id when it was never written", () => {
    // Nobody typed in it before the restart, so the CLI has no transcript and
    // `--resume` would fail. `--continue` would open another contact's session.
    const cwd = project("someone-elses-session");
    const { args, sessionId } = claudeBackend.spawn(cwd, undefined, {
      kind: "own",
      sessionId: OWN,
    });
    expect(args).toEqual(["--session-id", OWN]);
    expect(sessionId).toBe(OWN);
  });

  it("starts a fresh session when a missing own id isn't one the CLI accepts", () => {
    const cwd = project();
    const { args, sessionId } = claudeBackend.spawn(cwd, undefined, {
      kind: "own",
      sessionId: "not-a-uuid",
    });
    expect(args[0]).toBe("--session-id");
    expect(args[1]).toMatch(UUID);
    expect(sessionId).toBe(args[1]);
  });

  it("names a fresh session up front, even where the directory has history", () => {
    const cwd = project(OWN);
    const { args, sessionId } = claudeBackend.spawn(cwd, undefined, { kind: "fresh" });
    expect(args).not.toContain("--continue");
    expect(args[0]).toBe("--session-id");
    expect(args[1]).toMatch(UUID);
    expect(args[1]).not.toBe(OWN);
    expect(sessionId).toBe(args[1]);
  });

  it("continues the directory's latest for a contact with none of its own", () => {
    const cwd = project(OWN);
    const { args, sessionId } = claudeBackend.spawn(cwd, undefined, { kind: "latest" });
    expect(args).toEqual(["--continue"]);
    // Not known until the CLI says; discovery finds it.
    expect(sessionId).toBeUndefined();
  });

  it("names a new session where the only history is a claude -p run", () => {
    // `--continue` would say "No conversation found to continue" and exit, and the
    // contact would go offline the moment it started (2026-10-22, api-lib).
    const cwd = project();
    const dir = path.join(PROJECTS_DIR, cwd.replace(/\//g, "-"));
    fs.writeFileSync(
      path.join(dir, `${OWN}.jsonl`),
      JSON.stringify({ type: "user", entrypoint: "sdk-cli", cwd }) + "\n"
    );
    const { args, sessionId } = claudeBackend.spawn(cwd, undefined, { kind: "latest" });
    expect(args).not.toContain("--continue");
    expect(args[0]).toBe("--session-id");
    expect(args[1]).toMatch(UUID);
    expect(sessionId).toBe(args[1]);
  });

  it("is latest by default, and names a new session where there is no history", () => {
    const { args, sessionId } = claudeBackend.spawn(project());
    expect(args[0]).toBe("--session-id");
    expect(sessionId).toBe(args[1]);
  });
});
