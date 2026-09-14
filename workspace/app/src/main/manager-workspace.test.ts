// The seeding rule is the whole point of this module: the guidance file is the
// user's to edit, so it gets written once and never again. A launch that clobbered
// it would make editing it pointless, and the failure would be silent.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

let userData = "";

vi.mock("electron", () => ({
  app: { getPath: () => userData },
}));

const { ensureManagerWorkspace, managerDir } = await import("./manager-workspace");

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

  it("never overwrites an existing guidance file", () => {
    const { dir } = ensureManagerWorkspace();
    const file = path.join(dir, "CLAUDE.md");
    fs.writeFileSync(file, "# my own instructions\n");

    const second = ensureManagerWorkspace();
    expect(second.seeded).toBe(false);
    expect(fs.readFileSync(file, "utf8")).toBe("# my own instructions\n");
  });

  it("is safe to call when the directory already exists but the file was deleted", () => {
    const { dir } = ensureManagerWorkspace();
    fs.unlinkSync(path.join(dir, "CLAUDE.md"));
    expect(ensureManagerWorkspace().seeded).toBe(true);
  });

  it("seeds guidance that tells the manager to read rather than ask", () => {
    // This is the one behaviour that makes the whole feature cheap: asking a session
    // for a status update costs it a turn, reading its transcript costs nothing.
    const { dir } = ensureManagerWorkspace();
    const text = fs.readFileSync(path.join(dir, "CLAUDE.md"), "utf8");
    expect(text).toMatch(/Reading beats asking/);
    expect(text).toContain("list_sessions");
    expect(text).toContain("read_session");
  });

  it("seeds guidance that says it cannot approve things for the user", () => {
    const { dir } = ensureManagerWorkspace();
    const text = fs.readFileSync(path.join(dir, "CLAUDE.md"), "utf8");
    expect(text).toMatch(/cannot approve anything on the user's behalf/);
  });
});
