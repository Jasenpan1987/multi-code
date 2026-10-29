// Reading the builder's messages and the turn since the latest one out of a
// session JSONL, in the real on-disk row shapes. The rows that must not count as
// the builder's are the ones the T-501 spike found in real transcripts.

import { describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  builderTurnFromLines,
  claudeTranscriptEntries,
  claudeTurnEntries,
  readBuilderTurn,
  readClaudeRecentTurns,
  typedText,
} from "./claudeTranscript";
import { RECENT_TURNS_ENTRY_CAP } from "./recentTurns";

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

  it("keeps a message of the builder's that merely starts with <", () => {
    for (const text of ["<div>Why is this hidden?</div>", "<T> generics are off", "< 5 items please"]) {
      expect(typedText(typed(text))).toBe(text);
    }
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

  it("reads only the end of a long transcript, widening until it has the messages", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "multicode-turn-"));
    const file = path.join(dir, "s.jsonl");
    try {
      const filler = Array.from({ length: 400 }, (_, i) => JSON.stringify(says(`old ${i} ${"z".repeat(200)}`)));
      const rows = [
        JSON.stringify(typed("first")),
        ...filler,
        JSON.stringify(typed("second")),
        JSON.stringify(typed("third")),
        JSON.stringify(typed("fourth")),
        ...filler,
        JSON.stringify(typed("latest")),
        JSON.stringify(says("done")),
      ];
      fs.writeFileSync(file, rows.join("\n") + "\n");
      // A 1 KiB start window holds only the latest message; it has to widen past
      // the filler to find three more, and never needs the very first row.
      const got = await readBuilderTurn(file, { startBytes: 1024, maxBytes: 1 << 20 });
      expect(got?.builderLatestMessage).toBe("latest");
      expect(got?.builderEarlierMessages).toEqual(["second", "third", "fourth"]);
      expect(got?.turn).toEqual([{ kind: "assistant", text: "done" }]);

      // Capped short of the earlier messages, it settles for what the cap holds.
      const capped = await readBuilderTurn(file, { startBytes: 256, maxBytes: 1024 });
      expect(capped?.builderLatestMessage).toBe("latest");
      expect(capped?.builderEarlierMessages).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is null for a file that can't be read", async () => {
    expect(await readBuilderTurn(path.join(os.tmpdir(), "multicode-no-such-dir", "x.jsonl"))).toBeNull();
  });
});

// A session of three turns in the CLI's own row layout (keys and order as 2.1.308 writes
// them; the content is made up): bookkeeping rows written `type` first, an `api-request`
// row, tool results with the `toolUseResult` the CLI keeps beside them, and the user
// rows that aren't the builder's (an image note, a task notification, `/clear` and
// `/model` with their output). The last line is a row the CLI was still writing.
const FIXTURE = path.join(__dirname, "__fixtures__", "claude-transcript", "three-turns.jsonl");
const at = (second: number) => Date.parse(`2026-10-29T09:${String(Math.floor(second / 60)).padStart(2, "0")}:${String(second % 60).padStart(2, "0")}.000Z`);
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

// The `/clear` the session opens with, shown with its first turn.
const CLEARED = { kind: "user", id: uuid(1), at: at(1), text: "/clear", local: true };
const TURN_1 = [
  CLEARED,
  { kind: "user", id: uuid(3), at: at(10), text: "Add a login endpoint" },
  { kind: "assistant", id: uuid(4), at: at(12), text: "I'll look at the routes first." },
  { kind: "tool", id: "toolu_01Read", at: at(13), tool: "Read", text: "/Users/builder/code/shop/src/routes.ts", outcome: "ok" },
  { kind: "tool", id: "toolu_02Write", at: at(20), tool: "Write", text: "/Users/builder/code/shop/src/login.ts", outcome: "ok", added: 3, removed: 0 },
  { kind: "tool", id: "toolu_03Edit", at: at(30), tool: "Edit", text: "/Users/builder/code/shop/src/routes.ts", outcome: "ok", added: 1, removed: 2 },
  { kind: "tool", id: "toolu_04Bash", at: at(40), tool: "Bash", text: "pnpm test", outcome: "error" },
  { kind: "assistant", id: uuid(14), at: at(60), text: "The endpoint is in, but 3 tests in auth.test.ts fail." },
];
const TURN_2 = [
  { kind: "user", id: uuid(15), at: at(70), text: "[Image #1] what about this?" },
  { kind: "assistant", id: uuid(17), at: at(75), text: "That's the login form." },
  { kind: "assistant", id: uuid(19), at: at(81), text: "The background check passed." },
  // A local command and its output belong to the turn they came after.
  { kind: "user", id: uuid(20), at: at(90), text: "/model", local: true },
  { kind: "assistant", id: uuid(21), at: at(90), text: "Set model to opus", local: true },
];
const TURN_3 = [
  { kind: "user", id: uuid(22), at: at(100), text: "/omt:work T-1" },
  { kind: "tool", id: "toolu_05Bash", at: at(105), tool: "Bash", text: "git status", outcome: "ok" },
  { kind: "tool", id: "toolu_06Bash", at: at(110), tool: "Bash", text: "pnpm build", pending: true },
];

