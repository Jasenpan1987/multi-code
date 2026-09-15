// Resolving how large a session's context window is, on both backends.
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
const { readOpencodeContextWindow } = await import("./opencode");

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

// ---------------------------------------------------------------- opencode

describe("opencode: readOpencodeContextWindow", () => {
  // The real shape on this machine, 2026-09-15.
  const config = {
    provider: {
      "amazon-bedrock": {
        models: {
          "au.anthropic.claude-opus-4-8": {
            limit: { context: 1_000_000, output: 128_000 },
          },
          "au.anthropic.claude-haiku-4-5-20251001-v1:0": {
            limit: { context: 200_000, output: 64_000 },
          },
        },
      },
    },
  };

  it("reads the exact limit for a configured model", () => {
    const file = writeJson("opencode.json", config);
    expect(
      readOpencodeContextWindow(
        "au.anthropic.claude-opus-4-8",
        "amazon-bedrock",
        file
      )
    ).toBe(1_000_000);
    expect(
      readOpencodeContextWindow(
        "au.anthropic.claude-haiku-4-5-20251001-v1:0",
        "amazon-bedrock",
        file
      )
    ).toBe(200_000);
  });

  it("finds the model without knowing its provider", () => {
    const file = writeJson("opencode.json", config);
    expect(
      readOpencodeContextWindow("au.anthropic.claude-opus-4-8", undefined, file)
    ).toBe(1_000_000);
  });

  it("still finds the model when the recorded provider is wrong", () => {
    const file = writeJson("opencode.json", config);
    expect(
      readOpencodeContextWindow(
        "au.anthropic.claude-opus-4-8",
        "some-other-provider",
        file
      )
    ).toBe(1_000_000);
  });

  // The common case: the config only carries models the user overrode, while
  // OpenCode knows the rest from bundled data we can't read. Observed on this
  // machine, where a live session was running `gpt-5.6-sol` with no config entry.
  it("returns null for a model the config doesn't mention", () => {
    const file = writeJson("opencode.json", config);
    expect(readOpencodeContextWindow("gpt-5.6-sol", "openai", file)).toBe(null);
  });

  it("returns null for a model entry with no limit", () => {
    const file = writeJson("opencode.json", {
      provider: { p: { models: { m: {} } } },
    });
    expect(readOpencodeContextWindow("m", "p", file)).toBe(null);
  });

  it("returns null for a nonsensical limit rather than dividing by it", () => {
    const file = writeJson("opencode.json", {
      provider: {
        p: {
          models: {
            zero: { limit: { context: 0 } },
            text: { limit: { context: "1m" } },
            negative: { limit: { context: -1 } },
          },
        },
      },
    });
    expect(readOpencodeContextWindow("zero", "p", file)).toBe(null);
    expect(readOpencodeContextWindow("text", "p", file)).toBe(null);
    expect(readOpencodeContextWindow("negative", "p", file)).toBe(null);
  });

  it("returns null for a missing or unparseable config", () => {
    expect(
      readOpencodeContextWindow("m", "p", path.join(dir, "nope.json"))
    ).toBe(null);
    const broken = path.join(dir, "broken.json");
    fs.writeFileSync(broken, "not json at all");
    expect(readOpencodeContextWindow("m", "p", broken)).toBe(null);
  });

  it("returns null when the model is unknown", () => {
    const file = writeJson("opencode.json", config);
    expect(readOpencodeContextWindow(undefined, "amazon-bedrock", file)).toBe(
      null
    );
  });
});
