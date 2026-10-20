// Resolving how large a Claude session's context window is. OpenCode 2's resolution
// (its config, then its cached models.dev catalog) is tested in opencodeDb.test.ts.
//
// The rule the whole feature rests on: **return null rather than guess.** Neither CLI
// records the window size in its transcript, so both of these read user config that
// can be absent, stale, or about a different model. A percentage against the wrong
// denominator is worse than no percentage — showing 45% for a session actually at
// 226% of its window is exactly the mistake that would cost the user a session.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

const { readClaudeContextWindow } = await import("./claude");

let dir = "";

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "multicode-window-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function writeJson(name: string, value: unknown): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
}

// ---------------------------------------------------------------- claude

describe("claude: readClaudeContextWindow", () => {
  // The real shape on this machine, 2026-09-15.
  const settings = {
    env: {
      ANTHROPIC_DEFAULT_OPUS_MODEL: "au.anthropic.claude-opus-5[1m]",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "au.anthropic.claude-sonnet-5",
      AWS_REGION: "ap-southeast-2",
    },
  };

  it("reads 1M from the [1m] suffix", () => {
    const file = writeJson("settings.json", settings);
    expect(readClaudeContextWindow("claude-opus-5", file)).toBe(1_000_000);
  });

  // The distinction the whole task turns on: the same family name means a different
  // window depending on a suffix that lives somewhere else entirely.
  it("reads 200k for the same family without the suffix", () => {
    const file = writeJson("settings.json", settings);
    expect(readClaudeContextWindow("claude-sonnet-5", file)).toBe(200_000);
  });

  it("matches the family case-insensitively", () => {
    const file = writeJson("settings.json", settings);
    expect(readClaudeContextWindow("CLAUDE-OPUS-5", file)).toBe(1_000_000);
  });

  it("handles a family name with a date suffix", () => {
    const file = writeJson("settings.json", {
      env: { ANTHROPIC_DEFAULT_HAIKU_MODEL: "claude-haiku-4-5-20251001" },
    });
    expect(readClaudeContextWindow("claude-haiku-4-5-20251001", file)).toBe(
      200_000
    );
  });

  it("returns null for a family with no entry in settings", () => {
    const file = writeJson("settings.json", settings);
    expect(readClaudeContextWindow("claude-haiku-4-5", file)).toBe(null);
  });

  it("returns null when the model is unknown", () => {
    const file = writeJson("settings.json", settings);
    expect(readClaudeContextWindow(undefined, file)).toBe(null);
    expect(readClaudeContextWindow("gpt-5", file)).toBe(null);
  });

  // An override pointing at something that isn't this family at all tells us nothing
  // about the window, so it must not be read as the standard 200k.
  it("returns null when the configured id doesn't name the family", () => {
    const file = writeJson("settings.json", {
      env: { ANTHROPIC_DEFAULT_OPUS_MODEL: "some-internal-proxy-alias" },
    });
    expect(readClaudeContextWindow("claude-opus-5", file)).toBe(null);
  });

  it("returns null for a missing, empty or unparseable settings file", () => {
    expect(readClaudeContextWindow("claude-opus-5", path.join(dir, "nope.json"))).toBe(
      null
    );
    const empty = writeJson("empty.json", {});
    expect(readClaudeContextWindow("claude-opus-5", empty)).toBe(null);
    const broken = path.join(dir, "broken.json");
    fs.writeFileSync(broken, "{not json");
    expect(readClaudeContextWindow("claude-opus-5", broken)).toBe(null);
  });

  it("returns null when the override is present but blank", () => {
    const file = writeJson("blank.json", {
      env: { ANTHROPIC_DEFAULT_OPUS_MODEL: "" },
    });
    expect(readClaudeContextWindow("claude-opus-5", file)).toBe(null);
  });
});
