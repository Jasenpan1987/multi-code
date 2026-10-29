// A session's transcript as the chat draws it (PRD Story 3, mockups 2.1–2.3): turns,
// each folding its tool calls into one line, and where the screen lands when it
// opens. Pure, so every rule is tested on its own (turns.test.ts).
//
// A turn starts at each "user" entry. Within one:
//   lead       — what the agent said before its first tool call, shown as text
//   fold       — the first tool call to the last, with what it said between them:
//                one line ("12 tools · 6 read · 3 edited · 2 commands") until tapped
//   conclusion — what it said after its last tool call, always shown
// While the turn runs, everything after the lead is in the fold (more calls may
// come), which is open and grows. While the session is stopped on a dialog, the
// pending calls at the end are the dialog's, and the dialog's own card shows them.
//
// A CLI command the builder ran and the CLI's own output for it (`local` entries:
// "/token", "Unknown command: /token") are no message to or from the model, and start
// no turn (as the desktop counts turns, backends/recentTurns.ts). Each command, with
// the output after it, is a line drawn after the turn it came in (`Turn.lines`),
// never part of its fold, its counts or its conclusion; one that came in the middle
// of a running turn leaves the turn whole.

import type { TranscriptEntry } from "../shared/remote-protocol";

// One command line: the command, then what the CLI said to it (either may be missing).
export interface CommandLine {
  key: string;
  entries: TranscriptEntry[];
}

export interface Turn {
  // Stable across refreshes: the id of the turn's first entry.
  key: string;
  // Null for entries before the first message: the preamble, or the part of the
  // oldest turn the Mac didn't send.
  user: TranscriptEntry | null;
  lead: TranscriptEntry[];
  fold: TranscriptEntry[];
  // The fold's open state is kept under this (its first entry's id).
  foldKey: string;
  conclusion: TranscriptEntry[];
  // The commands run in the turn, in order, drawn after it.
  lines: CommandLine[];
  // The turn's last entry is a command line: nothing the agent said came after it.
  endsInCommand: boolean;
  // The session is in this turn now.
  live: boolean;
  // The session is stopped on a dialog in this turn.
  waiting: boolean;
  // `at` of the turn's first and last entries (commands aside), for its duration.
  startAt?: number;
  endAt?: number;
}

export function groupTurns(
  entries: readonly TranscriptEntry[],
  session: { working: boolean; waiting: boolean }
): Turn[] {
  const groups: TranscriptEntry[][] = [];
  for (const entry of entries) {
    if ((entry.kind === "user" && !entry.local) || groups.length === 0) groups.push([entry]);
    else groups[groups.length - 1].push(entry);
  }
  const keys = new Map<string, number>();
  const unique = (key: string) => {
    const seen = keys.get(key) ?? 0;
    keys.set(key, seen + 1);
    return seen ? `${key}#${seen + 1}` : key;
  };
  return groups.map((group, i) => {
    const last = i === groups.length - 1;
    return turnOf(group, unique, last && session.working, last && session.waiting);
  });
}

// An entry's identity: its id, or, for a record that has none (the contract makes
// it optional), what it is and when, which stays the same when earlier turns are
// loaded above it, as a position wouldn't.
const keyOf = (entry: TranscriptEntry) => entry.id ?? `${entry.kind}@${entry.at ?? ""}:${entry.text.slice(0, 40)}`;

function turnOf(group: TranscriptEntry[], unique: (key: string) => string, live: boolean, waiting: boolean): Turn {
  const key = unique(keyOf(group[0]));
  const user = group[0].kind === "user" && !group[0].local ? group[0] : null;
  // Command lines: a command starts one, output joins the one just before it.
  const lines: CommandLine[] = [];
  group.forEach((entry, i) => {
    if (!entry.local) return;
    if (entry.kind === "user" || !group[i - 1]?.local || lines.length === 0) {
      lines.push({ key: unique(keyOf(entry)), entries: [entry] });
    } else {
      lines[lines.length - 1].entries.push(entry);
    }
  });
  const own = group.filter((e) => !e.local);
  let body = user ? own.slice(1) : own;
  if (waiting) {
    let end = body.length;
    while (end > 0 && body[end - 1].kind === "tool" && body[end - 1].pending) end--;
    body = body.slice(0, end);
  }
  const first = body.findIndex((e) => e.kind === "tool");
  const last = body.findLastIndex((e) => e.kind === "tool");
  const turn = {
    key,
    user,
    foldKey: `${key}-fold`,
    lines,
    endsInCommand: Boolean(group[group.length - 1].local),
    live,
    waiting,
    startAt: (own[0] ?? group[0]).at,
    endAt: (own[own.length - 1] ?? group[group.length - 1]).at,
  };
  if (first < 0) {
    // No tool calls: all it said is the conclusion, or, while it runs, the lead.
    return { ...turn, lead: live ? body : [], fold: [], conclusion: live ? [] : body };
  }
  const fold = live ? body.slice(first) : body.slice(first, last + 1);
  return {
    ...turn,
    lead: body.slice(0, first),
    fold,
    foldKey: fold[0].id ?? turn.foldKey,
    conclusion: live ? [] : body.slice(last + 1),
  };
}

