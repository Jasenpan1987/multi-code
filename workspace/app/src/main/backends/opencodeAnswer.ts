// How a choice made on a paired phone becomes an answer to an OpenCode dialog through
// its API, instead of keystrokes (opencode-v2 T-607, PRD Story 5).
//
// The phone sends the index of the button it tapped, and its buttons are the
// PromptDetail's options. An answer names its request by id, so it can't land in
// another dialog the way a keystroke can; what has to be right here is which option
// the index means. A permission's options follow what OpenCode offered for that
// request (no "Always allow" when the request has nothing to save), so the decision
// comes from the tapped option's label, never from its position. Facts:
// docs/timeline/2026-10-20_opencode-v2-source-reading.md, "Answering dialogs through
// the API".

import type { DialogAnswer, DialogRef } from "./types";
import type { PromptDetail } from "../remote/promptExtract";
import { PERMISSION_TOOL, QUESTION_TOOL_LABEL } from "./opencodePrompt";

// The TUI's own labels, as opencodePrompt.ts reports them.
const DECISIONS = new Map<string, "once" | "always" | "reject">([
  ["Allow once", "once"],
  ["Always allow", "always"],
  ["Reject", "reject"],
]);

// The answer for option `index` of the dialog `detail` describes, or null when the
// index is out of range or the dialog can't be answered with one tap (multi-select,
// several questions). Null too for a label it doesn't know, and for a ref of the
// other kind: answering a guess would grant or refuse the wrong thing.
export function answerForChoice(
  detail: PromptDetail,
  ref: DialogRef,
  index: number
): DialogAnswer | null {
  if (!Number.isInteger(index) || index < 0 || index >= detail.options.length) return null;
  const { label } = detail.options[index];

  if (detail.tool === PERMISSION_TOOL) {
    if (ref.kind !== "permission") return null;
    const decision = DECISIONS.get(label);
    return decision ? { kind: "permission", decision } : null;
  }
  // One single-select question, field `q0`; its options are the question's own, with
  // no free-text row. Several questions or a multi-select one come under
  // MULTI_QUESTION_TOOL_LABEL, which one tap can't answer.
  if (detail.tool === QUESTION_TOOL_LABEL) {
    if (ref.kind !== "form") return null;
    return { kind: "form", answer: { q0: label } };
  }
  return null;
}
