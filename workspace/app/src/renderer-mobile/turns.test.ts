// Turn grouping, the fold line's counts, each tool line's mark, and where the chat
// lands, on transcripts shaped like the T-804 readers' (both backends).

import { describe, expect, it } from "vitest";
import type { TranscriptEntry } from "../shared/remote-protocol";
import {
  commandLine,
  foldCounts,
  foldLabel,
  groupTurns,
  landingOf,
  runningTool,
  toolMark,
  toolVerb,
  type Turn,
} from "./turns";

let n = 0;
const t0 = 1_800_000_000_000;
const user = (text: string, s = 0): TranscriptEntry => ({ kind: "user", id: `e${++n}`, at: t0 + s * 1000, text });
const say = (text: string, s = 0): TranscriptEntry => ({ kind: "assistant", id: `e${++n}`, at: t0 + s * 1000, text });
const tool = (name: string, text: string, s = 0, extra: Partial<TranscriptEntry> = {}): TranscriptEntry => ({
  kind: "tool",
  id: `e${++n}`,
  at: t0 + s * 1000,
  tool: name,
  text,
  outcome: "ok",
  ...extra,
});

// A CLI command the builder ran, and the CLI's output for it.
const ran = (text: string, s = 0): TranscriptEntry => ({ ...user(text, s), local: true });
const said = (text: string, s = 0): TranscriptEntry => ({ ...say(text, s), local: true });

const idle = { working: false, waiting: false };

// Mockup 2.1's turn, as the harness's `finished` scenario writes it.
function jwtTurn(): TranscriptEntry[] {
  return [
    user("把登录接口改成 JWT", 0),
    tool("Read", "src/auth/session.ts", 16),
    tool("Read", "src/routes/login.ts", 28),
    tool("Grep", "sessionId", 40),
    tool("Read", "src/db/user.ts", 52),
    tool("Read", "src/middleware/auth.ts", 64),
    tool("Read", "package.json", 76),
    say("先把签发和校验放到新文件里。", 87),
    tool("Write", "src/auth/jwt.ts", 88, { added: 48, removed: 0 }),
    tool("Edit", "src/routes/login.ts", 100, { added: 12, removed: 30 }),
    tool("Edit", "src/auth/legacySession.ts", 112, { added: 9, removed: 2 }),
    tool("Bash", "pnpm test", 124, { outcome: "error" }),
    say("有 3 个测试失败。", 135),
    tool("Edit", "src/auth/jwt.ts", 136, { added: 3, removed: 1 }),
    tool("Bash", "pnpm test", 148),
    say("改好了。\n\n- 42 个单元测试全过", 161),
  ];
}

