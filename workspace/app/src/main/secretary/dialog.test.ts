// The keys each answer takes are the sequences that answered right on CLI 2.1.295,
// docs/timeline/2026-10-10_reply-key-flows-spike.md; each case below names the run.

import { describe, expect, it, vi } from "vitest";

// Types only; keep electron and node-pty out of the import graph.
vi.mock("../process-manager", () => ({}));

import type { SecretaryEvent } from "../process-manager";
import { answerMismatches, checkChoice, cleanText, dialogOf, isPlainYes } from "./dialog";
import type { Dialog } from "./dialog";
import { extractPromptDetail } from "../remote/promptExtract";
import type { PromptDetail } from "../remote/promptExtract";
import type { DialogRef } from "../backends/types";

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

// OpenCode 2 is answered through its API (opencode-v2 T-607): the shapes below are
// the ones opencodePrompt.ts reports for it (T-604), the answers what the service's
// reply endpoints take (docs/timeline/2026-10-20_opencode-v2-source-reading.md).
describe("OpenCode", () => {
  const PERMISSION_REF: DialogRef = { kind: "permission", sessionId: "ses_1", requestId: "per_1" };
  const FORM_REF: DialogRef = { kind: "form", sessionId: "ses_1", requestId: "frm_1" };
  const SHELL = { resources: ["rm -rf build"], metadata: { command: "rm -rf build" }, save: ["rm *"] };

  function opencodeEvent(
    toolName: string,
    toolInput: unknown,
    detail: PromptDetail,
    dialog: DialogRef | null
  ): SecretaryEvent {
    return {
      kind: "needs-you",
      seq: 7,
      at: 1,
      prompt: { detail, toolName, toolInput, ...(dialog ? { dialog } : {}) },
    };
  }

  const permissionDetail = (labels: string[]): PromptDetail => ({
    tool: "Permission",
    question: "Permission required: shell: rm -rf build",
    options: labels.map((label) => ({ label })),
  });
  const opencodePermission = (labels: string[], ref: DialogRef | null = PERMISSION_REF) =>
    dialogOf(opencodeEvent("shell", SHELL, permissionDetail(labels), ref), "opencode");

  // As T-604 reports a question form: one single-select question under "Question",
  // anything else under "Question (multi-select)"; no "Type your own answer" row.
  const questionBox = (questions: ReturnType<typeof q>[], ref: DialogRef | null = FORM_REF) => {
    const toolInput = {
      questions: questions.map(({ multiSelect, ...rest }) => ({ ...rest, multiple: multiSelect })),
    };
    const oneTap = questions.length === 1 && !questions[0].multiSelect;
    const detail: PromptDetail = {
      tool: oneTap ? "Question" : "Question (multi-select)",
      question: questions[0].question,
      options: questions[0].options,
    };
    return dialogOf(opencodeEvent("question", toolInput, detail, ref), "opencode");
  };

  const three = opencodePermission(["Allow once", "Always allow", "Reject"])!;
  const two = opencodePermission(["Allow once", "Reject"])!;

  describe("dialogOf", () => {
    it("reads a three-option permission, saying how far Always allow reaches", () => {
      expect(three).toMatchObject({
        kind: "permission",
        backend: "opencode",
        toolName: "shell",
        toolInput: SHELL,
        options: [
          { effect: "allow-once", label: "Allow once" },
          {
            effect: "allow-always",
            label: "Always allow",
            description: expect.stringContaining("save that for this project"),
          },
          { effect: "deny", label: "Reject" },
        ],
      });
    });

    it("reads a permission with nothing to save as Allow once / Reject", () => {
      expect(two).toMatchObject({
        options: [{ effect: "allow-once" }, { effect: "deny" }],
      });
    });

    it("refuses a permission of any other shape", () => {
      // OpenCode 1.x's label, an unknown one, an order it doesn't use, a lone option.
      expect(opencodePermission(["Allow once", "Allow always", "Reject"])).toBeNull();
      expect(opencodePermission(["Allow once", "Ask later", "Reject"])).toBeNull();
      expect(opencodePermission(["Reject", "Allow once"])).toBeNull();
      expect(opencodePermission(["Allow once"])).toBeNull();
    });

    it("reads a single question, a multi-select one and a box of two", () => {
      expect(questionBox([q("Which db?", ["Postgres", "SQLite"])])).toMatchObject({
        kind: "questions",
        backend: "opencode",
        questions: [{ question: "Which db?", multiSelect: false }],
      });
      expect(questionBox([q("Which extras?", ["Cache", "Queue"], true)])).toMatchObject({
        questions: [{ multiSelect: true }],
      });
      expect(
        questionBox([q("Which db?", ["Postgres", "SQLite"]), q("Which extras?", ["Cache", "Queue"], true)])
      ).toMatchObject({
        questions: [{ question: "Which db?" }, { question: "Which extras?", multiSelect: true }],
      });
    });

    it("answers nothing the event names no request for, or names a request of the other kind", () => {
      expect(opencodePermission(["Allow once", "Reject"], null)).toBeNull();
      expect(opencodePermission(["Allow once", "Reject"], FORM_REF)).toBeNull();
      expect(questionBox([q("Which db?", ["Postgres", "SQLite"])], null)).toBeNull();
      expect(questionBox([q("Which db?", ["Postgres", "SQLite"])], PERMISSION_REF)).toBeNull();
      // A form that isn't the question tool's (an MCP elicitation) has no detail to read.
      const elicitation: PromptDetail = { tool: "Input needed", options: [] };
      expect(dialogOf(opencodeEvent("form", {}, elicitation, FORM_REF), "opencode")).toBeNull();
    });
  });

  describe("a permission", () => {
    it("answers allow once and reject through the API, with no keys", () => {
      expect(keysOf(three, { effect: "allow-once" })).toEqual({
        keys: [],
        answer: { kind: "permission", decision: "once" },
      });
      expect(keysOf(two, { effect: "deny" })).toEqual({
        keys: [],
        answer: { kind: "permission", decision: "reject" },
      });
    });

    it("sends a reject's reason with it, cleaned, and nothing after", () => {
      expect(keysOf(three, { effect: "deny", feedback: "Use ls -la\ninstead" })).toEqual({
        keys: [],
        answer: { kind: "permission", decision: "reject", message: "Use ls -la instead" },
      });
    });

    it("answers always only after the builder's plain yes to the confirmation", () => {
      expect(checkChoice(three, { effect: "allow-always", explicit: true })).toEqual({
        ok: false,
        ask: "confirm-always",
      });
      expect(checkChoice(three, { effect: "allow-always" })).toEqual({ ok: false, ask: "once-or-always" });
      expect(keysOf(three, { effect: "allow-always", explicit: true }, true)).toEqual({
        keys: [],
        answer: { kind: "permission", decision: "always" },
      });
    });

    it("refuses always where OpenCode offers none, and an effect a permission doesn't have", () => {
      expect(checkChoice(two, { effect: "allow-always", explicit: true }, true)).toEqual({
        ok: false,
        refuse: "bad-choice",
      });
      expect(checkChoice(three, { effect: "approve" })).toEqual({ ok: false, refuse: "bad-choice" });
    });
  });

  describe("a question box", () => {
    it("one single-select question: the option's label as q0", () => {
      const box = questionBox([q("Which db?", ["Postgres", "SQLite"])])!;
      expect(keysOf(box, { answers: [{ question: 1, picks: [2] }] })).toEqual({
        keys: [],
        answer: { kind: "form", answer: { q0: "SQLite" } },
      });
    });

    it("typed text instead of an option goes in as it is, cleaned", () => {
      const box = questionBox([q("Which db?", ["Postgres", "SQLite"])])!;
      expect(keysOf(box, { answers: [{ question: 1, picks: [], text: " MySQL,\n8.0 " }] })).toEqual({
        keys: [],
        answer: { kind: "form", answer: { q0: "MySQL, 8.0" } },
      });
    });

    it("multi-select: the picked labels in option order, typed text last", () => {
      const box = questionBox([q("Which extras?", ["Cache", "Queue", "Search"], true)])!;
      expect(keysOf(box, { answers: [{ question: 1, picks: [3, 1], text: "Metrics" }] })).toEqual({
        keys: [],
        answer: { kind: "form", answer: { q0: ["Cache", "Search", "Metrics"] } },
      });
    });

    it("two questions: one field each, in the box's order, however the reply ordered them", () => {
      const box = questionBox([
        q("Which db?", ["Postgres", "SQLite"]),
        q("Which extras?", ["Cache", "Queue"], true),
      ])!;
      const planned = keysOf(box, {
        answers: [
          { question: 2, picks: [2] },
          { question: 1, picks: [1] },
        ],
      });
      expect(planned).toEqual({
        keys: [],
        answer: { kind: "form", answer: { q0: "Postgres", q1: ["Queue"] } },
      });
    });

    it("holds the answers to the box as for Claude", () => {
      const box = questionBox([
        q("Which db?", ["Postgres", "SQLite"]),
        q("Which extras?", ["Cache", "Queue"], true),
      ])!;
      expect(checkChoice(box, { answers: [{ question: 1, picks: [1] }] })).toEqual({
        ok: false,
        ask: "unanswered",
      });
      expect(
        checkChoice(box, {
          answers: [
            { question: 1, picks: [1, 2] },
            { question: 2, picks: [1] },
          ],
        })
      ).toEqual({ ok: false, refuse: "bad-choice" });
      expect(checkChoice(box, { effect: "allow-once" })).toEqual({ ok: false, refuse: "bad-choice" });
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
