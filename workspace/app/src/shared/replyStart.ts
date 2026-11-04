// Where a finished turn's conclusion starts, so the terminal can show it from its
// first line. The main process picks the conclusion out of the transcript
// (`replyConclusion`); the renderer finds it in the terminal's own lines
// (`replyNeedle`, `findReplyStart`).
//
// Claude Code's classic renderer (`"tui": "default"`) draws into the terminal's
// scrollback, which the renderer scrolls itself. OpenCode draws on the alternate
// screen and scrolls itself, so it is moved with its own commands, on keys
// Multi-Code binds in the terminals it starts (`OPENCODE_VIEW_KEYS`). Claude's
// fullscreen renderer has no such command and is left alone.

import type { TranscriptEntry } from "./remote-protocol";

/**
 * The OpenCode commands that show a conclusion from its first line, and the key
 * Multi-Code binds each to (backends/opencodePlugin.ts). `session.last` goes to the
 * bottom; `session.message.previous` from there puts the last message with text,
 * the conclusion, at the top (`findMessageBoundary` and `jumpToMessage` in
 * packages/tui/src/routes/session/, OpenCode 2.0.32).
 *
 * Cmd with Ctrl, Option and Shift: Cmd chords never reach Multi-Code's terminal, so
 * no keyboard can press these, and they can't take a key the builder uses. `bytes`
 * is how OpenTUI reads the stroke: CSI 23/24 is F11/F12, and modifier 16 is
 * 1 + shift 1 + meta 2 + ctrl 4 + super 8.
 */
export const OPENCODE_VIEW_KEYS = {
  "session.last": {
    stroke: { name: "f11", ctrl: true, shift: true, meta: true, super: true },
    bytes: "\x1b[23;16~",
  },
  "session.message.previous": {
    stroke: { name: "f12", ctrl: true, shift: true, meta: true, super: true },
    bytes: "\x1b[24;16~",
  },
} as const;

export type OpencodeViewCommand = keyof typeof OPENCODE_VIEW_KEYS;

/**
 * The conclusion of a turn: the first thing the agent said after its last tool
 * call, or its first words when it called none. Null when it said nothing.
 */
export function replyConclusion(turn: TranscriptEntry[]): string | null {
  let lastTool = -1;
  turn.forEach((entry, i) => {
    if (entry.kind === "tool") lastTool = i;
  });
  const after = turn.slice(lastTool + 1).find((entry) => entry.kind === "assistant");
  if (after) return after.text;
  // A turn that ended on a tool call: the last thing it said before.
  for (let i = turn.length - 1; i >= 0; i--) {
    if (turn[i].kind === "assistant") return turn[i].text;
  }
  return null;
}

// The CLI draws markdown: no `**`, backticks or `#`, a bullet before the first
// line, indents after it. Letters and digits are what the text and the screen
// still share, so both are compared on those alone.
function lettersAndDigits(text: string): string {
  return text.normalize("NFKC").replace(/[^\p{L}\p{N}]/gu, "").toLowerCase();
}

// Enough to tell the conclusion's first row from any other, short enough to fit in
// that row however narrow the terminal (16 CJK characters are 32 columns).
const NEEDLE_LENGTH = 16;
// Fewer letters than this is a fence, a table rule or a lone word, which could be
// anywhere on the screen.
const MIN_LINE_LETTERS = 4;
// How many rows below a candidate are read on when it is too narrow for the whole
// needle: the CLI breaks a long line into rows of its own.
const MAX_CONTINUATION_ROWS = 3;

/** What the conclusion's first row holds, as `findReplyStart` compares it. */
export function replyNeedle(conclusion: string): string | null {
  for (const raw of conclusion.split("\n")) {
    // A code fence's own line isn't drawn.
    if (raw.trimStart().startsWith("```")) continue;
    // A link is drawn as its text.
    const line = lettersAndDigits(raw.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1"));
    if (line.length >= MIN_LINE_LETTERS) return line.slice(0, NEEDLE_LENGTH);
  }
  return null;
}

/**
 * The last of `length` rows (the newest first) that starts with `needle`, or -1.
 * Newest first because the conclusion is the last thing on screen, and words it
 * repeats from earlier in the turn are higher up. A row too narrow for the whole
 * needle is read on into the rows below it.
 */
export function findReplyStart(
  rowAt: (i: number) => string | undefined,
  length: number,
  needle: string
): number {
  const rows = new Map<number, string>();
  const row = (i: number) => {
    let text = rows.get(i);
    if (text === undefined) {
      text = lettersAndDigits(rowAt(i) ?? "");
      rows.set(i, text);
    }
    return text;
  };
  for (let i = length - 1; i >= 0; i--) {
    let text = row(i);
    if (text.length < MIN_LINE_LETTERS) continue;
    for (let j = i + 1; text.length < needle.length && j < length; j++) {
      if (j > i + MAX_CONTINUATION_ROWS) break;
      text += row(j);
    }
    if (text.startsWith(needle)) return i;
  }
  return -1;
}

/** Whether the conclusion's first row is among `rows`, a screen's worth. */
export function replyOnScreen(rows: string[], needle: string): boolean {
  return findReplyStart((i) => rows[i], rows.length, needle) >= 0;
}

/**
 * Whether OpenCode's view is away from the bottom: it says "Jump to latest ↓" above
 * the composer then (packages/tui/src/routes/session/index.tsx, 2.0.32). A prompt
 * submitted takes it back down, so with this on screen at a turn's end, the builder
 * scrolled up during the turn.
 */
export function awayFromLatest(rows: string[]): boolean {
  return rows.some((row) => lettersAndDigits(row).includes("jumptolatest"));
}
