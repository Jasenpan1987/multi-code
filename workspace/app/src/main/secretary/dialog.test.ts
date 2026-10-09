// The keys each answer takes are the sequences that answered right on CLI 2.1.295,
// docs/timeline/2026-10-10_reply-key-flows-spike.md; each case below names the run.

import { describe, expect, it, vi } from "vitest";

// Types only; keep electron and node-pty out of the import graph.
vi.mock("../process-manager", () => ({}));

import type { SecretaryEvent } from "../process-manager";
import { answerMismatches, checkChoice, cleanText, dialogOf, isPlainYes } from "./dialog";
import type { Dialog } from "./dialog";
import { extractPromptDetail } from "../remote/promptExtract";
import { permissionDetail as opencodePermissionDetail, questionDetail } from "../backends/opencodePrompt";

const DOWN = "\x1b[B";

function needsYou(toolName: string, toolInput: unknown, detail = extractPromptDetail(toolName, toolInput)!): SecretaryEvent {
  return { kind: "needs-you", seq: 7, at: 1, prompt: { detail, toolName, toolInput } };
}

function claudeDialog(toolName: string, toolInput: unknown, detail?: ReturnType<typeof extractPromptDetail>) {
  const dialog = dialogOf(needsYou(toolName, toolInput, detail ?? undefined), "claude");
  if (!dialog) throw new Error("no dialog");
  return dialog;
}

const BASH = { command: "curl -sI https://example.com | head -1" };
const permission = claudeDialog("Bash", BASH);
// An `ask` rule's box: Yes / No only (permissionDetail drops the middle option).
const askRule = claudeDialog("Bash", BASH, {
  tool: "Bash",
  options: [{ label: "Yes" }, { label: "No" }],
});
const plan = claudeDialog("ExitPlanMode", { plan: "# Plan\nCreate hi.txt" });

const q = (question: string, labels: string[], multiSelect = false) => ({
  question,
  header: question.split(" ")[1],
  multiSelect,
  options: labels.map((label) => ({ label, description: `${label} option` })),
});

function keysOf(dialog: Dialog, choice: Parameters<typeof checkChoice>[1], confirmed = false) {
  const checked = checkChoice(dialog, choice, confirmed);
  if (!checked.ok) throw new Error(JSON.stringify(checked));
  return checked.plan;
}

describe("dialogOf", () => {
  it("reads a permission's options as effects", () => {
    expect(permission).toMatchObject({
      kind: "permission",
      toolName: "Bash",
      options: [{ effect: "allow-once" }, { effect: "allow-always" }, { effect: "deny" }],
    });
    expect(askRule).toMatchObject({ options: [{ effect: "allow-once" }, { effect: "deny" }] });
  });

  it("reads every question of a question box, not only the first", () => {
    const dialog = claudeDialog("AskUserQuestion", {
      questions: [q("Which framework?", ["React", "Vue"]), q("Which features?", ["Login", "Search"], true)],
    });
    expect(dialog).toMatchObject({
      kind: "questions",
      questions: [
        { question: "Which framework?", multiSelect: false },
        { question: "Which features?", multiSelect: true },
      ],
    });
  });

  it("has nothing to answer for a finish, an elicitation, or a box digits can't reach", () => {
    expect(dialogOf({ kind: "finished", seq: 1, at: 1 }, "claude")).toBeNull();
    expect(dialogOf({ kind: "needs-you", seq: 1, at: 1 }, "claude")).toBeNull();
    const nine = Array.from({ length: 9 }, (_, i) => `O${i}`);
    expect(dialogOf(needsYou("AskUserQuestion", { questions: [q("Which?", nine)] }), "claude")).toBeNull();
  });

  it("answers OpenCode's permission row and its single-select question, nothing else", () => {
    const perm = opencodePermissionDetail({ permission: "bash", patterns: ["rm -rf build"] });
    expect(dialogOf(needsYou("bash", { patterns: ["rm -rf build"] }, perm), "opencode")).toMatchObject({
      kind: "permission",
      options: [{ effect: "allow-once" }, { effect: "allow-always" }, { effect: "deny" }],
    });
    const single = { questions: [q("Which db?", ["Postgres", "SQLite"])] };
    expect(dialogOf(needsYou("question", single, questionDetail(single)!), "opencode")).toMatchObject({
      kind: "questions",
    });
    const multi = { questions: [{ ...q("Which?", ["A", "B"]), multiple: true }] };
    expect(dialogOf(needsYou("question", multi, questionDetail(multi)!), "opencode")).toBeNull();
  });
});

