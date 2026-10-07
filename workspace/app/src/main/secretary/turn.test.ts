// Reading the builder's messages and the turn since the latest one out of a
// session JSONL, in the real on-disk row shapes. The rows that must not count as
// the builder's are the ones the T-501 spike found in real transcripts.

import { describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { builderTurnFromLines, readBuilderTurn, typedText } from "./turn";

const typed = (content: unknown, extra: Record<string, unknown> = {}) => ({
  type: "user",
  message: { role: "user", content },
  ...extra,
});
const says = (text: string) => ({
  type: "assistant",
  message: { role: "assistant", content: [{ type: "text", text }] },
});
const calls = (id: string, name: string, input: unknown) => ({
  type: "assistant",
  message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] },
});
const result = (id: string) => typed([{ type: "tool_result", tool_use_id: id, content: "ok" }]);
const lines = (rows: unknown[]) => rows.map((row) => JSON.stringify(row));

describe("typedText: what counts as the builder's message", () => {
  it("takes a string body", () => {
    expect(typedText(typed("  merge it into main  "))).toBe("merge it into main");
  });

  it("takes the text parts of an array body, so a message with a pasted image counts", () => {
    const row = typed([
      { type: "text", text: "[Image #1] 这个对吗？" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
    ]);
    expect(typedText(row)).toBe("[Image #1] 这个对吗？");
  });

  it("skips rows the CLI added (isMeta), such as its image notes", () => {
    expect(
      typedText(typed("[Image: original 2400x1600, displayed at 2000x1333.]", { isMeta: true }))
    ).toBeNull();
    expect(typedText(typed("Continue from where you left off.", { isMeta: true }))).toBeNull();
  });

  it("skips tool results", () => {
    expect(typedText(result("t1"))).toBeNull();
  });

  it("skips the CLI's tagged rows", () => {
    for (const text of [
      "<command-name>/clear</command-name>\n<command-message>clear</command-message>",
      "<bash-input> ls</bash-input>",
      "<task-notification>\n<task-id>b1</task-id>",
      "<local-command-stdout>Already in plan mode.</local-command-stdout>",
    ]) {
      expect(typedText(typed(text))).toBeNull();
    }
    expect(typedText(typed([{ type: "text", text: "<command-name>/plan</command-name>" }]))).toBeNull();
  });

  it("skips the interruption marker", () => {
    expect(typedText(typed("[Request interrupted by user for tool use]"))).toBeNull();
    expect(typedText(typed([{ type: "text", text: "[Request interrupted by user]" }]))).toBeNull();
  });

  it("skips a compaction summary", () => {
    expect(
      typedText(typed("This session is being continued from a previous conversation…", { isCompactSummary: true }))
    ).toBeNull();
  });

  it("skips assistant rows, empty bodies and other row types", () => {
    expect(typedText(says("hi"))).toBeNull();
    expect(typedText(typed("   "))).toBeNull();
    expect(typedText(typed([{ type: "image" }]))).toBeNull();
    expect(typedText({ type: "file-history-snapshot" })).toBeNull();
    expect(typedText(null)).toBeNull();
  });
});

describe("builderTurnFromLines", () => {
  it("takes the latest message, up to three before it oldest first, and the turn since", () => {
    const turn = builderTurnFromLines(
      lines([
        typed("first"),
        says("ok 1"),
        typed("second"),
        typed("[Image: original 2400x1600]", { isMeta: true }),
        typed("third"),
        says("ok 3"),
        typed("fourth"),
        typed("latest: build it"),
        says("Building."),
        calls("t1", "Bash", { command: "pnpm build" }),
        result("t1"),
        typed("<task-notification>done</task-notification>"),
        says("The build passed."),
      ])
    );
    expect(turn.builderLatestMessage).toBe("latest: build it");
    expect(turn.builderEarlierMessages).toEqual(["second", "third", "fourth"]);
    expect(turn.turn).toEqual([
      { kind: "assistant", text: "Building." },
      { kind: "tool", tool: "Bash", text: "pnpm build" },
      { kind: "user", text: "<task-notification>done</task-notification>" },
      { kind: "assistant", text: "The build passed." },
    ]);
  });

  it("marks the tool the agent is stopped on as pending", () => {
    const turn = builderTurnFromLines(
      lines([
        typed("delete the old branch"),
        calls("t1", "Bash", { command: "git branch -D old" }),
      ])
    );
    expect(turn.turn).toEqual([
      { kind: "tool", tool: "Bash", text: "git branch -D old", pending: true },
    ]);
  });

  it("has fewer earlier messages when the session has fewer", () => {
    const turn = builderTurnFromLines(lines([typed("only one"), says("done")]));
    expect(turn.builderLatestMessage).toBe("only one");
    expect(turn.builderEarlierMessages).toEqual([]);
  });

  it("with no typed message, has none and takes the whole session as the turn", () => {
    const turn = builderTurnFromLines(
      lines([typed("<command-name>/init</command-name>"), says("Wrote CLAUDE.md.")])
    );
    expect(turn.builderLatestMessage).toBeUndefined();
    expect(turn.builderEarlierMessages).toEqual([]);
    expect(turn.turn).toEqual([
      { kind: "user", text: "<command-name>/init</command-name>" },
      { kind: "assistant", text: "Wrote CLAUDE.md." },
    ]);
  });

  it("skips blank and broken lines", () => {
    const turn = builderTurnFromLines(["", "{not json", JSON.stringify(typed("go")), "  ", JSON.stringify(says("went"))]);
    expect(turn.builderLatestMessage).toBe("go");
    expect(turn.turn).toEqual([{ kind: "assistant", text: "went" }]);
  });
});

describe("readBuilderTurn", () => {
  it("reads a JSONL file", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "multicode-turn-"));
    const file = path.join(dir, "session.jsonl");
    fs.writeFileSync(file, lines([typed("hello"), says("hi")]).join("\n") + "\n");
    try {
      expect(await readBuilderTurn(file)).toEqual({
        builderLatestMessage: "hello",
        builderEarlierMessages: [],
        turn: [{ kind: "assistant", text: "hi" }],
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is null for a file that can't be read", async () => {
    expect(await readBuilderTurn(path.join(os.tmpdir(), "multicode-no-such-dir", "x.jsonl"))).toBeNull();
  });
});