describe("groupTurns", () => {
  it("starts a turn at each message and folds the calls and what was said between them", () => {
    const turns = groupTurns([...jwtTurn(), user("refresh token 放哪？", 200), say("放 httpOnly cookie。", 210)], idle);
    expect(turns).toHaveLength(2);
    const [jwt, short] = turns;
    expect(jwt.user?.text).toBe("把登录接口改成 JWT");
    expect(jwt.lead).toEqual([]);
    expect(jwt.fold).toHaveLength(14);
    expect(jwt.fold.filter((e) => e.kind === "assistant").map((e) => e.text)).toEqual([
      "先把签发和校验放到新文件里。",
      "有 3 个测试失败。",
    ]);
    expect(jwt.conclusion.map((e) => e.text)).toEqual(["改好了。\n\n- 42 个单元测试全过"]);
    expect(jwt.endAt! - jwt.startAt!).toBe(161_000);
    // No calls: no fold, all it said is the conclusion.
    expect(short.fold).toEqual([]);
    expect(short.conclusion.map((e) => e.text)).toEqual(["放 httpOnly cookie。"]);
  });

  it("keeps what came before the first call out of the fold", () => {
    const [turn] = groupTurns(
      [user("登录页加记住我"), say("先看一下现在的登录表单。"), tool("Read", "src/pages/Login.tsx"), say("加好了。")],
      idle
    );
    expect(turn.lead.map((e) => e.text)).toEqual(["先看一下现在的登录表单。"]);
    expect(turn.fold.map((e) => e.text)).toEqual(["src/pages/Login.tsx"]);
    expect(turn.conclusion.map((e) => e.text)).toEqual(["加好了。"]);
  });

  it("makes a turn of what comes before the first message, without one", () => {
    const turns = groupTurns([tool("Read", "a.ts"), say("partly read oldest turn"), user("next"), say("ok")], idle);
    expect(turns.map((t) => t.user?.text ?? null)).toEqual([null, "next"]);
    expect(turns[0].fold).toHaveLength(1);
    expect(turns[0].conclusion.map((e) => e.text)).toEqual(["partly read oldest turn"]);
    expect(turns[0].key).toBe(turns[0].fold[0].id);
  });

  it("keys turns and folds by entry id, so a refresh keeps them", () => {
    const entries = jwtTurn();
    const first = groupTurns(entries, idle)[0];
    const again = groupTurns(
      entries.map((e) => ({ ...e })),
      idle
    )[0];
    expect(again.key).toBe(first.key);
    expect(again.foldKey).toBe(first.foldKey);
    expect(first.key).toBe(entries[0].id);
    expect(first.foldKey).toBe(entries[1].id);
  });

  it("keys entries without ids by what they are, so loading earlier turns moves no key", () => {
    const bare = (e: TranscriptEntry): TranscriptEntry => ({ ...e, id: undefined });
    const older = [user("older", 0), tool("Read", "a.ts", 5), say("ok", 9)].map(bare);
    const shown = [user("newer", 20), tool("Bash", "pnpm test", 25), say("done", 30), user("newer", 40), say("again", 41)].map(bare);
    const before = groupTurns(shown, idle);
    const after = groupTurns([...older, ...shown], idle);
    expect(after.slice(1).map((t) => [t.key, t.foldKey])).toEqual(before.map((t) => [t.key, t.foldKey]));
    expect(new Set(after.map((t) => t.key)).size).toBe(after.length);
    // Two identical messages with no time either still get keys of their own.
    const twins = groupTurns([user("yes"), say("a"), user("yes"), say("b")].map((e) => ({ ...bare(e), at: undefined })), idle);
    expect(new Set(twins.map((t) => t.key)).size).toBe(2);
  });

  it("puts everything after the lead in a running turn's fold, and marks the running call", () => {
    const entries = [
      user("登录页加记住我", 0),
      say("先看一下。", 10),
      tool("Read", "src/pages/Login.tsx", 15),
      tool("Edit", "src/api/auth.ts", 110, { added: 6, removed: 0 }),
      say("再跑一下测试。", 158),
      tool("Bash", "pnpm test --filter login", 159, { outcome: undefined, pending: true }),
    ];
    const [turn] = groupTurns(entries, { working: true, waiting: false });
    expect(turn.live).toBe(true);
    expect(turn.lead.map((e) => e.text)).toEqual(["先看一下。"]);
    expect(turn.fold.map((e) => e.text)).toEqual([
      "src/pages/Login.tsx",
      "src/api/auth.ts",
      "再跑一下测试。",
      "pnpm test --filter login",
    ]);
    expect(turn.conclusion).toEqual([]);
    expect(runningTool(turn)?.text).toBe("pnpm test --filter login");
    // Only the last turn is the running one.
    const turns = groupTurns([user("earlier"), tool("Read", "x"), say("done"), ...entries], { working: true, waiting: false });
    expect(turns.map((t) => t.live)).toEqual([false, true]);
    expect(runningTool(turns[0])).toBeUndefined();
  });

  it("leaves the call a dialog is about out of the fold (mockup 3.1)", () => {
    const entries = [
      user("打包体积好像变大了", 0),
      tool("Read", "package.json", 5),
      tool("Read", "rspack.renderer.config.ts", 15),
      tool("Glob", "dist/**/*.map", 25),
      tool("Bash", "du -sh dist", 45),
      say("sourcemap 有 38 MB。我清掉重新打一次。", 60),
      tool("Bash", "rm -rf dist && pnpm build", 65, { outcome: undefined, pending: true }),
    ];
    const [turn] = groupTurns(entries, { working: false, waiting: true });
    expect(turn.waiting).toBe(true);
    expect(foldLabel(turn.fold, turn.live)).toBe("4 tools · 3 read · 1 command");
    expect(turn.conclusion.map((e) => e.text)).toEqual(["sourcemap 有 38 MB。我清掉重新打一次。"]);
    // The turn's time runs to its last entry, the dialog's call included: 1m 05s.
    expect(turn.endAt! - turn.startAt!).toBe(65_000);
  });
});

