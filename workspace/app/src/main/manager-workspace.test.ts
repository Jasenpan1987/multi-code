// Two rules pull against each other here, and both have already been broken once.
//
// The file is the user's to edit, so a launch must never clobber their edits. But
// "write once and never again" — the original rule — is what left this file
// describing a read-only manager for weeks after the write tools shipped, and a
// manager that believes it can only read tells its user to go and run things by
// hand. So: a file we still recognise as ours gets upgraded, an edited one never
// does.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";

let userData = "";

vi.mock("electron", () => ({
  app: { getPath: () => userData },
}));

const { ensureManagerWorkspace, managerDir, GUIDANCE } = await import(
  "./manager-workspace"
);

// The exact bytes T-209 shipped, taken off the user's own machine rather than
// retyped, so the upgrade path is tested against a real previous version instead of
// against a hash that only equals itself.
const V1_HASH = "51ef4a76892e5c4099720668bda30a6e025991cde2051839fb6a42b47560d137";
const V1_GUIDANCE = fs.readFileSync(
  path.join(__dirname, "__fixtures__", "manager-guidance-v1.md"),
  "utf8"
);

// T-215's version: every dispatch tool, but silent about the manager's own shell
// and editor, so it dispatched a session to check things it could have checked
// itself in seconds.
const V2_HASH = "130da528a2e4ef58d8e400c9a1a56ece47af150be49c1b6287009710d613f5b4";
const V2_GUIDANCE = fs.readFileSync(
  path.join(__dirname, "__fixtures__", "manager-guidance-v2.md"),
  "utf8"
);

function sha256(text: string): string {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

beforeEach(() => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), "multicode-mgr-"));
});

afterEach(() => {
  fs.rmSync(userData, { recursive: true, force: true });
});