describe("a permission", () => {
  it("allows once with 1 and denies with 3", () => {
    expect(keysOf(permission, { effect: "allow-once" }).keys).toEqual(["1"]);
    expect(keysOf(permission, { effect: "deny" }).keys).toEqual(["3"]);
    expect(keysOf(askRule, { effect: "deny" }).keys).toEqual(["2"]);
  });

  it("denies, then says why as an ordinary prompt once the dialog is gone", () => {
    const planned = keysOf(permission, { effect: "deny", feedback: "Use wget\ninstead" });
    expect(planned).toEqual({ keys: ["3"], followUp: "Use wget instead" });
  });

  it("never presses don't-ask-again on a reply alone: it asks to confirm first", () => {
    expect(checkChoice(permission, { effect: "allow-always", explicit: true })).toEqual({
      ok: false,
      ask: "confirm-always",
    });
    // Without the model saying the builder asked for it, the question is which one.
    expect(checkChoice(permission, { effect: "allow-always" })).toEqual({
      ok: false,
      ask: "once-or-always",
    });
    expect(keysOf(permission, { effect: "allow-always", explicit: true }, true).keys).toEqual(["2"]);
  });

  it("refuses an option the dialog doesn't have", () => {
    expect(checkChoice(askRule, { effect: "allow-always", explicit: true }, true)).toEqual({
      ok: false,
      refuse: "bad-choice",
    });
    expect(checkChoice(permission, { effect: "approve" })).toEqual({
      ok: false,
      refuse: "bad-choice",
    });
  });
});

describe("a plan", () => {
  it("approves with manual edits, and auto-accept only once confirmed", () => {
    expect(keysOf(plan, { effect: "approve" }).keys).toEqual(["2"]);
    expect(checkChoice(plan, { effect: "approve-auto", explicit: true })).toEqual({
      ok: false,
      ask: "confirm-auto",
    });
    expect(checkChoice(plan, { effect: "approve-auto" })).toEqual({ ok: false, ask: "approve-how" });
    expect(keysOf(plan, { effect: "approve-auto", explicit: true }, true).keys).toEqual(["1"]);
  });

  it("sends a change back with 3, the text, and Enter", () => {
    expect(keysOf(plan, { effect: "revise", feedback: "Name the file hi.txt instead" }).keys).toEqual([
      "3",
      "Name the file hi.txt instead",
      "\r",
    ]);
    expect(checkChoice(plan, { effect: "revise" })).toEqual({ ok: false, ask: "what-to-change" });
  });
});

describe("a question box", () => {
  const color = claudeDialog("AskUserQuestion", { questions: [q("Which color?", ["Red", "Blue"])] });

  it("one single-select question: the option's digit, with no review page", () => {
    expect(keysOf(color, { answers: [{ question: 1, picks: [2] }] })).toEqual({
      keys: ["2"],
      expect: { "Which color?": "Blue" },
    });
  });

  it("typed text: Type something's digit, the text, Enter (run: Green, like grass)", () => {
    expect(keysOf(color, { answers: [{ question: 1, picks: [], text: "Green, like grass" }] })).toEqual({
      keys: ["3", "Green, like grass", "\r"],
      expect: { "Which color?": "Green, like grass" },
    });
  });

  it("three questions with a multi-select and typed text in two (run: 150 and 40 ms)", () => {
    const box = claudeDialog("AskUserQuestion", {
      questions: [
        q("Which framework?", ["React", "Vue"]),
        q("Which features?", ["Login", "Search", "Payments"], true),
        q("Which host?", ["AWS", "Fly"]),
      ],
    });
    const planned = keysOf(box, {
      answers: [
        { question: 1, picks: [2] },
        { question: 2, picks: [3, 2], text: "GraphQL" },
        { question: 3, picks: [], text: "Render" },
      ],
    });
    expect(planned.keys).toEqual(
      ["2", "2", "3", DOWN, DOWN, DOWN, "GraphQL", DOWN, "\r", "3", "Render", "\r", "1"]
    );
    expect(planned.expect).toEqual({
      "Which framework?": "Vue",
      "Which features?": "Search, Payments, GraphQL",
      "Which host?": "Render",
    });
  });

  it("one multi-select question: ticks, down to Submit, Enter, then Submit answers (run: toppings)", () => {
    const box = claudeDialog("AskUserQuestion", {
      questions: [q("Which toppings?", ["Cheese", "Ham", "Olives"], true)],
    });
    expect(keysOf(box, { answers: [{ question: 1, picks: [1, 3] }] }).keys).toEqual(
      ["1", "3", DOWN, DOWN, DOWN, DOWN, "\r", "1"]
    );
  });

  it("multi-select first with typed text, then a single-select (run: pets)", () => {
    const box = claudeDialog("AskUserQuestion", {
      questions: [q("Which pets?", ["Cat", "Dog", "Fish"], true), q("Which city?", ["Paris", "Rome"])],
    });
    const planned = keysOf(box, {
      answers: [
        { question: 1, picks: [1], text: "Hamster" },
        { question: 2, picks: [2] },
      ],
    });
    expect(planned.keys).toEqual(["1", DOWN, DOWN, DOWN, "Hamster", DOWN, "\r", "2", "1"]);
    expect(planned.expect).toEqual({ "Which pets?": "Cat, Hamster", "Which city?": "Rome" });
  });

  it("asks for the questions not yet answered, and refuses what the box can't take", () => {
    const box = claudeDialog("AskUserQuestion", {
      questions: [q("Which db?", ["Postgres", "SQLite"]), q("Which extras?", ["Cache", "Queue"], true)],
    });
    expect(checkChoice(box, { answers: [{ question: 1, picks: [1] }] })).toEqual({
      ok: false,
      ask: "unanswered",
    });
    const bad = (answers: { question: number; picks: number[]; text?: string }[]) =>
      checkChoice(box, { answers });
    const second = { question: 2, picks: [1] };
    expect(bad([{ question: 1, picks: [1, 2] }, second])).toEqual({ ok: false, refuse: "bad-choice" });
    expect(bad([{ question: 1, picks: [3] }, second])).toEqual({ ok: false, refuse: "bad-choice" });
    expect(bad([{ question: 1, picks: [1] }, { question: 1, picks: [2] }])).toEqual({
      ok: false,
      refuse: "bad-choice",
    });
    expect(bad([{ question: 1, picks: [1], text: "MySQL" }, second])).toEqual({
      ok: false,
      refuse: "bad-choice",
    });
    expect(checkChoice(box, { effect: "allow-once" })).toEqual({ ok: false, refuse: "bad-choice" });
  });
});