// A command line's two halves: what the builder ran and what the CLI said, as one
// line of text each (terminal colours dropped, should the record carry them).
export function commandLine(line: CommandLine): { command: string | null; output: string } {
  const [first, ...rest] = line.entries;
  const command = first?.kind === "user" ? plain(first.text) : null;
  const output = (command === null ? line.entries : rest)
    .map((e) => plain(e.text))
    .filter(Boolean)
    .join("\n");
  return { command, output };
}

// eslint-disable-next-line no-control-regex
const plain = (text: string) => text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").trim();

// ---------------------------------------------------------------------------
// The fold line
// ---------------------------------------------------------------------------

// Tool names as both backends write them (Claude's capitalised, OpenCode's lower
// case), compared in lower case. An OpenCode `!command` arrives as `shell`.
const READS = new Set(["read", "grep", "glob", "ls", "list", "notebookread"]);
const EDITS = new Set(["edit", "write", "multiedit", "notebookedit", "patch", "apply_patch"]);
const COMMANDS = new Set(["bash", "shell"]);

export interface FoldCounts {
  tools: number;
  // Files and patterns read or searched, and files edited or written, each counted
  // once however often (mockup 2.1: four edits of three files are "3 edited").
  read: number;
  edited: number;
  // Commands run, each run counted.
  commands: number;
}

export function foldCounts(fold: readonly TranscriptEntry[]): FoldCounts {
  const read = new Set<string>();
  const edited = new Set<string>();
  let tools = 0;
  let commands = 0;
  fold.forEach((entry, i) => {
    if (entry.kind !== "tool") return;
    tools++;
    const name = (entry.tool ?? "").toLowerCase();
    // A call without a target is one of its own.
    const target = entry.text || `#${i}`;
    if (READS.has(name)) read.add(target);
    else if (EDITS.has(name)) edited.add(target);
    else if (COMMANDS.has(name)) commands++;
  });
  return { tools, read: read.size, edited: edited.size, commands };
}

// "12 tools · 6 read · 3 edited · 2 commands", or "5 tools · running" while the
// turn runs. Counts of nothing are left out.
export function foldLabel(fold: readonly TranscriptEntry[], live: boolean): string {
  const c = foldCounts(fold);
  const parts = [`${c.tools} ${c.tools === 1 ? "tool" : "tools"}`];
  if (live) return [...parts, "running"].join(" · ");
  if (c.read) parts.push(`${c.read} read`);
  if (c.edited) parts.push(`${c.edited} edited`);
  if (c.commands) parts.push(`${c.commands} ${c.commands === 1 ? "command" : "commands"}`);
  return parts.join(" · ");
}

// ---------------------------------------------------------------------------
// One tool line
// ---------------------------------------------------------------------------

// What the line's right end says (mockup 2.2): running, failed (the record carries
// no count of failures), lines added and removed, or done.
export type ToolMark =
  | { kind: "running" }
  // Pending outside the running turn: a call whose end the record never wrote.
  | { kind: "stalled" }
  | { kind: "failed" }
  | { kind: "lines"; added: number; removed: number }
  | { kind: "done" }
  // Not pending, and the record doesn't say how it ended.
  | { kind: "unknown" };

export function toolMark(entry: TranscriptEntry, live: boolean): ToolMark {
  if (entry.pending) return live ? { kind: "running" } : { kind: "stalled" };
  if (entry.outcome === "error") return { kind: "failed" };
  const added = entry.added ?? 0;
  const removed = entry.removed ?? 0;
  // Some writes carry no counts; they are just done.
  if (added || removed) return { kind: "lines", added, removed };
  return entry.outcome === "ok" ? { kind: "done" } : { kind: "unknown" };
}

// The line's action: "Read", "Bash", the same for OpenCode's lower-case names; an
// MCP tool by its own name, without the server prefix.
export function toolVerb(tool: string | undefined): string {
  if (!tool) return "Tool";
  const name = tool.startsWith("mcp__") ? tool.split("__").pop() || tool : tool;
  return name.charAt(0).toUpperCase() + name.slice(1);
}

// The tool the turn is on now: its last pending call.
export function runningTool(turn: Turn | undefined): TranscriptEntry | undefined {
  return turn?.live ? turn.fold.findLast((e) => e.kind === "tool" && e.pending) : undefined;
}

// ---------------------------------------------------------------------------
// Where the screen lands
// ---------------------------------------------------------------------------

// Opening a session whose last turn finished lands on the start of that turn's
// conclusion, as the desktop's terminal does when a turn ends; anything else (a
// turn running, a dialog, a message or a command of the builder's after it, no
// conclusion) lands at the bottom. `trailing`: the builder's messages shown after the last turn
// that the transcript doesn't have yet.
export type Landing = { kind: "conclusion"; turn: string } | { kind: "bottom" };

export function landingOf(turns: readonly Turn[], trailing: number): Landing {
  const last = turns[turns.length - 1];
  if (!last || trailing > 0 || last.endsInCommand || last.live || last.waiting || last.conclusion.length === 0) {
    return { kind: "bottom" };
  }
  return { kind: "conclusion", turn: last.key };
}
