// Where the CLI's own input box is on its screen (compose-box v2, Stories 6 and 8).
//
// The compose box sends only while this finds the box: a question, a menu, a
// permission prompt or the trust dialog at start all take its place, and text with
// an Enter written into one of those can answer it. It also says which rows to
// cover, so the builder sees one input, not two.
//
// Read from the screen as the CLI draws it (Claude Code 2.1.322's classic renderer,
// OpenCode 2.2.2), one string per row, with dim text blanked by the caller so a
// placeholder doesn't count as typed. A CLI that changes its look makes this find
// nothing, and the box then sends nothing: it fails closed.

import type { BackendName } from "../../shared/types";

export interface PromptBox {
  // The first and last screen rows of the box, inclusive.
  top: number;
  bottom: number;
  // The CLI's own input holds text: the builder typed into the terminal.
  typed: boolean;
  // A line from inside the box worth showing in the compose box once the box is
  // covered: OpenCode's agent and model ("Build · GPT-6.1 Sol GitHub Copilot").
  status?: string;
}

// Claude draws its input between two rules, the first input row starting with ❯:
//
//   ──────────────
//   ❯ fix the login
//     redirect
//   ──────────────
//     ⏵⏵ auto mode on (shift+tab to cycle)
//
// A question's options also start with ❯ ("❯ 1. Red"), but never right under a rule
// and always with a number; the trust dialog's (" ❯ No, exit") is indented.
const CLAUDE_RULE = /^─{8,}\s*$/;
const CLAUDE_INPUT = /^❯(?:\s|$)/;
const CLAUDE_OPTION = /^❯\s*\d+\./;

function findClaudePrompt(rows: string[]): PromptBox | null {
  for (let top = rows.length - 1; top >= 0; top--) {
    if (!CLAUDE_RULE.test(rows[top])) continue;
    const first = rows[top + 1];
    if (first === undefined || !CLAUDE_INPUT.test(first) || CLAUDE_OPTION.test(first)) continue;
    // Its continuation rows are indented, up to the rule that closes it.
    let bottom = top + 2;
    while (bottom < rows.length && !CLAUDE_RULE.test(rows[bottom])) {
      if (!/^\s/.test(rows[bottom]) && rows[bottom] !== "") break;
      bottom++;
    }
    if (bottom >= rows.length || !CLAUDE_RULE.test(rows[bottom])) continue;
    const text = [first.replace(CLAUDE_INPUT, ""), ...rows.slice(top + 2, bottom)];
    return { top, bottom, typed: text.some((r) => r.trim() !== "") };
  }
  return null;
}

// OpenCode draws its input as rows with a bar on the left, closed by a half-block
// line; the last row inside names the agent and the model:
//
//     ┃
//     ┃  fix the login redirect
//     ┃
//     ┃  Build · GPT-6.1 Sol GitHub Copilot
//     ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀
//
// The builder's messages above have the same bar on the left, but no closing line.
const OPENCODE_SIDE = /^\s*┃/;
const OPENCODE_BOTTOM = /^\s*╹▀{8,}/;
// The empty input's hint, on the start screen: `Ask anything… "Fix broken tests"`.
const OPENCODE_PLACEHOLDER = /^Ask anything…/;

function findOpencodePrompt(rows: string[]): PromptBox | null {
  for (let bottom = rows.length - 1; bottom > 0; bottom--) {
    if (!OPENCODE_BOTTOM.test(rows[bottom])) continue;
    if (!OPENCODE_SIDE.test(rows[bottom - 1])) return null;
    let top = bottom - 1;
    while (top > 0 && OPENCODE_SIDE.test(rows[top - 1])) top--;
    const inside = rows.slice(top, bottom).map((r) => r.replace(OPENCODE_SIDE, "").trim());
    let agentAt = -1;
    for (let i = inside.length - 1; i >= 0; i--) {
      if (inside[i] !== "") {
        agentAt = inside[i].includes(" · ") ? i : -1;
        break;
      }
    }
    // No agent line: not the input box as this knows it.
    if (agentAt < 0) return null;
    const typed = inside
      .slice(0, agentAt)
      .some((r) => r !== "" && !OPENCODE_PLACEHOLDER.test(r));
    return { top, bottom, typed, status: inside[agentAt] };
  }
  return null;
}

/** The CLI's input box on `rows` (the screen, top to bottom), or null when it isn't there. */
export function findPromptBox(backend: BackendName, rows: string[]): PromptBox | null {
  return backend === "opencode" ? findOpencodePrompt(rows) : findClaudePrompt(rows);
}