describe("readClaudeRecentTurns", () => {
  it("reads every turn with ids, times, outcomes and line counts", () => {
    expect(readClaudeRecentTurns(FIXTURE, 10)).toEqual({
      entries: [...TURN_1, ...TURN_2, ...TURN_3],
      hasEarlier: false,
    });
  });

  it("selects the last turns and says earlier ones exist", () => {
    expect(readClaudeRecentTurns(FIXTURE, 1)).toEqual({ entries: TURN_3, hasEarlier: true });
    expect(readClaudeRecentTurns(FIXTURE, 2)).toEqual({ entries: [...TURN_2, ...TURN_3], hasEarlier: true });
    expect(readClaudeRecentTurns(FIXTURE, 3).hasEarlier).toBe(false);
  });

  it("widens a small window until it holds the turn before the ones asked for", () => {
    for (const startBytes of [64, 1024, 4096]) {
      const window = { startBytes, maxBytes: 1 << 20 };
      expect(readClaudeRecentTurns(FIXTURE, 1, window)).toEqual({ entries: TURN_3, hasEarlier: true });
      expect(readClaudeRecentTurns(FIXTURE, 3, window)).toEqual({
        entries: [...TURN_1, ...TURN_2, ...TURN_3],
        hasEarlier: false,
      });
    }
  });

  it("parses each row once however often it widens", () => {
    const parse = vi.spyOn(JSON, "parse");
    readClaudeRecentTurns(FIXTURE, 3, { startBytes: 64, maxBytes: 1 << 20 });
    const parsed = parse.mock.calls.length;
    parse.mockRestore();
    // Every line but the bookkeeping rows, the unfinished last one included.
    const rows = fs
      .readFileSync(FIXTURE, "utf8")
      .split("\n")
      .filter((line) => line && (!line.startsWith('{"type":"') || /^\{"type":"(user|assistant)"/.test(line)));
    expect(parsed).toBe(rows.length);
  });

  it("says there is more when the window stops at its cap", () => {
    const capped = readClaudeRecentTurns(FIXTURE, 10, { startBytes: 1024, maxBytes: 4096 });
    expect(capped.hasEarlier).toBe(true);
    expect(capped.entries.slice(-TURN_3.length)).toEqual(TURN_3);
    expect(capped.entries.length).toBeLessThan(TURN_1.length + TURN_2.length + TURN_3.length);
  });

  it("keeps every id as the file grows, and settles the tool that was running", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "multicode-turns-"));
    const file = path.join(dir, "s.jsonl");
    try {
      // Without the half-written last line, which the CLI then finishes as a result.
      const complete = fs.readFileSync(FIXTURE, "utf8").split("\n").slice(0, -1);
      fs.writeFileSync(file, complete.join("\n") + "\n");
      const before = readClaudeRecentTurns(file, 10).entries;
      fs.appendFileSync(
        file,
        lines([
          { ...result("toolu_06Bash"), uuid: "u-built", timestamp: "2026-10-29T09:02:00.000Z" },
          { ...says("Built."), uuid: "u-said", timestamp: "2026-10-29T09:02:01.000Z" },
        ]).join("\n") + "\n"
      );
      const after = readClaudeRecentTurns(file, 10).entries;
      expect(after.slice(0, before.length).map((entry) => entry.id)).toEqual(before.map((entry) => entry.id));
      expect(after.at(-2)).toEqual({ ...TURN_3[2], pending: undefined, outcome: "ok" });
      expect(after.at(-1)).toEqual({ kind: "assistant", id: "u-said", at: Date.parse("2026-10-29T09:02:01.000Z"), text: "Built." });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("caps a read, dropping whole turns from the oldest", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "multicode-turns-"));
    const file = path.join(dir, "s.jsonl");
    const turn = (name: string, tools: number) => [
      { ...typed(name), uuid: `u-${name}` },
      ...Array.from({ length: tools }, (_, i) => calls(`${name}-${i}`, "Read", { file_path: `/f${i}` })),
    ];
    try {
      fs.writeFileSync(file, lines([...turn("a", 250), ...turn("b", 250), ...turn("c", 250)]).join("\n") + "\n");
      const capped = readClaudeRecentTurns(file, 10);
      expect(capped.hasEarlier).toBe(true);
      expect(capped.entries).toHaveLength(502);
      expect(capped.entries[0]).toMatchObject({ kind: "user", text: "b" });

      // A newest turn longer than the cap keeps its end.
      fs.writeFileSync(file, lines(turn("long", RECENT_TURNS_ENTRY_CAP + 50)).join("\n") + "\n");
      const long = readClaudeRecentTurns(file, 10);
      expect(long.hasEarlier).toBe(true);
      expect(long.entries).toHaveLength(RECENT_TURNS_ENTRY_CAP);
      expect(long.entries.at(-1)?.id).toBe(`long-${RECENT_TURNS_ENTRY_CAP + 49}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is empty for a file that can't be read", () => {
    expect(readClaudeRecentTurns(path.join(os.tmpdir(), "multicode-no-such-dir", "x.jsonl"), 10)).toEqual({
      entries: [],
      hasEarlier: false,
    });
  });
});

// The rows Claude Code 2.1.312 writes around local commands, in its own layout and key
// order (measured 2026-10-30 on a scratch session; the text here is made up): the
// caveat, the command row, its output as a `local_command` system row or a user row,
// and for a command it doesn't know, only an `informational` system row.
const CLI_ROW = { isSidechain: false, userType: "external", entrypoint: "cli", cwd: "/Users/builder/code/shop", version: "2.1.312" };
const CAVEAT =
  "<local-command-caveat>The command below was run directly in Claude Code, not sent to you as a request, and its output goes straight to the user. It's recorded here as context for later messages.</local-command-caveat>";

function cliSession() {
  let parent: string | null = null;
  let second = 0;
  const rows: unknown[] = [];
  const row = (id: string, fields: Record<string, unknown>) => {
    rows.push({ parentUuid: parent, ...CLI_ROW, ...fields, uuid: id, timestamp: `2026-10-30T01:00:${String(second++).padStart(2, "0")}.000Z` });
    parent = id;
  };
  const user = (id: string, content: unknown, extra: Record<string, unknown> = {}) =>
    row(id, { type: "user", message: { role: "user", content }, ...extra });
  const system = (id: string, subtype: string, content: string, extra: Record<string, unknown> = {}) =>
    row(id, { type: "system", subtype, content, isMeta: false, ...extra });
  const command = (id: string, name: string) => {
    user(`${id}-caveat`, CAVEAT, { isMeta: true });
    user(id, `<command-name>/${name}</command-name>\n            <command-message>${name}</command-message>\n            <command-args></command-args>`);
  };
  const assistant = (id: string, text: string) =>
    row(id, { type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });
  return { rows, user, system, command, assistant, at: (n: number) => Date.parse(`2026-10-30T01:00:${String(n).padStart(2, "0")}.000Z`) };
}

describe("local commands in the phone's turns", () => {
  it("shows each command the CLI ran itself and its output as local lines, in the 2.1.312 layout", () => {
    const s = cliSession();
    // A session `/new` started: the CLI's `/clear` at its top, with no output.
    s.command("clear", "clear");
    s.system("clear-out", "local_command", "<local-command-stdout></local-command-stdout>", { level: "info", commandRun: { command: "clear", args: "" } });
    s.system("token", "informational", "Unknown command: /token", { level: "warning" });
    s.user("ping", "Reply with one word");
    s.assistant("pong", "Pong.");
    s.system("took", "turn_duration", "", { durationMs: 900 });
    s.command("context", "context");
    s.system("context-out", "local_command", "<local-command-stdout> \x1b[1mContext Usage\x1b[22m\n\x1b[38;2;136;136;136m⛁ ⛀ \x1b[39m 12k tokens</local-command-stdout>", { level: "info" });
    s.command("exit", "exit");
    s.user("exit-out", "<local-command-stdout>See ya!</local-command-stdout>");

    expect(claudeTurnEntries(s.rows)).toEqual([
      { kind: "user", id: "clear", at: s.at(1), text: "/clear", local: true },
      { kind: "user", id: "token:command", at: s.at(3), text: "/token", local: true },
      { kind: "assistant", id: "token", at: s.at(3), text: "Unknown command: /token", local: true },
      { kind: "user", id: "ping", at: s.at(4), text: "Reply with one word" },
      { kind: "assistant", id: "pong", at: s.at(5), text: "Pong." },
      { kind: "user", id: "context", at: s.at(8), text: "/context", local: true },
      { kind: "assistant", id: "context-out", at: s.at(9), text: "Context Usage\n⛁ ⛀  12k tokens", local: true },
      { kind: "user", id: "exit", at: s.at(11), text: "/exit", local: true },
      { kind: "assistant", id: "exit-out", at: s.at(12), text: "See ya!", local: true },
    ]);
  });

  it("reads a command row an older CLI wrote as a system row, and an unknown command's older wording", () => {
    const s = cliSession();
    s.system("model", "local_command", "<command-name>/model</command-name>\n            <command-message>model</command-message>\n            <command-args>haiku</command-args>", { level: "info" });
    s.system("model-out", "local_command", "<local-command-stdout>Set model to \x1b[1mHaiku 4.5\x1b[22m</local-command-stdout>", { level: "info" });
    s.system("old", "informational", "Unknown slash command: token", { level: "warning" });
    expect(claudeTurnEntries(s.rows).map((entry) => [entry.kind, entry.text, entry.local])).toEqual([
      ["user", "/model haiku", true],
      ["assistant", "Set model to Haiku 4.5", true],
      ["user", "/token", true],
      ["assistant", "Unknown slash command: token", true],
    ]);
  });

  it("leaves out the CLI's other notices, and a command's output that only a tool read", () => {
    const s = cliSession();
    s.user("go", "go on");
    s.system("bg", "informational", "Backgrounding after the current tool finishes…", { level: "warning" });
    s.system("hooks", "stop_hook_summary", "", { level: "suggestion" });
    s.user("grep", [{ type: "tool_result", tool_use_id: "t1", content: "<local-command-stdout>old</local-command-stdout>" }]);
    expect(claudeTurnEntries(s.rows).map((entry) => entry.text)).toEqual(["go on"]);
  });

  it("shows a command whose child isn't written yet as local", () => {
    const s = cliSession();
    s.command("model", "model");
    expect(claudeTurnEntries(s.rows)).toEqual([{ kind: "user", id: "model", at: s.at(1), text: "/model", local: true }]);
  });

  it("counts no local command as a turn, and shows a session's leading ones with its first turn", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "multicode-local-"));
    const file = path.join(dir, "s.jsonl");
    try {
      const s = cliSession();
      s.command("clear", "clear");
      s.system("clear-out", "local_command", "<local-command-stdout></local-command-stdout>");
      s.user("a", "first");
      s.assistant("a-said", "One.");
      s.system("token", "informational", "Unknown command: /token");
      s.command("model", "model");
      s.system("model-out", "local_command", "<local-command-stdout>Kept model as Haiku</local-command-stdout>");
      s.user("b", "second");
      s.assistant("b-said", "Two.");
      fs.writeFileSync(file, lines(s.rows).join("\n") + "\n");
      const ids = (read: { entries: { id?: string }[] }) => read.entries.map((entry) => entry.id);

      const last = readClaudeRecentTurns(file, 1);
      expect(ids(last)).toEqual(["b", "b-said"]);
      expect(last.hasEarlier).toBe(true);
      const both = ["clear", "a", "a-said", "token:command", "token", "model", "model-out", "b", "b-said"];
      expect(ids(readClaudeRecentTurns(file, 2))).toEqual(both);
      expect(readClaudeRecentTurns(file, 2).hasEarlier).toBe(false);
      // A window too small for both turns widens past the local lines, which aren't one.
      for (const startBytes of [64, 512, 2048]) {
        expect(ids(readClaudeRecentTurns(file, 2, { startBytes, maxBytes: 1 << 20 }))).toEqual(both);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("shows a session of nothing but local commands whole: the one `/new` just opened", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "multicode-local-"));
    const file = path.join(dir, "s.jsonl");
    try {
      const s = cliSession();
      s.command("clear", "clear");
      s.system("clear-out", "local_command", "<local-command-stdout></local-command-stdout>");
      s.system("token", "informational", "Unknown command: /token");
      fs.writeFileSync(file, lines(s.rows).join("\n") + "\n");
      expect(readClaudeRecentTurns(file, 1)).toEqual({
        entries: [
          { kind: "user", id: "clear", at: s.at(1), text: "/clear", local: true },
          { kind: "user", id: "token:command", at: s.at(3), text: "/token", local: true },
          { kind: "assistant", id: "token", at: s.at(3), text: "Unknown command: /token", local: true },
        ],
        hasEarlier: false,
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves the manager's and the secretary's readers as they were", () => {
    const s = cliSession();
    s.command("clear", "clear");
    s.system("clear-out", "local_command", "<local-command-stdout></local-command-stdout>");
    s.system("token", "informational", "Unknown command: /token");
    s.user("ping", "Reply with one word");
    s.assistant("pong", "Pong.");
    const turn = builderTurnFromLines(lines(s.rows));
    expect(turn.builderLatestMessage).toBe("Reply with one word");
    expect(turn.turn).toEqual([{ kind: "assistant", text: "Pong." }]);
    expect(claudeTranscriptEntries(lines(s.rows)).some((entry) => entry.local)).toBe(false);
  });
});

describe("claudeTurnEntries", () => {
  it("counts only what the builder typed as user entries", () => {
    const entries = claudeTurnEntries([
      typed("Continue from where you left off.", { isMeta: true }),
      typed("<task-notification>done</task-notification>"),
      typed("[Request interrupted by user]"),
      typed("This session is being continued…", { isCompactSummary: true }),
      typed("go on"),
      says("Going."),
    ]);
    expect(entries.map((entry) => [entry.kind, entry.text])).toEqual([
      ["user", "go on"],
      ["assistant", "Going."],
    ]);
  });

  it("starts a turn at a command only when the CLI hands its prompt to the agent, else shows it as local", () => {
    // Rows chained the way the CLI chains them, each the previous one's child.
    let parent: string | null = null;
    const chained = (row: Record<string, unknown>, uuid: string) => {
      const linked = { ...row, uuid, parentUuid: parent };
      parent = uuid;
      return linked;
    };
    const command = (uuid: string, name: string, args = "") =>
      chained(
        typed(`<command-name>${name}</command-name>\n<command-message>x</command-message>\n<command-args>${args}</command-args>`),
        uuid
      );
    const meta = (uuid: string, text: string) => chained(typed([{ type: "text", text }], { isMeta: true }), uuid);
    const entries = claudeTurnEntries([
      command("c1", "/clear"),
      chained({ type: "system", subtype: "local_command" }, "s1"),
      // Not the command's child: a note the CLI added after it had run.
      chained(typed("Continue from where you left off.", { isMeta: true }), "m0"),
      chained(says("Continuing."), "a0"),
      command("c2", "/compact"),
      chained(typed("<local-command-stdout>Compacted</local-command-stdout>"), "o2"),
      command("c3", "/init"),
      meta("m3", "Please analyze this codebase…"),
      chained(says("Reading."), "a3"),
      command("c4", "/plan", "add a cache"),
      meta("m4", "Plan this."),
    ]);
    expect(entries.map((entry) => [entry.kind, entry.id, entry.text, entry.local])).toEqual([
      ["user", "c1", "/clear", true],
      ["assistant", "a0", "Continuing.", undefined],
      ["user", "c2", "/compact", true],
      ["assistant", "o2", "Compacted", true],
      ["user", "c3", "/init", undefined],
      ["assistant", "a3", "Reading.", undefined],
      ["user", "c4", "/plan add a cache", undefined],
    ]);
  });

  it("never takes a compaction summary for a command, though it quotes one's tags", () => {
    const entries = claudeTurnEntries([
      { ...typed("add a cache"), uuid: "u1" },
      { ...says("Added."), uuid: "a1" },
      {
        ...typed("Summary: the builder ran <command-name>/omt:work</command-name> <command-args>T-1</command-args>…", {
          isCompactSummary: true,
        }),
        uuid: "s1",
      },
      typed([{ type: "text", text: "Continue." }], { isMeta: true, uuid: "m1", parentUuid: "s1" }),
    ]);
    expect(entries.map((entry) => [entry.kind, entry.text])).toEqual([
      ["user", "add a cache"],
      ["assistant", "Added."],
    ]);
  });

  it("reads a denied or interrupted call as an error, and counts no lines for it", () => {
    const entries = claudeTurnEntries([
      calls("t1", "Edit", { file_path: "/a.ts" }),
      {
        ...typed([{ type: "tool_result", tool_use_id: "t1", is_error: true, content: "The user doesn't want to proceed" }]),
        toolUseResult: { structuredPatch: [{ lines: ["+x"] }] },
      },
    ]);
    expect(entries).toEqual([{ kind: "tool", id: "t1", tool: "Edit", text: "/a.ts", outcome: "error" }]);
  });

  it("never marks a call without an id as running", () => {
    const entries = claudeTurnEntries([
      { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "Bash", input: { command: "ls" } }] } },
    ]);
    expect(entries).toEqual([{ kind: "tool", tool: "Bash", text: "ls" }]);
  });
});
