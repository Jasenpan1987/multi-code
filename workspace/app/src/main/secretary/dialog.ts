// The dialog a needs-you event is stopped on, as the secretary answers it in words
// (T-509, PRD Story 6), and the keys each answer takes. Pure: no electron, no pty.
//
// The model that reads the builder's reply never picks keys. It names an effect
// ("allow-always", "revise") or the option numbers it means, and `checkChoice` holds
// that to the dialog, sends a wider choice back as a confirmation to ask, and turns
// the rest into keys by the rules measured on the CLI. Every Claude sequence here was driven key by
// key on 2.1.295: docs/timeline/2026-10-10_reply-key-flows-spike.md. OpenCode answers
// only what the phone link already answers (one permission row, one single-select
// question), with the phone's verified keystrokes; anything else goes to the terminal.

import type { SecretaryEvent } from "../process-manager";
import type { BackendName } from "../../shared/types";
import {
  PERMISSION_TOOL,
  QUESTION_TOOL_LABEL,
  keystrokeForPermission,
  keystrokeForQuestion,
} from "../backends/opencodePrompt";

// What an option of a permission or plan dialog does. Two of them widen what the agent
// may do from now on, so they are pressed only when the builder clearly asks.
export type OptionEffect =
  | "allow-once"
  | "allow-always"
  | "deny"
  | "approve"
  | "approve-auto"
  | "revise";

export const ESCALATING: ReadonlySet<OptionEffect> = new Set(["allow-always", "approve-auto"]);

export interface EffectOption {
  effect: OptionEffect;
  label: string;
}

export interface DialogQuestion {
  question: string;
  header?: string;
  multiSelect: boolean;
  options: { label: string; description?: string }[];
}

export type Dialog =
  | {
      kind: "permission";
      backend: BackendName;
      toolName: string;
      toolInput: unknown;
      options: EffectOption[];
    }
  | { kind: "plan"; plan: string; options: EffectOption[] }
  | { kind: "questions"; backend: BackendName; questions: DialogQuestion[] };

// The model's decision, before checkChoice. Option numbers are 1-based, as the
// builder and the model see them.
export type Choice =
  | { effect: OptionEffect; feedback?: string; explicit?: boolean }
  | { answers: { question: number; picks: number[]; text?: string }[] };

// What gets written: keys one at a time, KEY_GAP_MS apart, then, once the dialog is
// gone, an ordinary prompt (a denial's reason). `expect` is what the CLI should record
// for a question box, by question text, to compare with its PostToolUse answers.
export interface AnswerPlan {
  keys: string[];
  followUp?: string;
  expect?: Record<string, string>;
}

// 150 ms between keys: a three-question box was answered right at 40 ms.
export const KEY_GAP_MS = 150;

const DOWN = "\x1b[B";
const ENTER = "\r";

// The plan box on 2.1.295. In auto mode the first reads "Yes, and use auto mode";
// the positions are the same.
const CLAUDE_PLAN_OPTIONS: EffectOption[] = [
  { effect: "approve-auto", label: "Yes, and auto-accept edits" },
  { effect: "approve", label: "Yes, manually approve edits" },
  { effect: "revise", label: "No, tell Claude what to change" },
];

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value : undefined;

// A question box's questions from its tool input, Claude's AskUserQuestion and
// OpenCode's `question` alike. Null when any question can't be shown as digits: at
// most eight options, so "Type something" is still a single digit.
function questionsOf(toolInput: unknown): DialogQuestion[] | null {
  const raw = asRecord(toolInput)?.questions;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const questions: DialogQuestion[] = [];
  for (const entry of raw) {
    const q = asRecord(entry);
    const question = str(q?.question) ?? str(q?.header);
    if (!q || !question) return null;
    const options: DialogQuestion["options"] = [];
    for (const o of Array.isArray(q.options) ? q.options : []) {
      const label = str(asRecord(o)?.label);
      if (!label) return null;
      options.push({ label, description: str(asRecord(o)?.description) });
    }
    if (options.length === 0 || options.length > 8) return null;
    questions.push({
      question,
      header: str(q.header),
      // OpenCode names it `multiple`.
      multiSelect: q.multiSelect === true || q.multiple === true,
      options,
    });
  }
  return questions;
}

