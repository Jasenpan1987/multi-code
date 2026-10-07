// What a paired phone is shown for an OpenCode dialog, and the keystrokes that
// answer it from there.
//
// The dialog itself comes from Multi-Code's plugin: `permission.asked` and
// `question.asked` carry what is being asked (backends/opencodeAttention.ts). This
// used to be read off the painted terminal, because a pending permission is never
// persisted; the plugin made that unnecessary.
//
// Options are driven by ARROW KEYS, not digits, measured on a live TUI: a permission
// is a horizontal row (Right moves one step and wraps; Tab and digits do nothing), a
// single-select question a vertical list. Sending Claude's number keystrokes here
// would silently do nothing at all. Measured again on 1.18.35 (T-411): each mapping
// below answered its dialog when sent 0.36s after the dialog's event, so there is no
// need to wait for the dialog to settle.

import type { PromptDetail } from "../remote/promptExtract";

// Option labels in the order the TUI lays them out left to right. The order is
// what makes an index meaningful, so it is asserted rather than discovered.
export const PERMISSION_LABELS = ["Allow once", "Allow always", "Reject"] as const;

// Tool names this module reports, used to pick the right keystrokes when an
// answer comes back from a phone. The dialogs take different keys, so this
// distinction is load-bearing rather than cosmetic.
export const PERMISSION_TOOL = "Permission";
export const QUESTION_TOOL_LABEL = "Question";
// A question box one tap can't answer: `multiple: true`, or several questions in one
// box. Reported under its own name so the answer path refuses it rather than send
// single-select keystrokes (see keystrokeForQuestion), and the phone shows it
// read-only.
export const MULTI_QUESTION_TOOL_LABEL = "Question (multi-select)";

// Same shape as the Claude side's PromptDetail — the activity callback carries
// either — so it's imported rather than redeclared.
export type OpencodePromptDetail = PromptDetail;

const PERMISSION_DESCRIPTIONS: Record<string, string> = {
  "Allow once": "Permit this one action",
  "Allow always": "Permit this pattern until OpenCode restarts",
  Reject: "Refuse and let the agent choose another route",
};

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

// A `permission.asked` event's properties: `{permission: "bash", patterns:
// ["touch a.txt"], always: ["touch *"], metadata, …}` (fixtures in
// __fixtures__/opencode-plugin/). Every dialog offers the same three options.
export function permissionDetail(properties: Record<string, unknown>): OpencodePromptDetail {
  const patterns = Array.isArray(properties.patterns)
    ? properties.patterns.filter((p): p is string => typeof p === "string" && p.length > 0)
    : [];
  const subject = [str(properties.permission), patterns.join(", ")].filter(Boolean).join(": ");
  return {
    tool: PERMISSION_TOOL,
    question: subject ? `Permission required: ${subject}`.slice(0, 240) : "Permission required",
    options: PERMISSION_LABELS.map((label) => ({
      label,
      description: PERMISSION_DESCRIPTIONS[label],
    })),
  };
}

// A `question.asked` event's properties: `{questions: [{question, header, options:
// [{label, description}], multiple?}]}`, the same shape as Claude's AskUserQuestion
// input. Null when there is nothing to offer; the phone then shows the terminal.
export function questionDetail(properties: Record<string, unknown>): OpencodePromptDetail | null {
  const questions = properties.questions;
  if (!Array.isArray(questions) || questions.length === 0) return null;
  const first = questions[0] as Record<string, unknown> | null;
  if (typeof first !== "object" || first === null) return null;

  const options: { label: string; description?: string }[] = [];
  for (const entry of Array.isArray(first.options) ? first.options : []) {
    const option = entry as Record<string, unknown> | null;
    const label = str(option?.label);
    if (label) options.push({ label, description: str(option?.description) });
  }
  if (options.length === 0) return null;

  // OpenCode appends its own free-text escape hatch to the on-screen list, so
  // the phone must offer it too — otherwise the indices the phone sends would
  // line up against a shorter list than the one being navigated.
  options.push({ label: "Type your own answer", description: "Send a custom reply" });

  // A multi-select box is toggle-then-confirm, and a box with several questions
  // takes an Enter per question and one more to submit (T-409, `question-multi`).
  // Neither is one tap.
  const oneTap = first.multiple !== true && questions.length === 1;
  return {
    tool: oneTap ? QUESTION_TOOL_LABEL : MULTI_QUESTION_TOOL_LABEL,
    question: str(first.question) ?? str(first.header),
    options,
  };
}

// Keystrokes that move the highlight from its opening position to `index` and
// confirm.
//
// The dialog opens with the FIRST option highlighted, so the number of
// right-arrow presses equals the target index. Right arrow wraps, but we never
// rely on that because we only ever move forward from a known start.
//
// "Allow always" opens a second screen ("This will allow the following patterns
// until OpenCode is restarted … Confirm / Cancel"), so it takes a second
// Enter. Sent in the same write, measured to land on that screen (T-411).
//
// Returns null when the index is out of range, so the caller can decline rather
// than confirm whatever happens to be highlighted — picking the wrong option
// here would grant or refuse the wrong thing.
export function keystrokeForPermission(
  index: number,
  optionCount: number
): string | null {
  if (!Number.isInteger(index)) return null;
  if (index < 0 || index >= optionCount) return null;
  const confirm = PERMISSION_LABELS[index] === "Allow always" ? "\r" : "";
  return "\x1b[C".repeat(index) + "\r" + confirm;
}

// The single-select `question` box is a DIFFERENT widget from the permission row,
// with different keys, so it gets its own function rather than sharing the one
// above.
//
// Permission is a horizontal row hinting "⇆ select"; a single-select question is
// a vertical list hinting "↑↓ select  enter submit". Verified against a real
// dialog: the vertical list marks its selection with a foreground color (blue
// fg 75) rather than a background highlight, and opens on the first option.
// Sending left/right here would do nothing at all.
//
// NOT for multi-select. A `question` with `multiple: true` looks similar but
// behaves differently, verified by driving one: options render as checkboxes
// (`1. [ ] Apple`), the hint changes to "enter toggle", and submitting is a
// second stage — Tab moves to a Confirm step which then takes Enter. Sending
// these keystrokes there would tick a checkbox and leave the agent blocked while
// the phone believed it had answered, which is worse than declining. Multi-select
// is reported as its own tool so it routes to null instead.
export function keystrokeForQuestion(
  index: number,
  optionCount: number
): string | null {
  if (!Number.isInteger(index)) return null;
  if (index < 0 || index >= optionCount) return null;
  return "\x1b[B".repeat(index) + "\r";
}
