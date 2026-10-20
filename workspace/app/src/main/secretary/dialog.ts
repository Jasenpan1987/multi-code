// The dialog a needs-you event is stopped on, as the secretary answers it in words
// (T-509, PRD Story 6), and the keys each answer takes. Pure: no electron, no pty.
//
// The model that reads the builder's reply never picks keys. It names an effect
// ("allow-always", "revise") or the option numbers it means, and `checkChoice` holds
// that to the dialog, sends a wider choice back as a confirmation to ask, and turns
// the rest into keys by the rules measured on the CLI. Every Claude sequence here was driven key by
// key on 2.1.295: docs/timeline/2026-10-10_reply-key-flows-spike.md. OpenCode 2 takes
// no keys at all: its dialogs are answered through its API, by the request's id
// (opencode-v2 T-607; docs/timeline/2026-10-20_opencode-v2-source-reading.md,
// "Answering dialogs through the API"). So for OpenCode every shape a reply can
// decide is answerable: a reason goes with a Reject, and a question box takes
// several questions, multi-select and typed text in one answer.

import type { SecretaryEvent } from "../process-manager";
import type { BackendName } from "../../shared/types";
import type { DialogAnswer } from "../backends/types";
import {
  MULTI_QUESTION_TOOL_LABEL,
  PERMISSION_TOOL,
  QUESTION_TOOL_LABEL,
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

// `description` says what an option does when its label doesn't say it all; the
// reply interpreter sees it with the option.
export interface EffectOption {
  effect: OptionEffect;
  label: string;
  description?: string;
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
// `answer`, for a backend that answers through its API (OpenCode), replaces the keys:
// `keys` is then empty, there is no `followUp` (a reason travels in the answer) and no
// `expect` (OpenCode reports no record to compare), and the answer goes to the dialog
// the event's DialogRef names (opencode-v2 T-607).
export interface AnswerPlan {
  keys: string[];
  followUp?: string;
  expect?: Record<string, string>;
  answer?: DialogAnswer;
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

// OpenCode 2's permission labels (opencodePrompt.ts reports the TUI's own), and the
// effect of each. "Always allow" is offered only when the request has something to
// save, and saves it for the project with no expiry. Its label doesn't say how far it
// reaches, so its description does, for the reply interpreter to tell the builder.
const OPENCODE_PERMISSION = new Map<string, EffectOption>([
  ["Allow once", { effect: "allow-once", label: "Allow once" }],
  [
    "Always allow",
    {
      effect: "allow-always",
      label: "Always allow",
      description: "Allow it, and save that for this project: calls like it are allowed from now on",
    },
  ],
  ["Reject", { effect: "deny", label: "Reject" }],
]);

// What OpenCode's reply endpoint is told for each effect a permission can have.
const OPENCODE_DECISION: Partial<Record<OptionEffect, "once" | "always" | "reject">> = {
  "allow-once": "once",
  "allow-always": "always",
  deny: "reject",
};

// The two permission shapes known: with and without the wider option.
const PERMISSION_SHAPES: ReadonlySet<string> = new Set([
  "allow-once,allow-always,deny",
  "allow-once,deny",
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value : undefined;

// A question box's questions from its tool input, Claude's AskUserQuestion and
// OpenCode's `question` alike. Null when any question can't be shown as digits: at
// most eight options, so "Type something" is still a single digit. OpenCode takes no
// digits, and the cap holds for it too: a box of nine options goes to the terminal.
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
// words: no decoded dialog (an MCP elicitation), or one whose keys aren't known. For
// OpenCode, also null when the event names no request to answer (its DialogRef):
// without one the answer could only go in as keys, which OpenCode no longer takes.
export function dialogOf(event: SecretaryEvent, backend: BackendName): Dialog | null {
  const prompt = event.kind === "needs-you" ? event.prompt : undefined;
  if (!prompt) return null;
  const { detail, toolName, toolInput } = prompt;

  if (backend === "opencode") {
    const ref = prompt.dialog;
    if (!ref) return null;
    if (detail.tool === PERMISSION_TOOL) {
      if (ref.kind !== "permission") return null;
      // Allow once / Always allow / Reject, or the first and last alone.
      const options: EffectOption[] = [];
      for (const o of detail.options) {
        const known = OPENCODE_PERMISSION.get(o.label);
        if (!known) return null;
        options.push({ ...known });
      }
      if (!PERMISSION_SHAPES.has(options.map((o) => o.effect).join())) return null;
      return { kind: "permission", backend, toolName, toolInput, options };
    }
    // One question, several, or multi-select: the answer carries them all.
    if (detail.tool === QUESTION_TOOL_LABEL || detail.tool === MULTI_QUESTION_TOOL_LABEL) {
      if (ref.kind !== "form") return null;
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
  if (!PERMISSION_SHAPES.has(options.map((o) => o.effect).join())) return null;
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

// Hold the model's decision to the dialog and plan the keys, or OpenCode's answer.
// Anything out of range, or not in the dialog, is refused rather than guessed. A wider
// choice comes back as a confirmation to ask, unless `confirmed`: the builder said a
// plain yes to it.
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
    const decision = OPENCODE_DECISION[choice.effect];
    if (!decision) return { ok: false, refuse: "bad-choice" };
    // A Reject's reason goes with it: OpenCode hands it to the agent, which carries on
    // from it, so there is nothing to send after.
    const message = choice.effect === "deny" ? feedback : undefined;
    const answer: DialogAnswer = { kind: "permission", decision, ...(message ? { message } : {}) };
    return { ok: true, plan: { keys: [], answer } };
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
    // Field `q<index>` per question, in the box's order. A single-select question
    // takes the option's label or the typed text; a multi-select one the picked labels
    // in option order, typed text last, as Claude records it.
    const answer: Record<string, string | string[]> = {};
    questions.forEach((question, q) => {
      const { picks, text } = resolved[q];
      const labels = picks.map((p) => question.options[p - 1].label);
      answer[`q${q}`] = question.multiSelect
        ? [...labels, ...(text ? [text] : [])]
        : text ?? labels[0];
    });
    return { ok: true, plan: { keys: [], answer: { kind: "form", answer } } };
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
