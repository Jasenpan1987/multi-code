// A long paste into the CLI's own input, or a long message from the compose box,
// written as typing instead (native input, 2026-11-11). Both CLIs fold only what
// arrives as a paste: Claude Code to `[Pasted text #N]`, OpenCode to
// `[Pasted ~N lines]`, and Claude marks the text behind the placeholder as pasted
// from elsewhere, to follow only where the typed message asks it to. Typed, the
// same text shows in full and is the builder's own.
//
// Measured on Claude Code 2.1.322 and OpenCode 2.2.2: five lines with LF between
// them show as five lines; 2,400 characters in writes of 200, 25 ms apart, show in
// full; 1,200 characters in one write are still taken for a paste. LF is Ctrl+J,
// which both CLIs read as a new line, never as a send.

import type { BackendName } from "../../shared/types";

// Each CLI's own test, read from its code (Claude Code 2.1.325, OpenCode 2.2.2,
// 2026-11-15). Claude folds more than 800 characters or more than three lines (in a
// terminal of 12 rows or more). OpenCode folds far sooner, three lines or more than
// 150 characters of the trimmed text: a spoken paragraph of 151 to 800 characters
// was left to fold to `[Pasted ~1 lines]` while this used Claude's numbers.

/** Whether this CLI would fold this text, pasted. A shorter paste stays a paste. */
export function wouldFold(text: string, backend: BackendName): boolean {
  if (backend === "opencode") {
    const trimmed = text.replace(/\r\n?/g, "\n").trim();
    return trimmed.length > 150 || trimmed.split("\n").length >= 3;
  }
  return text.length > 800 || text.split(/\r\n|\r|\n/).length > 3;
}

// Typed first into an empty input, these open something instead of being text:
// Claude's command menu, shell mode, shortcuts list and memory; OpenCode's command
// list and shell mode. Such a paste stays a paste.
const OPENS_SOMETHING = /^[/!?#]/;

/** Whether this text may be typed into the CLI's input; `inputHasText` when it isn't empty. */
export function mayType(text: string, inputHasText: boolean): boolean {
  return inputHasText || !OPENS_SOMETHING.test(text.trimStart());
}

/**
 * The text as keys to type: line breaks as LF (Ctrl+J, a new line in both CLIs,
 * never a send), a tab as four spaces (typed, a tab asks for a completion), every
 * other control character dropped (an Esc would leave the input). A last `@` token
 * gets a space after it, or the file completion it opens takes the next Enter.
 */
export function asTyping(text: string): string {
  const typed = text
    .replace(/\r\n|\r/g, "\n")
    .replace(/\t/g, "    ")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "");
  return /(^|\s)@\S+$/.test(typed) ? `${typed} ` : typed;
}

/**
 * The typed text in writes small enough not to be read as one paste. Split by
 * character, not by UTF-16 unit, so an emoji or a CJK character is never cut.
 */
export function typingChunks(typed: string, size = 150): string[] {
  const chars = Array.from(typed);
  const chunks: string[] = [];
  for (let i = 0; i < chars.length; i += size) chunks.push(chars.slice(i, i + size).join(""));
  return chunks;
}

// Between two writes: long enough that the CLI reads them apart.
export const TYPING_GAP_MS = 25;
