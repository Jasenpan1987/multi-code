// How a choice made on a paired phone becomes an answer to an OpenCode dialog through
// its API, instead of keystrokes.
//
// Contract stub (opencode-v2 T-602); T-607 implements it.

import type { DialogAnswer, DialogRef } from "./types";
import type { PromptDetail } from "../remote/promptExtract";

// The answer for option `index` of the dialog `detail` describes, or null when the
// index is out of range or the dialog can't be answered with one tap (multi-select,
// several questions).
export function answerForChoice(
  _detail: PromptDetail,
  _ref: DialogRef,
  _index: number
): DialogAnswer | null {
  throw new Error("opencodeAnswer: not implemented (T-607)");
}
