// What the builder last said in an OpenCode session and what happened since, from
// its messages and parts (the shapes in OpenCode's `message` and `part` tables).
// The text OpenCode writes itself into a user message is marked `synthetic`; these
// two kinds were all of it in the builder's own database (2026-10-08 survey).
//
// better-sqlite3 is mocked rather than loaded, as in contextUsage.test.ts: the
// installed build targets Electron's ABI. Only the pure reader is tested here.

import { describe, expect, it, vi } from "vitest";

vi.mock("better-sqlite3", () => ({ default: class {} }));

const { opencodeBuilderTurn, opencodeTypedText } = await import("./opencode");
type OpencodeTurnMessage = import("./opencode").OpencodeTurnMessage;

const REMINDER =
  '<system-reminder>Note: The user opened the file "/Users/x/code/phase/src/a.ts"</system-reminder>';
const CONTINUE =
  "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.";

const text = (t: string, extra: Record<string, unknown> = {}) => ({ type: "text", text: t, ...extra });
const tool = (name: string, input: Record<string, unknown>, status = "completed") => ({
  type: "tool",
  tool: name,
  state: { status, input, output: "…" },
});

// Oldest first here for readability; the reader takes them newest first.
function session(...messages: { role: string; parts: Record<string, unknown>[] }[]) {
  const read: number[] = [];
  const newestFirst: OpencodeTurnMessage[] = messages
    .map((message, index) => ({
      role: message.role,
      parts: () => {
        read.push(index);
        return message.parts;
      },
    }))
    .reverse();
  return { newestFirst, read };
}

describe("opencodeTypedText", () => {
  it("keeps what the builder typed and drops what OpenCode added", () => {
    expect(opencodeTypedText([text(REMINDER, { synthetic: true }), text("修一下这个 bug")])).toBe(
      "修一下这个 bug"
    );
  });

  it("is null for a message of only synthetic text, a file or a compaction marker", () => {
    expect(opencodeTypedText([text(CONTINUE, { synthetic: true })])).toBeNull();
    expect(opencodeTypedText([{ type: "file", mime: "image/png", url: "data:…" }])).toBeNull();
    expect(opencodeTypedText([{ type: "compaction", auto: true }])).toBeNull();
    expect(opencodeTypedText([text("x", { ignored: true })])).toBeNull();
  });

  it("keeps the text beside a pasted image", () => {
    expect(opencodeTypedText([{ type: "file", mime: "image/png" }, text("look at this")])).toBe(
      "look at this"
    );
  });
});

describe("opencodeBuilderTurn", () => {
  it("finds the latest typed message and reads the turn after it, in order", () => {
    const { newestFirst } = session(
      { role: "user", parts: [text("first ask")] },
      { role: "assistant", parts: [text("Done.")] },
      { role: "user", parts: [text("run the tests")] },
      { role: "assistant", parts: [{ type: "step-start" }, tool("bash", { command: "pnpm test" })] },
      { role: "assistant", parts: [{ type: "reasoning", text: "…" }, text("All 12 pass.")] }
    );
    expect(opencodeBuilderTurn(newestFirst)).toEqual({
      builderLatestMessage: "run the tests",
      builderEarlierMessages: ["first ask"],
      turn: [
        { kind: "tool", tool: "bash", text: "pnpm test" },
        { kind: "assistant", text: "All 12 pass." },
      ],
    });
  });

  it("skips a user message OpenCode wrote itself, and keeps it in the turn as the system's", () => {
    const { newestFirst } = session(
      { role: "user", parts: [text("refactor the parser")] },
      { role: "assistant", parts: [text("Working on it.")] },
      { role: "user", parts: [text(CONTINUE, { synthetic: true })] },
      { role: "assistant", parts: [text("Finished the refactor.")] }
    );
    const turn = opencodeBuilderTurn(newestFirst);
    expect(turn.builderLatestMessage).toBe("refactor the parser");
    expect(turn.turn).toEqual([
      { kind: "assistant", text: "Working on it." },
      { kind: "user", text: CONTINUE },
      { kind: "assistant", text: "Finished the refactor." },
    ]);
  });

  it("marks the tool the agent is stopped on", () => {
    const { newestFirst } = session(
      { role: "user", parts: [text("clean the build folder")] },
      { role: "assistant", parts: [tool("bash", { command: "rm -rf build" }, "running")] }
    );
    expect(opencodeBuilderTurn(newestFirst).turn).toEqual([
      { kind: "tool", tool: "bash", text: "rm -rf build", pending: true },
    ]);
  });

  it("keeps up to three earlier messages, oldest first", () => {
    const { newestFirst } = session(
      ...["one", "two", "three", "four", "five"].flatMap((t) => [
        { role: "user", parts: [text(t)] },
        { role: "assistant", parts: [text(`ok ${t}`)] },
      ])
    );
    const turn = opencodeBuilderTurn(newestFirst);
    expect(turn.builderLatestMessage).toBe("five");
    expect(turn.builderEarlierMessages).toEqual(["two", "three", "four"]);
    expect(turn.turn).toEqual([{ kind: "assistant", text: "ok five" }]);
  });

  it("never reads the parts of an assistant message before the latest typed one", () => {
    const { newestFirst, read } = session(
      { role: "user", parts: [text("one")] },
      { role: "assistant", parts: [tool("read", { filePath: "big.log" })] },
      { role: "user", parts: [text("two")] },
      { role: "assistant", parts: [text("ok")] }
    );
    opencodeBuilderTurn(newestFirst);
    expect(read).not.toContain(1);
  });

  it("is the whole session when the builder typed nothing", () => {
    const { newestFirst } = session(
      { role: "user", parts: [text(REMINDER, { synthetic: true })] },
      { role: "assistant", parts: [text("Hello.")] }
    );
    expect(opencodeBuilderTurn(newestFirst)).toEqual({
      builderLatestMessage: undefined,
      builderEarlierMessages: [],
      turn: [
        { kind: "user", text: REMINDER },
        { kind: "assistant", text: "Hello." },
      ],
    });
  });
});
