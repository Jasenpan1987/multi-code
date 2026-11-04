// Tests for turning a Claude session JSONL into reflowable transcript entries.
//
// These exist because the phone shows the transcript INSTEAD of the terminal, and
// the reply reader and the secretary read a turn from it, so a parsing mistake
// here isn't cosmetic: it's the difference between seeing what the agent is doing
// and seeing nothing. The rows are in the real on-disk format, including the
// bookkeeping row types the CLI writes that must be skipped.

import { describe, expect, it } from "vitest";
import { claudeTranscriptEntries } from "./claudeTranscript";

// The file's lines, as the readers split them.
function jsonl(rows: unknown[]): string[] {
  return rows.map((r) => JSON.stringify(r));
}

const userSays = (text: string) => ({
  type: "user",
  message: { role: "user", content: text },
});

const assistantSays = (text: string) => ({
  type: "assistant",
  message: { role: "assistant", content: [{ type: "text", text }] },
});

const assistantCalls = (id: string, name: string, input: unknown) => ({
  type: "assistant",
  message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] },
});

const toolResult = (id: string) => ({
  type: "user",
  message: {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: id, content: "ok" }],
  },
});

describe("claudeTranscriptEntries", () => {
  it("reads prose from both sides in order", () => {
    const lines = jsonl([
      userSays("fix the build"),
      assistantSays("Looking at it now."),
    ]);
    expect(claudeTranscriptEntries(lines)).toEqual([
      { kind: "user", text: "fix the build" },
      { kind: "assistant", text: "Looking at it now." },
    ]);
  });

  it("summarizes tool calls by their most useful field", () => {
    const lines = jsonl([
      assistantCalls("t1", "Bash", { command: "pnpm test" }),
      toolResult("t1"),
      assistantCalls("t2", "Read", { file_path: "/repo/src/main.ts" }),
      toolResult("t2"),
      assistantCalls("t3", "Grep", { pattern: "TODO" }),
      toolResult("t3"),
    ]);
    const entries = claudeTranscriptEntries(lines);
    expect(entries).toEqual([
      { kind: "tool", tool: "Bash", text: "pnpm test" },
      { kind: "tool", tool: "Read", text: "/repo/src/main.ts" },
      { kind: "tool", tool: "Grep", text: "TODO" },
    ]);
  });

  it("flags only the tool that never got a result", () => {
    // This is the entry the phone highlights, so a paired tool must not keep the
    // flag it would have had when first seen.
    const lines = jsonl([
      assistantCalls("t1", "Bash", { command: "pnpm build" }),
      toolResult("t1"),
      assistantCalls("t2", "Bash", { command: "rm -rf dist" }),
    ]);
    const entries = claudeTranscriptEntries(lines);
    expect(entries[0].pending).toBeUndefined();
    expect(entries[1].pending).toBe(true);
  });

  it("skips thinking blocks and tool results", () => {
    const lines = jsonl([
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "internal deliberation" },
            { type: "text", text: "Here's the plan." },
          ],
        },
      },
      toolResult("t9"),
    ]);
    expect(claudeTranscriptEntries(lines)).toEqual([
      { kind: "assistant", text: "Here's the plan." },
    ]);
  });

  it("skips the CLI's own bookkeeping rows", () => {
    // These row types appear in real session files and carry nothing a person
    // would want to read on a phone.
    const lines = jsonl([
      { type: "mode", mode: "default" },
      { type: "file-history-delta", delta: {} },
      { type: "attachment", attachment: {} },
      { type: "last-prompt", prompt: "..." },
      assistantSays("Done."),
    ]);
    expect(claudeTranscriptEntries(lines)).toEqual([
      { kind: "assistant", text: "Done." },
    ]);
  });

  it("survives malformed lines rather than losing the whole session", () => {
    const lines = [
      JSON.stringify(assistantSays("before")),
      "{ this is not json",
      "",
      JSON.stringify(assistantSays("after")),
    ];
    expect(claudeTranscriptEntries(lines)).toEqual([
      { kind: "assistant", text: "before" },
      { kind: "assistant", text: "after" },
    ]);
  });

  it("ignores whitespace-only prose", () => {
    const lines = jsonl([assistantSays("   \n  "), assistantSays("real")]);
    expect(claudeTranscriptEntries(lines)).toEqual([
      { kind: "assistant", text: "real" },
    ]);
  });
});
