// Tests for the reflowable transcript readers.
//
// These exist because the phone shows the transcript INSTEAD of the terminal, so
// a parsing mistake here isn't cosmetic: it's the difference between seeing what
// the agent is doing and seeing nothing. The Claude reader is tested against a
// JSONL file in the real on-disk format, including the bookkeeping row types the
// CLI writes that must be skipped.

import { describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { readClaudeTranscript } from "./claude";

function writeJsonl(rows: unknown[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "multicode-transcript-"));
  const file = path.join(dir, "session.jsonl");
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return file;
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

describe("readClaudeTranscript", () => {
  it("reads prose from both sides in order", () => {
    const file = writeJsonl([
      userSays("fix the build"),
      assistantSays("Looking at it now."),
    ]);
    expect(readClaudeTranscript(file, 40)).toEqual([
      { kind: "user", text: "fix the build" },
      { kind: "assistant", text: "Looking at it now." },
    ]);
  });

  it("summarizes tool calls by their most useful field", () => {
    const file = writeJsonl([
      assistantCalls("t1", "Bash", { command: "pnpm test" }),
      toolResult("t1"),
      assistantCalls("t2", "Read", { file_path: "/repo/src/main.ts" }),
      toolResult("t2"),
      assistantCalls("t3", "Grep", { pattern: "TODO" }),
      toolResult("t3"),
    ]);
    const entries = readClaudeTranscript(file, 40);
    expect(entries).toEqual([
      { kind: "tool", tool: "Bash", text: "pnpm test" },
      { kind: "tool", tool: "Read", text: "/repo/src/main.ts" },
      { kind: "tool", tool: "Grep", text: "TODO" },
    ]);
  });

  it("flags only the tool that never got a result", () => {
    // This is the entry the phone highlights, so a paired tool must not keep the
    // flag it would have had when first seen.
    const file = writeJsonl([
      assistantCalls("t1", "Bash", { command: "pnpm build" }),
      toolResult("t1"),
      assistantCalls("t2", "Bash", { command: "rm -rf dist" }),
    ]);
    const entries = readClaudeTranscript(file, 40);
    expect(entries[0].pending).toBeUndefined();
    expect(entries[1].pending).toBe(true);
  });

  it("skips thinking blocks and tool results", () => {
    const file = writeJsonl([
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
    expect(readClaudeTranscript(file, 40)).toEqual([
      { kind: "assistant", text: "Here's the plan." },
    ]);
  });

  it("skips the CLI's own bookkeeping rows", () => {
    // These row types appear in real session files and carry nothing a person
    // would want to read on a phone.
    const file = writeJsonl([
      { type: "mode", mode: "default" },
      { type: "file-history-delta", delta: {} },
      { type: "attachment", attachment: {} },
      { type: "last-prompt", prompt: "..." },
      assistantSays("Done."),
    ]);
    expect(readClaudeTranscript(file, 40)).toEqual([
      { kind: "assistant", text: "Done." },
    ]);
  });

  it("keeps the newest entries when over the limit", () => {
    const file = writeJsonl([
      assistantSays("one"),
      assistantSays("two"),
      assistantSays("three"),
    ]);
    expect(readClaudeTranscript(file, 2)).toEqual([
      { kind: "assistant", text: "two" },
      { kind: "assistant", text: "three" },
    ]);
  });

  it("survives malformed lines rather than losing the whole session", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "multicode-transcript-"));
    const file = path.join(dir, "session.jsonl");
    fs.writeFileSync(
      file,
      [
        JSON.stringify(assistantSays("before")),
        "{ this is not json",
        "",
        JSON.stringify(assistantSays("after")),
      ].join("\n")
    );
    expect(readClaudeTranscript(file, 40)).toEqual([
      { kind: "assistant", text: "before" },
      { kind: "assistant", text: "after" },
    ]);
  });

  it("returns empty for a missing file instead of throwing", () => {
    // The session file doesn't exist until the CLI registers a session, and
    // subscribing from a phone must not fail in that window.
    expect(readClaudeTranscript("/nonexistent/session.jsonl", 40)).toEqual([]);
  });

  it("ignores whitespace-only prose", () => {
    const file = writeJsonl([assistantSays("   \n  "), assistantSays("real")]);
    expect(readClaudeTranscript(file, 40)).toEqual([
      { kind: "assistant", text: "real" },
    ]);
  });
});