describe("command lines", () => {
  const texts = (turn: Turn) => turn.lines.map((line) => line.entries.map((e) => e.text));

  it("draws each command, with the output after it, as a line after the turn it came in", () => {
    const turns = groupTurns(
      [
        user("你是谁", 0),
        say("我是 Claude。", 5),
        ran("/token", 10),
        said("Unknown command: /token", 10),
        ran("/compact", 20),
        user("你是什么模型", 30),
        say("Opus 5.5。", 35),
      ],
      idle
    );
    // Commands start no turn.
    expect(turns).toHaveLength(2);
    expect(texts(turns[0])).toEqual([["/token", "Unknown command: /token"], ["/compact"]]);
    expect(texts(turns[1])).toEqual([]);
    // The turn itself is whole: the answer is still its conclusion, and it took the
    // 5 s to answer, not the 20 s to the last command.
    expect(turns[0].conclusion.map((e) => e.text)).toEqual(["我是 Claude。"]);
    expect(turns[0].endAt! - turns[0].startAt!).toBe(5000);
    expect(turns[0].endsInCommand).toBe(true);
    expect(turns[1].endsInCommand).toBe(false);
    expect(commandLine(turns[0].lines[0])).toEqual({ command: "/token", output: "Unknown command: /token" });
    expect(commandLine(turns[0].lines[1])).toEqual({ command: "/compact", output: "" });
  });

  it("shows output without a command alone, and drops terminal colours", () => {
    const [turn] = groupTurns([said("\x1b[1mCompacted\x1b[0m \n", 0), said("ctrl+o to see the summary", 0)], idle);
    expect(turn.user).toBeNull();
    expect(commandLine(turn.lines[0])).toEqual({ command: null, output: "Compacted\nctrl+o to see the summary" });
  });

  it("puts the /clear a new session opens with before its first message", () => {
    const turns = groupTurns([ran("/clear", 0), user("你好", 5), say("你好！", 6)], idle);
    expect(turns.map((t) => [t.user?.text ?? null, texts(t)])).toEqual([
      [null, [["/clear"]]],
      ["你好", []],
    ]);
    expect(landingOf(turns, 0)).toEqual({ kind: "conclusion", turn: turns[1].key });
  });

  it("keeps a command run in the middle of a turn out of its fold and counts, and the turn whole", () => {
    const entries = [
      user("跑测试", 0),
      tool("Read", "package.json", 5),
      ran("/cost", 8),
      said("Total cost: $0.41", 8),
      tool("Bash", "pnpm test", 10),
      say("全过了。", 20),
    ];
    const [turn, ...rest] = groupTurns(entries, idle);
    expect(rest).toEqual([]);
    expect(foldLabel(turn.fold, false)).toBe("2 tools · 1 read · 1 command");
    expect(turn.conclusion.map((e) => e.text)).toEqual(["全过了。"]);
    expect([...turn.lead, ...turn.fold, ...turn.conclusion].some((e) => e.local)).toBe(false);
    expect(texts(turn)).toEqual([["/cost", "Total cost: $0.41"]]);
    // The agent spoke after it, so the screen lands on the conclusion as usual.
    expect(turn.endsInCommand).toBe(false);
  });

  it("leaves a running turn as it was when a command comes in the middle of it", () => {
    const before = [
      user("跑测试", 0),
      tool("Read", "package.json", 5, { outcome: undefined, pending: true }),
    ];
    const working = { working: true, waiting: false };
    const [was] = groupTurns(before, working);
    const [turn] = groupTurns(
      [...before, ran("/cost", 8), said("Total cost: $0.41", 8), tool("Bash", "pnpm test", 10, { outcome: undefined, pending: true })],
      working
    );
    // The same turn: its key (the working bar is keyed by it) and its start.
    expect(turn.key).toBe(was.key);
    expect(turn.startAt).toBe(was.startAt);
    expect(turn.live).toBe(true);
    expect(turn.fold.map((e) => toolMark(e, turn.live).kind)).toEqual(["running", "running"]);
    expect(runningTool(turn)?.text).toBe("pnpm test");
  });

  it("leaves the dialog's call out of the fold when a line comes after it", () => {
    const entries = [
      user("跑测试", 0),
      tool("Bash", "pnpm test", 5, { outcome: undefined, pending: true }),
      said("Context left until auto-compact: 12%", 6),
    ];
    const [turn] = groupTurns(entries, { working: false, waiting: true });
    expect(turn.waiting).toBe(true);
    expect(turn.fold).toEqual([]);
    expect(texts(turn)).toEqual([["Context left until auto-compact: 12%"]]);
  });
});