describe("ensureManagerWorkspace", () => {
  it("creates the directory and seeds the guidance file", () => {
    const { dir, seeded } = ensureManagerWorkspace();
    expect(dir).toBe(path.join(userData, "manager"));
    expect(seeded).toBe(true);
    expect(fs.existsSync(path.join(dir, "CLAUDE.md"))).toBe(true);
  });

  it("lives under userData, not ~/.config", () => {
    // The spec originally said ~/.config/Multi-Code/manager/, from an assumption
    // about where contacts.json lives that turned out to be wrong. Everything this
    // app persists goes through app.getPath("userData").
    expect(managerDir().startsWith(userData)).toBe(true);
  });

  it("never overwrites a file the user has edited", () => {
    const { dir } = ensureManagerWorkspace();
    const file = path.join(dir, "CLAUDE.md");
    fs.writeFileSync(file, "# my own instructions\n");

    const second = ensureManagerWorkspace();
    expect(second.seeded).toBe(false);
    expect(second.upgraded).toBe(false);
    expect(second.userEdited).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toBe("# my own instructions\n");
  });

  it("leaves an edited file alone however many times it is called", () => {
    const { dir } = ensureManagerWorkspace();
    const file = path.join(dir, "CLAUDE.md");
    fs.writeFileSync(file, "# mine\n");
    ensureManagerWorkspace();
    ensureManagerWorkspace();
    expect(fs.readFileSync(file, "utf8")).toBe("# mine\n");
  });

  it("rewrites nothing when the file is already the current version", () => {
    const { dir } = ensureManagerWorkspace();
    const file = path.join(dir, "CLAUDE.md");
    const before = fs.statSync(file).mtimeMs;

    const second = ensureManagerWorkspace();
    expect(second.seeded).toBe(false);
    expect(second.upgraded).toBe(false);
    expect(second.userEdited).toBe(false);
    expect(fs.statSync(file).mtimeMs).toBe(before);
  });

  // The bug this whole mechanism exists for: the user's manager was seeded before
  // send_task existed, and nothing ever updated the file, so the manager kept
  // believing it could only read.
  it("upgrades an untouched file from a previous version", () => {
    const dir = managerDir();
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "CLAUDE.md");
    fs.writeFileSync(file, V1_GUIDANCE);
    expect(sha256(fs.readFileSync(file, "utf8"))).toBe(V1_HASH);

    const result = ensureManagerWorkspace();
    expect(result.upgraded).toBe(true);
    expect(result.userEdited).toBe(false);
    expect(fs.readFileSync(file, "utf8")).toBe(GUIDANCE);
  });

  it("upgrades an untouched file from the version before this one", () => {
    const dir = managerDir();
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "CLAUDE.md");
    fs.writeFileSync(file, V2_GUIDANCE);

    const result = ensureManagerWorkspace();
    expect(result.upgraded).toBe(true);
    expect(result.userEdited).toBe(false);
    expect(fs.readFileSync(file, "utf8")).toBe(GUIDANCE);
  });

  it("recognises every previous version by the hash shipped in the code", () => {
    // If this fails, a constant in manager-workspace.ts no longer matches the
    // bytes that were actually on disk, and real users stop being upgraded.
    expect(sha256(V1_GUIDANCE)).toBe(V1_HASH);
    expect(sha256(V2_GUIDANCE)).toBe(V2_HASH);
  });

  it("is safe to call when the directory already exists but the file was deleted", () => {
    const { dir } = ensureManagerWorkspace();
    fs.unlinkSync(path.join(dir, "CLAUDE.md"));
    expect(ensureManagerWorkspace().seeded).toBe(true);
  });

  it("seeds guidance that tells the manager to read rather than ask", () => {
    // This is the one behaviour that makes the whole feature cheap: asking a session
    // for a status update costs it a turn, reading its transcript costs nothing.
    const text = seededText();
    expect(text).toMatch(/Reading beats asking/);
  });

  it("seeds guidance that says it cannot answer a dialog for the user", () => {
    expect(seededText()).toMatch(/cannot answer those on their behalf/);
  });

  // The reason the manager pushed work back: the file listed only the read tools,
  // so it had no idea it could dispatch anything. Every tool must be named.
  it("names every tool the manager has", () => {
    const text = seededText();
    for (const tool of [
      "list_sessions",
      "read_session",
      "start_session",
      "send_task",
      "wait_for_idle",
      "run_command",
    ]) {
      expect(text).toContain(tool);
    }
  });

  it("tells the manager not to hand work back to the user", () => {
    const text = seededText();
    expect(text).toMatch(/Never hand the work back/);
    expect(text).toMatch(/Do not tell the user to go and run something/);
  });

  // The user's correction, 2026-09-16: a manager that can only read and forward is
  // not a manager. "When there is an urgent task, or he doesn't believe what a team
  // member says and needs to verify it himself, he also gets his hands dirty." These
  // assertions exist because the text *is* the feature — a version that stops saying
  // this produces the meek assistant of T-215 again, silently.
  it("tells the manager it has its own shell and editor", () => {
    const text = seededText();
    for (const tool of ["Bash", "Edit", "Write"]) {
      expect(text).toContain(tool);
    }
  });

  it("tells the manager to verify a session's claims itself", () => {
    const text = seededText();
    expect(text).toMatch(/Verify for yourself/);
    expect(text).toMatch(/do not have to take a session's word/);
  });

  it("tells the manager to fix small things itself rather than dispatch them", () => {
    expect(seededText()).toMatch(/Do the small thing yourself/);
  });

  it("still tells the manager to dispatch work that needs project context", () => {
    // The other half of the judgement. Without this it grabs everything, throwing
    // away what the session that owns the work already knows.
    expect(seededText()).toMatch(/Still dispatch the real work/);
  });

  it("forbids editing files in a project whose session is busy", () => {
    // The one hard rule, and it is about collisions rather than permission: two
    // writers in one working tree corrupts work nobody asked it to touch.
    const text = seededText();
    expect(text).toMatch(/never edit files in a project whose session is .busy./);
  });

  it("tells the manager its own calls are visible, and not to be timid about it", () => {
    const text = seededText();
    expect(text).toMatch(/appears in Multi-Code's Manager panel/);
    expect(text).toMatch(/not as a reason for you to be timid/);
  });

  it("tells the manager not to poll in a loop", () => {
    // Polling is what made a one-second command take a minute or two of wall clock.
    expect(seededText()).toMatch(/Do not poll .read_session. in a loop/);
  });

  it("describes the run states that actually exist", () => {
    // The first version claimed status was only running or stopped, which stopped
    // being true when the write-safety gate shipped.
    const text = seededText();
    for (const state of ["idle", "busy", "blocked", "starting", "stopped"]) {
      expect(text).toContain(state);
    }
    expect(text).not.toMatch(/status. is only .running. or .stopped/);
  });
});

function seededText(): string {
  const { dir } = ensureManagerWorkspace();
  return fs.readFileSync(path.join(dir, "CLAUDE.md"), "utf8");
}
