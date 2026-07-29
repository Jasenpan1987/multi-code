// Detects OpenCode's blocking dialogs by reading the terminal it paints, and
// maps a remote button tap back to the keystrokes its TUI expects.
//
// WHY TEXT MATCHING. OpenCode's two blocking dialogs are not equally readable:
//
//   - The `question` tool (a choice box) IS in the sqlite db, as a `part` row
//     with `state.status = "running"` and the full option list. That path lives
//     in opencode.ts and is stable structured data.
//   - Permission requests ("Allow once / Allow always / Reject") are NOT
//     persisted. The `permission` table only holds granted rules; a request
//     that is still waiting exists only in the running process's memory and on
//     its SSE stream. Reading the painted terminal is the only way to see it
//     without taking over how the process is launched.
//
// So this module is deliberately the fragile half, and it is scoped to exactly
// the dialog that has no better source. If an OpenCode release changes this
// wording, permission detection goes quiet (no false prompts — the markers
// simply stop matching) while `question` detection keeps working. Everything
// here was verified against opencode 1.18.91 by driving a real PTY.
//
// TWO FINDINGS THAT SHAPE THIS FILE, both measured rather than assumed:
//
//  1. The PTY never goes quiet while a permission dialog is up. A spinner keeps
//     repainting: over a 31s dialog the longest gap between writes was 295ms.
//     The Claude backend's "prompt = unpaired tool_use AND PTY idle 800ms" rule
//     therefore can never fire here, which is why this needs its own detector
//     instead of reusing that one.
//  2. Options are driven by ARROW KEYS, not digits. Right arrow moves one step
//     and wraps at the end; Tab does nothing; a digit does nothing. The `⇆` in
//     the dialog's "⇆ select" hint is an arrow glyph, not a Tab key. Sending
//     Claude's number keystrokes here would silently do nothing at all.

import type { PromptDetail } from "../remote/promptExtract";

// The heading OpenCode prints above a permission request, and the option row it
// prints below it. Both must be present: the heading alone also appears in
// scrollback for already-answered requests, while the option row is only on
// screen while the dialog is actually live.
const PERMISSION_HEADING = "Permission required";

// Option labels in the order the TUI lays them out left to right. The order is
// what makes an index meaningful, so it is asserted rather than discovered.
export const PERMISSION_LABELS = ["Allow once", "Allow always", "Reject"] as const;

// Tool names this module reports, used to pick the right keystrokes when an
// answer comes back from a phone. The dialogs take different keys, so this
// distinction is load-bearing rather than cosmetic.
export const PERMISSION_TOOL = "Permission";
export const QUESTION_TOOL_LABEL = "Question";
// A `question` with `multiple: true`. Reported under its own name so the answer
// path can refuse it rather than send single-select keystrokes — see
// keystrokeForQuestion for what goes wrong otherwise.
export const MULTI_QUESTION_TOOL_LABEL = "Question (multi-select)";

// Same shape as the Claude side's PromptDetail — the activity callback carries
// either — so it's imported rather than redeclared.
export type OpencodePromptDetail = PromptDetail;

const PERMISSION_DESCRIPTIONS: Record<string, string> = {
  "Allow once": "Permit this one action",
  "Allow always": "Permit this pattern for the rest of the session",
  Reject: "Refuse and let the agent choose another route",
};

// Strip the escape sequences that carry no glyphs, so marker matching runs
// against what a human would read on screen. Deliberately not a full terminal
// emulator: OpenCode repaints absolutely-positioned cells, so the result is
// jumbled in reading order but every visible substring is present, which is all
// the markers need.
export function visibleText(raw: string): string {
  /* eslint-disable no-control-regex -- matching terminal escape sequences is the
     entire job of this function; ESC and BEL are the delimiters being stripped. */
  return (
    raw
      // OSC sequences (window title, clipboard, capability probes)
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
      // DCS
      .replace(/\x1bP[^\x1b]*\x1b\\/g, "")
      // CSI (colors, cursor moves, mode toggles)
      .replace(/\x1b[[?][0-9;?]*[a-zA-Z$]/g, "")
      // Anything else two-byte
      .replace(/\x1b./g, "")
  );
  /* eslint-enable no-control-regex */
}

// True when the tail of the terminal shows a live permission dialog. Callers
// pass a recent window of output, not the whole session, so an answered dialog
// scrolls out of consideration.
export function hasPermissionDialog(text: string): boolean {
  if (!text.includes(PERMISSION_HEADING)) return false;
  // Require the full option row: that is the part that only exists while the
  // dialog is awaiting an answer.
  return PERMISSION_LABELS.every((label) => text.includes(label));
}

// Pull the one-line summary of what is being asked. OpenCode prints the subject
// on the line after the heading, e.g. "↵ Access external directory /tmp".
export function permissionSubject(text: string): string | undefined {
  const at = text.lastIndexOf(PERMISSION_HEADING);
  if (at < 0) return undefined;
  const after = text.slice(at + PERMISSION_HEADING.length);
  // The TUI draws box borders and padding between cells; collapse them and take
  // the first run of real words.
  const cleaned = after
    .replace(/[┃┏┓┗┛━┳┻┫┣╹╻▀▄█│─]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return undefined;
  // Cut at whichever section comes first after the subject line. OpenCode
  // follows the subject with a "Patterns" block listing the globs it would
  // grant, then the option row; neither belongs in a one-line summary.
  let stop = cleaned.length;
  for (const boundary of ["Patterns", PERMISSION_LABELS[0]]) {
    const at = cleaned.indexOf(boundary);
    if (at > 0 && at < stop) stop = at;
  }
  const subject = cleaned.slice(0, stop).trim();
  if (!subject) return undefined;
  // Leading arrow glyphs OpenCode uses to indent the subject.
  const withoutGlyph = subject.replace(/^[↵←→↳⤷»\-\s]+/, "").trim();
  return withoutGlyph.length > 0 ? withoutGlyph.slice(0, 200) : undefined;
}

export function buildPermissionDetail(text: string): OpencodePromptDetail {
  const subject = permissionSubject(text);
  return {
    tool: "Permission",
    question: subject ? `Permission required: ${subject}` : "Permission required",
    options: PERMISSION_LABELS.map((label) => ({
      label,
      description: PERMISSION_DESCRIPTIONS[label],
    })),
  };
}

// Keystrokes that move the highlight from its opening position to `index` and
// confirm.
//
// The dialog opens with the FIRST option highlighted, so the number of
// right-arrow presses equals the target index. Right arrow wraps, but we never
// rely on that because we only ever move forward from a known start.
//
// One caveat worth knowing, found by sampling a live dialog: for the first
// ~3 seconds after a dialog paints, the highlight-colored cell is still being
// animated and reads as a spinner glyph rather than an option label. The
// selection is only reliably on option 0 once that settles. Answering hinges on
// that starting position, so the caller must not fire keystrokes into a dialog
// it has only just noticed — see PROMPT_SETTLE_MS in opencode.ts.
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
  return "\x1b[C".repeat(index) + "\r";
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
