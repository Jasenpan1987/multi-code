// Tests for reading how full a Claude session's context window is. OpenCode 2's reader
// has its own tests in opencodeDb.test.ts.
//
// The property that matters most: the figure must be the *input* side of a single
// turn. Both CLIs also publish a pre-summed total that includes output, and
// lifetime cumulative counters that reach millions of tokens. Either would look
// plausible in a UI and be wrong — the total by a little, the cumulative by two
// orders of magnitude.

import { afterEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

const { readClaudeContextUsage } = await import("./claude");

// A settings path that cannot exist, so the window lookup always answers "unknown".
// Without this the reader picks up the developer's real ~/.claude/settings.json and
// these assertions pass or fail depending on whose machine they run on. Window
// resolution has its own tests in contextWindow.test.ts.
const NO_SETTINGS = "/nonexistent/multicode-test/settings.json";

// ---------------------------------------------------------------- claude

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "multicode-ctx-"));
const written: string[] = [];

afterEach(() => {
  for (const f of written.splice(0)) {
    try {
      fs.unlinkSync(f);
    } catch {
      // already gone
    }
  }
});

function writeJsonl(...records: unknown[]): string {
  const file = path.join(tmpDir, `s-${Math.random().toString(36).slice(2)}.jsonl`);
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  written.push(file);
  return file;
}

function assistant(
  usage: Record<string, number>,
  opts: { model?: string; timestamp?: string } = {}
) {
  const message: Record<string, unknown> = { usage };
  if (opts.model !== undefined) message.model = opts.model;
  return {
    type: "assistant",
    message,
    timestamp: opts.timestamp ?? "2026-09-01T00:00:01.000Z",
  };
}

const userTurn = {
  type: "user",
  message: { content: "hello" },
  timestamp: "2026-09-01T00:00:00.000Z",
};

describe("readClaudeContextUsage", () => {
  it("sums the three input fields and excludes output", () => {
    const file = writeJsonl(
      userTurn,
      assistant(
        {
          input_tokens: 10,
          cache_creation_input_tokens: 20,
          cache_read_input_tokens: 300,
          output_tokens: 5000,
        },
        { model: "claude-opus-5" }
      )
    );
    expect(readClaudeContextUsage(file, NO_SETTINGS)).toEqual({
      inputTokens: 330,
      updatedAt: Date.parse("2026-09-01T00:00:01.000Z"),
      model: "claude-opus-5",
    });
  });

  it("reads the newest assistant turn, not the first", () => {
    const file = writeJsonl(
      assistant({ input_tokens: 1, cache_read_input_tokens: 99 }),
      userTurn,
      assistant({ input_tokens: 2, cache_read_input_tokens: 4000 })
    );
    expect(readClaudeContextUsage(file, NO_SETTINGS)?.inputTokens).toBe(4002);
  });

  it("walks back past an assistant turn with no usage", () => {
    const file = writeJsonl(
      assistant({ input_tokens: 5, cache_read_input_tokens: 500 }),
      { type: "assistant", message: { model: "x" }, timestamp: "2026-09-01T01:00:00.000Z" }
    );
    expect(readClaudeContextUsage(file, NO_SETTINGS)?.inputTokens).toBe(505);
  });

  it("walks back past an all-zero turn, which says nothing about fullness", () => {
    const file = writeJsonl(
      assistant({ input_tokens: 7, cache_read_input_tokens: 700 }),
      assistant({
        input_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        output_tokens: 0,
      })
    );
    expect(readClaudeContextUsage(file, NO_SETTINGS)?.inputTokens).toBe(707);
  });

  it("returns null when the session has no assistant turn yet", () => {
    // Distinct from zero on purpose: a fresh session's usage is unknown, and
    // rendering 0 would read as "plenty of room".
    expect(readClaudeContextUsage(writeJsonl(userTurn), NO_SETTINGS)).toBeNull();
  });

  it("returns null for a missing file", () => {
    expect(readClaudeContextUsage(path.join(tmpDir, "nope.jsonl"), NO_SETTINGS)).toBeNull();
  });

  it("returns null for an empty file", () => {
    const file = path.join(tmpDir, "empty.jsonl");
    fs.writeFileSync(file, "");
    written.push(file);
    expect(readClaudeContextUsage(file, NO_SETTINGS)).toBeNull();
  });

  it("skips malformed lines", () => {
    const file = path.join(tmpDir, "broken.jsonl");
    fs.writeFileSync(
      file,
      JSON.stringify(assistant({ input_tokens: 3, cache_read_input_tokens: 30 })) +
        "\n{not json\n"
    );
    written.push(file);
    expect(readClaudeContextUsage(file, NO_SETTINGS)?.inputTokens).toBe(33);
  });

  it("omits model when the record didn't name one", () => {
    const file = writeJsonl(assistant({ input_tokens: 100 }));
    expect(readClaudeContextUsage(file, NO_SETTINGS)?.model).toBeUndefined();
  });

  it("reports updatedAt 0 rather than now when the timestamp is unusable", () => {
    const file = writeJsonl({
      type: "assistant",
      message: { usage: { input_tokens: 50 } },
      timestamp: "not-a-date",
    });
    expect(readClaudeContextUsage(file, NO_SETTINGS)?.updatedAt).toBe(0);
  });

  it("tolerates non-numeric usage values", () => {
    const file = writeJsonl({
      type: "assistant",
      message: { usage: { input_tokens: "12", cache_read_input_tokens: 88 } },
      timestamp: "2026-09-01T00:00:01.000Z",
    });
    expect(readClaudeContextUsage(file, NO_SETTINGS)?.inputTokens).toBe(88);
  });
});