// The dialog behind a needs-you event, or null when the secretary can't answer it in
// words: no decoded dialog (an MCP elicitation), or one whose keys aren't known.
export function dialogOf(event: SecretaryEvent, backend: BackendName): Dialog | null {
  const prompt = event.kind === "needs-you" ? event.prompt : undefined;
  if (!prompt) return null;
  const { detail, toolName, toolInput } = prompt;

  if (backend === "opencode") {
    if (detail.tool === PERMISSION_TOOL) {
      // Allow once / Allow always / Reject, always all three.
      const effects: OptionEffect[] = ["allow-once", "allow-always", "deny"];
      if (detail.options.length !== effects.length) return null;
      return {
        kind: "permission",
        backend,
        toolName,
        toolInput,
        options: detail.options.map((o, i) => ({ effect: effects[i], label: o.label })),
      };
    }
    if (detail.tool === QUESTION_TOOL_LABEL) {
      const questions = questionsOf(toolInput);
      return questions ? { kind: "questions", backend, questions } : null;
    }
    return null;
  }

  if (toolName === "AskUserQuestion") {
    const questions = questionsOf(toolInput);
    return questions ? { kind: "questions", backend, questions } : null;
  }
  if (toolName === "ExitPlanMode") {
    return {
      kind: "plan",
      plan: str(asRecord(toolInput)?.plan) ?? "",
      options: CLAUDE_PLAN_OPTIONS,
    };
  }
  // A permission: Yes / [don't ask again] / No, as permissionDetail decoded it for
  // this dialog (an `ask` rule's box has no middle option).
  const options = detail.options.map((o): EffectOption => {
    if (/don.t ask again/i.test(o.label)) return { effect: "allow-always", label: o.label };
    if (/^no\b/i.test(o.label)) return { effect: "deny", label: o.label };
    return { effect: "allow-once", label: o.label };
  });
  const effects = options.map((o) => o.effect);
  const shapeKnown =
    effects.join() === "allow-once,allow-always,deny" || effects.join() === "allow-once,deny";
  if (!shapeKnown) return null;
  return { kind: "permission", backend, toolName, toolInput, options };
}

// Widening a permission is never pressed on a reply alone: the secretary first
// asks a fixed question naming the wider choice, and presses only on a bare yes to
// it (`isPlainYes`). Guessing "always" from free text was tried, with keyword lists
// and negation checks; a review found a new reply that slipped through each one
// ("Don't ask me to auto-accept edits", "What does auto mode do?"). A bare yes to a
// question the secretary wrote itself can't be misread that way.
const PLAIN_YES =
  /^(?:是|是的|对|对的|确认|确定|没错|好|好的|行|可以|yes|yep|yeah|confirm|confirmed|correct|right|sure|ok|okay)$/i;

// A yes and nothing else, give or take punctuation. Anything more is read afresh:
// "是的，只允许这一次" and "Yes, ask before each edit" are corrections, and no list of
// words could tell every such correction from a yes.
export function isPlainYes(reply: string): boolean {
  return PLAIN_YES.test(reply.replace(/[\s。.!！~～,，]+/g, ""));
}

export type Checked =
  | { ok: true; plan: AnswerPlan }
  // Nothing pressed. `ask`: a question back for the builder; `refuse`: why this needs
  // the terminal.
  | { ok: false; ask: AskBack }
  | { ok: false; refuse: Refusal };

export type AskBack =
  | "once-or-always"
  | "approve-how"
  | "confirm-always"
  | "confirm-auto"
  | "what-to-change"
  | "unanswered";
export type Refusal = "unsupported" | "bad-choice";

// Hold the model's decision to the dialog and plan the keys. Anything out of range,
// or not in the dialog, is refused rather than guessed. A wider choice comes back as
// a confirmation to ask, unless `confirmed`: the builder said a plain yes to it.
export function checkChoice(dialog: Dialog, choice: Choice, confirmed = false): Checked {
  if (dialog.kind === "questions") {
    if (!("answers" in choice)) return { ok: false, refuse: "bad-choice" };
    return checkAnswers(dialog, choice.answers);
  }
  if (!("effect" in choice)) return { ok: false, refuse: "bad-choice" };
  const index = dialog.options.findIndex((o) => o.effect === choice.effect);
  if (index < 0) return { ok: false, refuse: "bad-choice" };
  if (ESCALATING.has(choice.effect) && !confirmed) {
    const plan = dialog.kind === "plan";
    if (choice.explicit !== true) return { ok: false, ask: plan ? "approve-how" : "once-or-always" };
    return { ok: false, ask: plan ? "confirm-auto" : "confirm-always" };
  }
  const feedback = cleanText(choice.feedback);

  if (dialog.kind === "plan") {
    if (choice.effect === "revise") {
      if (!feedback) return { ok: false, ask: "what-to-change" };
      return { ok: true, plan: { keys: [digit(index), feedback, ENTER] } };
    }
    return { ok: true, plan: { keys: [digit(index)] } };
  }

  if (dialog.backend === "opencode") {
    // A reason after Reject isn't something the OpenCode TUI was measured to take.
    if (feedback && choice.effect === "deny") return { ok: false, refuse: "unsupported" };
    const keys = keystrokeForPermission(index, dialog.options.length);
    return keys ? { ok: true, plan: { keys: [keys] } } : { ok: false, refuse: "bad-choice" };
  }
  if (choice.effect === "deny" && feedback) {
    return { ok: true, plan: { keys: [digit(index)], followUp: feedback } };
  }
  return { ok: true, plan: { keys: [digit(index)] } };
}