describe("OpenCode", () => {
  const perm = dialogOf(
    needsYou("bash", {}, opencodePermissionDetail({ permission: "bash", patterns: ["ls"] })),
    "opencode"
  )!;
  const single = { questions: [q("Which db?", ["Postgres", "SQLite"])] };
  const question = dialogOf(needsYou("question", single, questionDetail(single)!), "opencode")!;

  it("uses the phone's verified keystrokes", () => {
    expect(keysOf(perm, { effect: "allow-once" }).keys).toEqual(["\r"]);
    expect(keysOf(perm, { effect: "deny" }).keys).toEqual(["\x1b[C\x1b[C\r"]);
    expect(keysOf(question, { answers: [{ question: 1, picks: [2] }] }).keys).toEqual([`${DOWN}\r`]);
  });

  it("sends to the terminal what the TUI wasn't measured to take", () => {
    expect(checkChoice(perm, { effect: "deny", feedback: "use ls -la" })).toEqual({
      ok: false,
      refuse: "unsupported",
    });
    expect(checkChoice(question, { answers: [{ question: 1, picks: [], text: "MySQL" }] })).toEqual({
      ok: false,
      refuse: "unsupported",
    });
  });
});

describe("cleanText", () => {
  it("keeps one line with no control characters, so text can't submit early", () => {
    expect(cleanText("a\r\nb\tc\x1b[Bd")).toBe("a b c [Bd");
    expect(cleanText("   ")).toBeUndefined();
    expect(cleanText(undefined)).toBeUndefined();
  });

  it("never shortens: a cut reason would go in as the whole of it", () => {
    const long = `${"keep the tests green. ".repeat(100)}Do not delete production data.`;
    expect(cleanText(long)).toBe(long.trim());
  });
});

describe("answerMismatches", () => {
  const want = { "Which framework?": "Vue", "Which features?": "Login, Payments" };

  it("is empty when the CLI recorded what was meant", () => {
    const recorded = { answers: { "Which framework?": "Vue", "Which features?": "Login,  Payments" } };
    expect(answerMismatches(want, recorded)).toEqual([]);
  });

  it("names each question recorded differently, or every one when there is no record", () => {
    const recorded = { answers: { "Which framework?": "React", "Which features?": "Login, Payments" } };
    expect(answerMismatches(want, recorded)).toEqual(["Which framework?"]);
    expect(answerMismatches(want, {})).toEqual(Object.keys(want));
  });
});

describe("isPlainYes", () => {
  it("takes a bare yes, give or take punctuation", () => {
    for (const reply of ["是", "是的。", " 对！", "确认", "可以", "yes", "Yes.", "ok", "OK!"]) {
      expect(isPlainYes(reply), reply).toBe(true);
    }
  });

  it("takes nothing more than that: a correction after a yes is read afresh", () => {
    for (const reply of [
      "是的，以后都可以",
      "yes, go ahead",
      "Yes, only this once.",
      "Yes, ask before each edit.",
      "是的，只允许这一次。",
      "可以，逐个确认。",
      "不是",
      "对吗？",
      "嗯",
      "What does auto mode do?",
      "yesterday",
    ]) {
      expect(isPlainYes(reply), reply).toBe(false);
    }
  });
});
