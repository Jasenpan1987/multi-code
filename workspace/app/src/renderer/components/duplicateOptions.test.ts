import { describe, expect, it } from "vitest";
import { OPENCODE_UPGRADE_COMMAND } from "../../shared/types";
import { duplicateOptions, otherBackend } from "./duplicateOptions";

const byChoice = (options: ReturnType<typeof duplicateOptions>) =>
  Object.fromEntries(options.map((o) => [o.choice, o]));

describe("duplicateOptions", () => {
  it("offers fork, new and the other tool, in that order", () => {
    const options = duplicateOptions("claude", true, { ok: true });
    expect(options.map((o) => o.label)).toEqual([
      "Fork this session",
      "New session",
      "New session with OpenCode",
    ]);
    expect(options.every((o) => !o.disabled)).toBe(true);
  });

  it("names Claude Code as the other tool of an OpenCode contact", () => {
    const { new: fresh, other } = byChoice(duplicateOptions("opencode", true, { ok: true }));
    expect(fresh.detail).toContain("with OpenCode");
    expect(other.label).toBe("New session with Claude Code");
  });

  it("disables Fork, and says why, with no conversation to copy", () => {
    const { fork } = byChoice(duplicateOptions("claude", false, { ok: true }));
    expect(fork.disabled).toBe(true);
    expect(fork.detail).toMatch(/no message has been sent/);
  });

  it("disables Fork and the other tool until main has answered", () => {
    const { fork, new: fresh, other } = byChoice(duplicateOptions("claude", null, null));
    expect(fork.disabled).toBe(true);
    expect(other.disabled).toBe(true);
    expect(fresh.disabled).toBe(false);
  });

  it("says why the other tool can't run", () => {
    expect(byChoice(duplicateOptions("claude", true, { ok: false, reason: "missing" })).other)
      .toMatchObject({ disabled: true, detail: "OpenCode isn't installed." });
    const outdated = byChoice(
      duplicateOptions("claude", true, { ok: false, reason: "outdated", version: "1.18.30" })
    ).other;
    expect(outdated.disabled).toBe(true);
    expect(outdated.detail).toContain("1.18.30");
    expect(outdated.detail).toContain(OPENCODE_UPGRADE_COMMAND);
  });
});

describe("otherBackend", () => {
  it("swaps the two tools", () => {
    expect(otherBackend("claude")).toBe("opencode");
    expect(otherBackend("opencode")).toBe("claude");
  });
});
