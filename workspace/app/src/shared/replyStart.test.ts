import { describe, expect, it } from "vitest";
import type { TranscriptEntry } from "./remote-protocol";
import {
  awayFromLatest,
  findReplyStart,
  replyConclusion,
  replyNeedle,
  replyOnScreen,
} from "./replyStart";

const say = (text: string): TranscriptEntry => ({ kind: "assistant", text });
const tool = (text: string): TranscriptEntry => ({ kind: "tool", tool: "Bash", text });

describe("replyConclusion", () => {
  it("is the first thing said after the last tool call", () => {
    const turn = [say("Let me look."), tool("ls"), say("Now the tests."), tool("pnpm test"),
      say("The cause is X."), say("Also Y.")];
    expect(replyConclusion(turn)).toBe("The cause is X.");
  });

  it("is the first words of a turn with no tool calls", () => {
    expect(replyConclusion([say("Short answer."), say("More.")])).toBe("Short answer.");
  });

  it("falls back to the last thing said when the turn ended on a tool call", () => {
    expect(replyConclusion([say("Starting."), tool("ls"), say("Running it."), tool("make")]))
      .toBe("Running it.");
  });

  it("is null when the agent said nothing", () => {
    expect(replyConclusion([tool("ls")])).toBeNull();
    expect(replyConclusion([])).toBeNull();
  });

  it("skips user rows inside the turn", () => {
    expect(replyConclusion([tool("ls"), { kind: "user", text: "note" }, say("Done.")]))
      .toBe("Done.");
  });
});

describe("replyNeedle", () => {
  it("keeps only letters and digits, lower-cased, at most 16", () => {
    expect(replyNeedle("**The cause** is `parseConfig()` failing on empty input."))
      .toBe("thecauseisparsec");
  });

  it("works on Chinese text", () => {
    expect(replyNeedle("结论：测试挂掉是因为配置文件为空。")).toBe("结论测试挂掉是因为配置文件为空");
  });

  it("skips lines too short to find, and code fences", () => {
    expect(replyNeedle("## 结\n\n```python\nprint('hello world')\n```")).toBe("printhelloworld");
    expect(replyNeedle("---\n| a | b |\n|---|---|\nThe table above.")).toBe("thetableabove");
  });

  it("reads a link as its text", () => {
    expect(replyNeedle("See [the docs](https://example.com/very/long) first."))
      .toBe("seethedocsfirst");
  });

  it("is null for text with nothing to find", () => {
    expect(replyNeedle("```\n```\n--- \n")).toBeNull();
  });
});

describe("findReplyStart", () => {
  const find = (rows: string[], needle: string) =>
    findReplyStart((i) => rows[i], rows.length, needle);

  it("finds the conclusion's first row as the CLI draws it", () => {
    const rows = [
      "> why does the test fail",
      "● Let me look.",
      "● Bash(pnpm test)",
      "  ⎿  1 failed",
      "",
      "● The cause is parseConfig() failing on empty",
      "  input. Fix it by returning the defaults.",
      "",
      "╭────────────────────────╮",
      "│ >                      │",
      "╰────────────────────────╯",
    ];
    expect(find(rows, replyNeedle("The cause is `parseConfig()` failing on empty input.")!))
      .toBe(5);
  });

  it("takes the newest match, so words repeated from earlier in the turn don't count", () => {
    const rows = ["● The cause is unclear so far.", "● Bash(ls)", "● The cause is unclear so far, but"];
    expect(find(rows, replyNeedle("The cause is unclear so far, but X.")!)).toBe(2);
  });

  it("does not match the same words in the middle of a row", () => {
    const rows = ["● Summary: the cause is X.", "  so the cause is X again"];
    expect(find(rows, replyNeedle("The cause is X.")!)).toBe(-1);
  });

  it("matches a row too narrow for the whole needle", () => {
    const rows = ["● 结论：测试挂掉", "  是因为配置文件为空。"];
    expect(find(rows, replyNeedle("结论：测试挂掉是因为配置文件为空。")!)).toBe(0);
  });

  it("does not take a short row for the start of the needle", () => {
    const rows = ["● The cause is X and Y.", "  the cause"];
    expect(find(rows, replyNeedle("The cause is X and Y.")!)).toBe(0);
  });

  it("is -1 when the conclusion isn't there", () => {
    expect(find(["● Something else."], "thecauseis")).toBe(-1);
    expect(find([], "thecauseis")).toBe(-1);
  });
});

describe("replyOnScreen", () => {
  it("is true when the conclusion's first row is among the screen's rows", () => {
    const needle = replyNeedle("结论：测试挂掉是因为配置文件为空。")!;
    expect(replyOnScreen(["  ┃ 结论：测试挂掉是因为配置文件为空。", "  ┃ 下一行"], needle)).toBe(true);
    expect(replyOnScreen(["  ┃ 下一行", "  ┃ 再下一行"], needle)).toBe(false);
  });
});

describe("awayFromLatest", () => {
  it("reads OpenCode's \"Jump to latest ↓\" above the composer", () => {
    expect(awayFromLatest(["  some reply", "                     Jump to latest ↓", "┃ >"])).toBe(true);
    expect(awayFromLatest(["  some reply", "┃ >"])).toBe(false);
  });
});