function checkAnswers(
  dialog: Extract<Dialog, { kind: "questions" }>,
  answers: { question: number; picks: number[]; text?: string }[]
): Checked {
  const { questions } = dialog;
  const byQuestion = new Map<number, { picks: number[]; text?: string }>();
  for (const a of answers) {
    if (!Number.isInteger(a.question) || a.question < 1 || a.question > questions.length) {
      return { ok: false, refuse: "bad-choice" };
    }
    if (byQuestion.has(a.question)) return { ok: false, refuse: "bad-choice" };
    byQuestion.set(a.question, { picks: a.picks, text: cleanText(a.text) });
  }
  if (byQuestion.size < questions.length) return { ok: false, ask: "unanswered" };

  const resolved: { picks: number[]; text?: string }[] = [];
  for (let q = 0; q < questions.length; q++) {
    const { picks, text } = byQuestion.get(q + 1)!;
    const count = questions[q].options.length;
    const unique = [...new Set(picks)].sort((a, b) => a - b);
    if (unique.length !== picks.length) return { ok: false, refuse: "bad-choice" };
    if (unique.some((p) => !Number.isInteger(p) || p < 1 || p > count)) {
      return { ok: false, refuse: "bad-choice" };
    }
    const chosen = unique.length + (text ? 1 : 0);
    if (chosen === 0) return { ok: false, ask: "unanswered" };
    if (!questions[q].multiSelect && chosen !== 1) return { ok: false, refuse: "bad-choice" };
    resolved.push({ picks: unique, text });
  }

  if (dialog.backend === "opencode") {
    // One single-select question and one of its own options: the phone's keystrokes.
    const [only] = resolved;
    if (questions.length !== 1 || questions[0].multiSelect || only.text) {
      return { ok: false, refuse: "unsupported" };
    }
    // The option list on screen ends with "Type your own answer".
    const keys = keystrokeForQuestion(only.picks[0] - 1, questions[0].options.length + 1);
    return keys ? { ok: true, plan: { keys: [keys] } } : { ok: false, refuse: "bad-choice" };
  }

  // A review page follows the last question when there are several, or when the one
  // question is multi-select; a single single-select question submits on its pick.
  const paged = questions.length > 1 || questions[0].multiSelect;
  const keys: string[] = [];
  const expect: Record<string, string> = {};
  questions.forEach((question, q) => {
    const { picks, text } = resolved[q];
    const count = question.options.length;
    if (!question.multiSelect) {
      if (text) keys.push(digit(count), text, ENTER);
      else keys.push(digit(picks[0] - 1));
    } else {
      // Digits tick boxes and leave the cursor on row 1. The "Type something" row is
      // option count rows down; the Next (or Submit) row one below it.
      for (const p of picks) keys.push(digit(p - 1));
      if (text) keys.push(...Array<string>(count).fill(DOWN), text, DOWN);
      else keys.push(...Array<string>(count + 1).fill(DOWN));
      keys.push(ENTER);
    }
    // As the CLI records it: the picks in option order, typed text last.
    const labels = picks.map((p) => question.options[p - 1].label);
    expect[question.question] = [...labels, ...(text ? [text] : [])].join(", ");
  });
  if (paged) keys.push("1");
  return { ok: true, plan: { keys, expect } };
}

// The digit that selects 0-based option `index`. Callers have bounded the index.
function digit(index: number): string {
  return String(index + 1);
}

// Typed into a field or sent as a prompt: one line, no control characters, so it can
// never submit early or move the cursor. Never shortened: a cut reason or answer would
// go in as if it were the whole of it.
export function cleanText(text: string | undefined): string | undefined {
  if (typeof text !== "string") return undefined;
  const clean = text
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return clean || undefined;
}

// Where the CLI's record of a question box differs from what was meant: the question
// texts whose recorded answer isn't the expected one. Empty when they match.
export function answerMismatches(
  expect: Record<string, string>,
  recordedInput: unknown
): string[] {
  const answers = asRecord(asRecord(recordedInput)?.answers);
  if (!answers) return Object.keys(expect);
  const norm = (s: unknown) => (typeof s === "string" ? s.replace(/\s+/g, " ").trim() : "");
  return Object.entries(expect)
    .filter(([question, want]) => norm(answers[question]) !== norm(want))
    .map(([question]) => question);
}