describe("the fold line", () => {
  it("counts files read and edited once each, and every command run (mockup 2.1)", () => {
    const [turn] = groupTurns(jwtTurn(), idle);
    expect(foldCounts(turn.fold)).toEqual({ tools: 12, read: 6, edited: 3, commands: 2 });
    expect(foldLabel(turn.fold, false)).toBe("12 tools · 6 read · 3 edited · 2 commands");
  });

  it("says running while the turn runs, and leaves out counts of nothing", () => {
    const fold = [tool("Read", "a"), tool("Bash", "pnpm lint", 0, { pending: true, outcome: undefined })];
    expect(foldLabel(fold, true)).toBe("2 tools · running");
    expect(foldLabel([tool("WebFetch", "https://example.com")], false)).toBe("1 tool");
    expect(foldLabel([tool("Bash", "ls")], false)).toBe("1 tool · 1 command");
  });

  it("reads OpenCode's names the same, a `!command` (shell) as a command", () => {
    const fold = [
      tool("read", "db/schema.sql"),
      tool("grep", "orders_v1"),
      tool("write", "db/migrations/0042.sql", 0, { added: 64, removed: 0 }),
      tool("patch", "db/migrations/0042.sql"),
      tool("bash", "pnpm db:migrate --dry-run"),
      tool("shell", "git status"),
      tool("question", ""),
    ];
    expect(foldLabel(fold, false)).toBe("7 tools · 2 read · 1 edited · 2 commands");
  });

  it("counts calls without a target one by one", () => {
    expect(foldCounts([tool("Glob", ""), tool("Glob", "")]).read).toBe(2);
  });
});

describe("a tool line", () => {
  it("marks a failure without a count, lines added and removed, and done", () => {
    expect(toolMark(tool("Bash", "pnpm test", 0, { outcome: "error" }), false)).toEqual({ kind: "failed" });
    expect(toolMark(tool("Edit", "a.ts", 0, { outcome: "error", added: 3 }), false)).toEqual({ kind: "failed" });
    expect(toolMark(tool("Edit", "a.ts", 0, { added: 12, removed: 30 }), false)).toEqual({
      kind: "lines",
      added: 12,
      removed: 30,
    });
    expect(toolMark(tool("Edit", "a.ts", 0, { added: 6 }), false)).toEqual({ kind: "lines", added: 6, removed: 0 });
    // Some writes carry no counts.
    expect(toolMark(tool("Write", "a.ts"), false)).toEqual({ kind: "done" });
    expect(toolMark(tool("Read", "a.ts", 0, { outcome: undefined }), false)).toEqual({ kind: "unknown" });
  });

  it("marks a pending call running only in the running turn", () => {
    const pending = tool("Bash", "sleep 9", 0, { pending: true, outcome: undefined });
    expect(toolMark(pending, true)).toEqual({ kind: "running" });
    expect(toolMark(pending, false)).toEqual({ kind: "stalled" });
  });

  it("names the action as both backends would read it", () => {
    expect(toolVerb("Read")).toBe("Read");
    expect(toolVerb("bash")).toBe("Bash");
    expect(toolVerb("shell")).toBe("Shell");
    expect(toolVerb("mcp__linear__create_issue")).toBe("Create_issue");
    expect(toolVerb(undefined)).toBe("Tool");
  });
});

describe("landingOf", () => {
  const turnsOf = (entries: TranscriptEntry[], session = idle): Turn[] => groupTurns(entries, session);

  it("lands on the conclusion of a finished last turn", () => {
    const turns = turnsOf([user("earlier"), say("ok"), ...jwtTurn()]);
    expect(landingOf(turns, 0)).toEqual({ kind: "conclusion", turn: turns[1].key });
  });

  it("lands at the bottom while the turn runs, on a dialog, after the builder's own message, or with no conclusion", () => {
    const entries = jwtTurn();
    expect(landingOf(turnsOf(entries, { working: true, waiting: false }), 0)).toEqual({ kind: "bottom" });
    expect(landingOf(turnsOf(entries, { working: false, waiting: true }), 0)).toEqual({ kind: "bottom" });
    expect(landingOf(turnsOf(entries), 1)).toEqual({ kind: "bottom" });
    // Stopped mid-call: the turn ends on a tool.
    expect(landingOf(turnsOf([user("go"), tool("Bash", "x", 0, { outcome: "error" })]), 0)).toEqual({ kind: "bottom" });
    expect(landingOf([], 0)).toEqual({ kind: "bottom" });
  });

  it("lands at the bottom after a command, never on its output as a conclusion", () => {
    // The builder ran it after reading the answer: what it said is at the bottom.
    const after = turnsOf([...jwtTurn(), ran("/token", 200), said("Unknown command: /token", 200)]);
    expect(landingOf(after, 0)).toEqual({ kind: "bottom" });
    // Its output alone isn't a conclusion either.
    expect(landingOf(turnsOf([said("Compacted", 0)]), 0)).toEqual({ kind: "bottom" });
    // A command before the last turn changes nothing.
    const before = turnsOf([ran("/model opus", 0), said("Set model to opus", 0), ...jwtTurn()]);
    expect(landingOf(before, 0)).toEqual({ kind: "conclusion", turn: before[1].key });
  });
});
