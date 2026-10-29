// The phone dev harness's sessions as they change: a working turn adds a tool
// every few seconds, an answer or a prompt starts the next step, Esc stops a turn.
// Pure: no server, no electron; bridge.ts turns it into frames. What each session
// starts as is scenarios.ts.

import type {
  RemoteChoice,
  RemoteDialog,
  RemoteInstance,
  RemoteSessionState,
  TranscriptEntry,
} from "../../src/shared/remote-protocol";
import { buildScenario, COST, TERMINAL_COLS, TERMINAL_ROWS, type ScenarioName } from "./scenarios.ts";

// One tool call: what the transcript shows while it runs, and how it ends.
export interface Step {
  tool: string;
  text: string;
  outcome?: "ok" | "error";
  added?: number;
  removed?: number;
  // What the agent says just before making the call.
  say?: string;
}

// A dialog the session is stopped on, and what the agent does once it's answered.
export interface OpenDialog {
  seq: number;
  summary: string;
  // Absent for a dialog the phone can't show (an MCP form).
  dialog?: RemoteDialog;
  // The call the dialog is about; its entry stays pending while the dialog is open.
  asking: Step;
  after: Step[];
  conclusion: string;
  // A plan sent back with "revise" comes back as this one, revised.
  revised?: (feedback: string) => Omit<OpenDialog, "seq">;
}

export interface Session {
  info: Pick<RemoteInstance, "id" | "name" | "cwd" | "backend" | "status">;
  // Starts every entry id: new with each reset, so a phone never carries state
  // kept for an entry of one scenario over to a different one with the same number.
  idPrefix: string;
  // The CLI session the entries are from (TranscriptFrame.session): a new one with
  // each `/new` or `/clear`, and with each reset.
  cli: string;
  state: RemoteSessionState;
  since: number;
  // The list row's line as the mockup has it, until the state first changes.
  preview?: string;
  entries: TranscriptEntry[];
  dialog?: OpenDialog;
  // A working turn: the call running now (its entry is the pending one), the calls
  // still to come, and how the turn ends.
  running?: Step;
  steps: Step[];
  end?: { conclusion: string } | { reopen: Omit<OpenDialog, "seq"> };
  // Prompts sent while working; the CLI takes them when the turn ends.
  queued: string[];
  cols: number;
  rows: number;
  // What has been typed into the terminal's input box since the last Return.
  typed: string;
}

export const TICK_MS = 4000;
// How long after a new session's first, empty transcript Claude's record of the
// `/clear` that made it shows (as the desktop sees it, 2026-10-30).
const CLEAR_LINE_MS = 100;

export class World {
  scenario: ScenarioName = "home";
  live = true;
  private sessions: Session[] = [];
  // Never repeats, as the contract asks of the desktop's: seeded from the clock.
  private seq = Date.now();
  private resets = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  // Told which sessions changed; `reset` when the whole world was replaced.
  onChange: (ids: string[], reset: boolean) => void = () => {};

  constructor(scenario: ScenarioName = "home", live = true) {
    this.reset(scenario, live);
  }

  reset(scenario: ScenarioName, live = this.live) {
    this.scenario = scenario;
    const run = `r${++this.resets}`;
    this.sessions = buildScenario(scenario, Date.now()).map(({ dialog, entries, ...rest }) => ({
      ...rest,
      idPrefix: `${run}-${rest.info.id}`,
      cli: `${run}-${rest.info.id}-cli1`,
      entries: entries.map((e) => ({ ...e, id: `${run}-${e.id}` })),
      dialog: dialog && { ...dialog, seq: ++this.seq },
    }));
    this.setLive(live);
    this.onChange(
      this.sessions.map((s) => s.info.id),
      true
    );
  }

  setLive(live: boolean) {
    this.live = live;
    if (this.timer) clearInterval(this.timer);
    this.timer = live ? setInterval(() => this.tick(), TICK_MS) : null;
    this.timer?.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // One step of every working turn.
  tick() {
    const changed = this.sessions.filter((s) => s.state === "working");
    for (const s of changed) this.advance(s);
    if (changed.length > 0) this.onChange(changed.map((s) => s.info.id), false);
  }

  list(): RemoteInstance[] {
    return this.sessions.map((s) => ({
      ...s.info,
      state: s.state,
      since: s.since,
      preview: s.preview ?? previewOf(s),
    }));
  }

  has(id: string): boolean {
    return this.sessions.some((s) => s.info.id === id);
  }

  stateOf(id: string): { state: RemoteSessionState; running: boolean; backend: string } | null {
    const s = this.find(id);
    return s ? { state: s.state, running: s.info.status === "running", backend: s.info.backend } : null;
  }

  dialogOf(id: string): Pick<OpenDialog, "seq" | "summary" | "dialog"> | undefined {
    const d = this.find(id)?.dialog;
    return d && { seq: d.seq, summary: d.summary, dialog: d.dialog };
  }

  // The last `turns` turns, and the CLI session they are from. As the desktop's
  // (backends/recentTurns.ts): a turn starts at each message, not at a command, and
  // the `/clear` a new session opens with comes with its first turn.
  transcript(id: string, turns: number): { entries: TranscriptEntry[]; hasEarlier: boolean; session?: string } {
    const s = this.find(id);
    const entries = s?.entries ?? [];
    const starts = entries.flatMap((e, i) => (e.kind === "user" && !e.local ? [i] : []));
    let from = starts.length > turns ? starts[starts.length - turns] : 0;
    if (entries.slice(0, from).every((e) => e.local)) from = 0;
    return { entries: entries.slice(from), hasEarlier: from > 0, ...(s ? { session: s.cli } : {}) };
  }

  terminal(id: string): { data: string; cols: number; rows: number } {
    const s = this.find(id);
    if (!s) return { data: "", cols: TERMINAL_COLS, rows: TERMINAL_ROWS };
    // A stopped session has no PTY, so nothing to replay.
    return { data: s.info.status === "running" ? paint(s) : "", cols: s.cols, rows: s.rows };
  }

  // The terminal's full repaint, streamed as output after every change.
  repaint(id: string): string | null {
    const s = this.find(id);
    return s && s.info.status === "running" ? paint(s) : null;
  }

  // A phone opened a Finished session: it's been seen.
  markSeen(id: string) {
    const s = this.find(id);
    if (s?.state !== "finished") return;
    this.setState(s, "idle");
    this.onChange([id], false);
  }

  // A message from the compose box (or Return in the terminal). Callers have
  // checked that the session is running and not on a dialog.
  prompt(id: string, text: string) {
    const s = this.find(id);
    if (!s) return;
    if (s.state === "working") s.queued.push(text);
    else this.take(s, text);
    this.onChange([id], false);
  }

  // The builder started a new CLI session at the desk (`/new`).
  newSession(id: string): boolean {
    const s = this.find(id);
    if (!s) return false;
    this.renew(s);
    this.onChange([id], false);
    return true;
  }

  // The builder ran a CLI command at the desk: its line, and the CLI's output.
  command(id: string, command: string, output?: string): boolean {
    const s = this.find(id);
    if (!s) return false;
    this.local(s, command, output);
    this.onChange([id], false);
    return true;
  }

  // An answer the desktop has accepted (bridge.ts holds it to the dialog first).
  answer(id: string, choice: RemoteChoice) {
    const s = this.find(id);
    const d = s?.dialog;
    if (!s || !d) return;
    s.dialog = undefined;
    const asking = pendingEntry(s);

    if ("answers" in choice) {
      complete(asking, { outcome: "ok" });
      const questions = d.dialog?.kind === "questions" ? d.dialog.questions : [];
      const lines = choice.answers.map(({ question, picks, text }) => {
        const q = questions[question - 1];
        const labels = picks.map((p) => q?.options[p - 1]?.label ?? `#${p}`);
        return `- **${q?.header ?? `Question ${question}`}**: ${[...labels, ...(text ? [text] : [])].join(", ")}`;
      });
      this.work(s, d.after, { conclusion: `Got your answers:\n\n${lines.join("\n")}\n\n${d.conclusion}` });
    } else if (choice.effect === "allow-once" || choice.effect === "allow-always") {
      // The call runs now, and ends on the next tick.
      s.running = d.asking;
      this.work(s, d.after, { conclusion: d.conclusion }, false);
    } else if (choice.effect === "approve" || choice.effect === "approve-auto") {
      complete(asking, { outcome: "ok" });
      this.work(s, d.after, { conclusion: d.conclusion });
    } else if (choice.effect === "revise" && d.revised) {
      complete(asking, { outcome: "error" });
      this.work(s, [], { reopen: d.revised(choice.feedback ?? "") }, false);
    } else {
      // A denial. With a reason the agent carries on from it; without one it stops.
      complete(asking, { outcome: "error" });
      if (choice.feedback) this.startPromptTurn(s, choice.feedback);
      else this.setState(s, "idle");
    }
    this.onChange([id], false);
  }

  // The builder answered at the desk: the highlighted option, as Return picks it.
  deskAnswer(id: string): boolean {
    const d = this.find(id)?.dialog;
    if (!d) return false;
    if (!d.dialog) {
      // An MCP form, filled in at the terminal.
      this.answer(id, { effect: "allow-once" });
    } else if (d.dialog.kind === "questions") {
      this.answer(id, {
        answers: d.dialog.questions.map((_, i) => ({ question: i + 1, picks: [1] })),
      });
    } else {
      this.answer(id, { effect: d.dialog.options[0].effect });
    }
    return true;
  }

  // Esc during a turn. Callers have checked that the session is working.
  interrupt(id: string) {
    const s = this.find(id);
    if (!s) return;
    complete(pendingEntry(s), { outcome: "error" });
    s.running = undefined;
    s.steps = [];
    s.end = undefined;
    this.setState(s, "idle");
    this.takeQueued(s);
    this.onChange([id], false);
  }

  // Keystrokes from the terminal fallback, read the way the CLI's input box would:
  // printable text is typed, Backspace deletes, Return sends what was typed (or
  // picks the highlighted option of a dialog), Esc stops a turn or declines a dialog.
  input(id: string, data: string) {
    const s = this.find(id);
    if (!s || s.info.status !== "running") return;
    if (data === "\r") {
      const text = s.typed.trim();
      s.typed = "";
      if (s.state === "needs-you") {
        if (!text) this.deskAnswer(id);
      } else if (text) {
        this.prompt(id, text);
      }
    } else if (data === "\x1b") {
      if (s.state === "working") this.interrupt(id);
      else if (s.dialog) this.answer(id, { effect: "deny" });
    } else if (data === "\x7f") {
      s.typed = s.typed.slice(0, -1);
      // eslint-disable-next-line no-control-regex
    } else if (!/[\x00-\x1f\x7f]/.test(data)) {
      s.typed += data;
    }
    this.onChange([id], false);
  }

  resize(id: string, cols: number, rows: number): boolean {
    const s = this.find(id);
    if (!s) return false;
    s.cols = cols;
    s.rows = rows;
    this.onChange([id], false);
    return true;
  }

  private find(id: string): Session | undefined {
    return this.sessions.find((s) => s.info.id === id);
  }

  private setState(s: Session, state: RemoteSessionState) {
    s.state = state;
    s.since = Date.now();
    s.preview = undefined;
  }

  // What the CLI does with a line the builder sent: a slash command runs at once,
  // with no turn (as Claude's built-in ones do); anything else starts a turn.
  private take(s: Session, text: string) {
    const [name, ...args] = text.trim().split(/\s+/);
    if (!name.startsWith("/") || name.length < 2) return this.startPromptTurn(s, text);
    const command = name.slice(1);
    if (command === "new" || command === "clear") return this.renew(s);
    this.local(s, text.trim(), COMMANDS[command]?.(args.join(" ")) ?? `Unknown command: /${command}`);
  }

  // A new CLI session, as Claude makes one for `/new` or `/clear`: its transcript is
  // empty at first, then shows the command that made it, recorded as `/clear`.
  private renew(s: Session) {
    this.startSession(s);
    const cli = s.cli;
    const line = setTimeout(() => {
      if (s.cli !== cli || !this.sessions.includes(s)) return;
      this.local(s, "/clear");
      this.onChange([s.info.id], false);
    }, CLEAR_LINE_MS);
    line.unref?.();
  }

  private startSession(s: Session) {
    const at = s.cli.lastIndexOf("-cli");
    s.cli = `${s.cli.slice(0, at)}-cli${Number(s.cli.slice(at + 4)) + 1}`;
    // The new session's entries are numbered from 1 again, under its own name.
    s.idPrefix = s.cli;
    s.entries = [];
    // A dialog of the old session's closes with it (the bridge says so).
    s.dialog = undefined;
    s.running = undefined;
    s.steps = [];
    s.end = undefined;
    s.queued = [];
    if (s.state !== "idle") this.setState(s, "idle");
    s.preview = undefined;
  }

  private local(s: Session, command: string, output?: string) {
    s.entries.push(entry(s, { kind: "user", text: command, local: true }));
    if (output) s.entries.push(entry(s, { kind: "assistant", text: output, local: true }));
  }

  private startPromptTurn(s: Session, text: string) {
    s.entries.push(entry(s, { kind: "user", text }));
    const claude = s.info.backend === "claude";
    const word = text.split(/\s+/)[0]?.slice(0, 24) || text.slice(0, 8);
    this.work(
      s,
      [
        { say: "Looking into it.", tool: claude ? "Read" : "read", text: "README.md" },
        { tool: claude ? "Grep" : "grep", text: word },
      ],
      {
        conclusion: `Done: this is the harness's scripted reply to “${text}”. No agent ran; two tools were played back and the turn ended.`,
      }
    );
  }

  // Into Working with these calls to make. `advanceNow`: start the first one at
  // once, rather than leave a call that is already running to the next tick.
  private work(s: Session, steps: Step[], end: Session["end"], advanceNow = true) {
    s.steps = [...steps];
    s.end = end;
    this.setState(s, "working");
    if (advanceNow) this.advance(s);
  }

  private advance(s: Session) {
    if (s.running) {
      complete(pendingEntry(s), s.running);
      s.running = undefined;
    }
    const step = s.steps.shift();
    if (step) {
      if (step.say) s.entries.push(entry(s, { kind: "assistant", text: step.say }));
      s.entries.push(entry(s, { kind: "tool", tool: step.tool, text: step.text, pending: true }));
      s.running = step;
      return;
    }
    const end = s.end;
    s.end = undefined;
    if (end && "reopen" in end) {
      const { asking, ...rest } = end.reopen;
      if (asking.say) s.entries.push(entry(s, { kind: "assistant", text: asking.say }));
      s.entries.push(entry(s, { kind: "tool", tool: asking.tool, text: asking.text, pending: true }));
      s.dialog = { ...rest, asking, seq: ++this.seq };
      this.setState(s, "needs-you");
      return;
    }
    if (end) s.entries.push(entry(s, { kind: "assistant", text: end.conclusion }));
    this.setState(s, "finished");
    this.takeQueued(s);
  }

  // A turn ended, however it ended: the CLI takes what was queued during it, oldest
  // first. A slash command runs with no turn, so the next is taken at once, until a
  // prompt starts a turn.
  private takeQueued(s: Session) {
    while (s.state !== "working" && s.queued.length > 0) this.take(s, s.queued.shift()!);
  }
}

// What the harness's CLI says to a few of Claude's built-in commands.
const COMMANDS: Record<string, (args: string) => string> = {
  model: (args) => `Set model to ${args || "Opus 5.5 (default)"}`,
  cost: () => COST,
  compact: () => "Compacted. ctrl+o to see the summary",
};

// ---------------------------------------------------------------------------
// Transcript helpers
// ---------------------------------------------------------------------------

function entry(s: Session, fields: Omit<TranscriptEntry, "id" | "at">): TranscriptEntry {
  return { id: `${s.idPrefix}-${s.entries.length + 1}`, at: Date.now(), ...fields };
}

function pendingEntry(s: Session): TranscriptEntry | undefined {
  return s.entries.findLast((e) => e.kind === "tool" && e.pending);
}

function complete(e: TranscriptEntry | undefined, step: Pick<Step, "outcome" | "added" | "removed">) {
  if (!e) return;
  e.pending = undefined;
  e.outcome = step.outcome ?? "ok";
  if (step.added !== undefined) e.added = step.added;
  if (step.removed !== undefined) e.removed = step.removed;
}

// The list row's line, as protocol v3 describes it (RemoteInstance.preview).
function previewOf(s: Session): string | undefined {
  if (s.state === "needs-you") return s.dialog?.summary;
  if (s.state === "working") {
    const running = pendingEntry(s);
    // As the desktop writes it (remote-host.ts `linesOf`).
    if (!running) return undefined;
    return running.text ? `${running.tool}: ${running.text}` : running.tool;
  }
  const said = s.entries.findLast((e) => e.kind === "assistant" && !e.local);
  return said ? firstSentence(said.text) : undefined;
}

function firstSentence(text: string): string {
  const line = text
    .split("\n")
    .map((l) => l.replace(/^\s*(?:[#>*-]+|\d+\.)\s*/, "").trim())
    .find(Boolean);
  if (!line) return "";
  const end = line.search(/[。！？]|[.!?](?=\s|$)/);
  const sentence = end >= 0 ? line.slice(0, end + 1) : line;
  return sentence.length > 120 ? `${sentence.slice(0, 119)}…` : sentence;
}

// ---------------------------------------------------------------------------
// Terminal: a full repaint of a CLI-like screen at the PTY's width
// ---------------------------------------------------------------------------

const SGR = (code: string, text: string) => `\x1b[${code}m${text}\x1b[0m`;
const dim = (t: string) => SGR("90", t);
const bold = (t: string) => SGR("1;97", t);
const yellow = (t: string) => SGR("33", t);
const blue = (t: string) => SGR("94", t);

// Columns a string takes in a terminal: CJK and full-width forms take two.
function width(text: string): number {
  // eslint-disable-next-line no-control-regex
  const plain = text.replace(/\x1b\[[0-9;]*m/g, "");
  let w = 0;
  for (const ch of plain) {
    const c = ch.codePointAt(0) ?? 0;
    const wide =
      (c >= 0x1100 && c <= 0x115f) ||
      (c >= 0x2e80 && c <= 0xa4cf) ||
      (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe4f) ||
      (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6);
    w += wide ? 2 : 1;
  }
  return w;
}

// A box as wide as the terminal, its right edge lined up whatever the content.
function box(cols: number, lines: string[], color: (t: string) => string): string[] {
  const inner = cols - 4;
  return [
    color(`╭${"─".repeat(cols - 2)}╮`),
    ...lines.map((l) => `${color("│")} ${l}${" ".repeat(Math.max(0, inner - width(l)))} ${color("│")}`),
    color(`╰${"─".repeat(cols - 2)}╯`),
  ];
}

function paint(s: Session): string {
  const cols = s.cols;
  const claude = s.info.backend === "claude";
  const lines: string[] = [];

  for (const e of s.entries) {
    if (e.kind === "user") {
      lines.push("", dim(`> ${e.text}`), "");
    } else if (e.kind === "assistant") {
      const [first, ...rest] = e.text.split("\n");
      lines.push(`${bold("⏺")} ${first}`, ...rest.map((l) => `  ${l}`));
    } else {
      const mark = e.pending ? dim("⏺") : e.outcome === "error" ? SGR("31", "⏺") : SGR("32", "⏺");
      const result = e.pending
        ? "Running…"
        : e.outcome === "error"
          ? "Error"
          : e.added !== undefined
            ? `Added ${e.added} lines, removed ${e.removed ?? 0} lines`
            : "Done";
      lines.push(`${mark} ${bold(e.tool ?? "")}(${e.text})`, dim(`  ⎿  ${result}`));
    }
  }

  const bottom: string[] = [];
  const d = s.dialog;
  if (d?.dialog?.kind === "permission") {
    const options = d.dialog.options.map((o, i) => `${i === 0 ? blue("❯") : " "} ${i + 1}. ${o.label}`);
    bottom.push(
      ...box(
        cols,
        [
          bold(`${d.dialog.tool} command`),
          "",
          `  ${d.dialog.subject ?? ""}`,
          dim(`  ${d.dialog.description ?? ""}`),
          "",
          "Do you want to proceed?",
          ...options,
        ],
        blue
      )
    );
  } else if (d?.dialog?.kind === "plan") {
    const plan = d.dialog.plan.split("\n").slice(0, 12);
    const options = d.dialog.options.map((o, i) => `${i === 0 ? blue("❯") : " "} ${i + 1}. ${o.label}`);
    bottom.push(...box(cols, [bold("Ready to code?"), "", ...plan, "", ...options], blue));
  } else if (d?.dialog?.kind === "questions") {
    const q = d.dialog.questions[0];
    const options = q.options.map((o, i) => `${i === 0 ? blue("❯") : " "} ${i + 1}. ${o.label}  ${dim(o.description ?? "")}`);
    const tabs = d.dialog.questions.map((x, i) => (i === 0 ? bold(`☐ ${x.header ?? ""}`) : dim(`☐ ${x.header ?? ""}`)));
    bottom.push(
      ...box(cols, [tabs.join("  "), "", bold(q.question), "", ...options, `  ${q.options.length + 1}. Type something.`], blue)
    );
  } else if (d) {
    // The form the phone can't show (mockup 4.1).
    bottom.push(
      ...box(
        cols,
        [
          bold("linear-mcp needs input"),
          "",
          `  Team:      ${blue("APRA Platform")}`,
          `  Priority:  ${blue("❯ High")}    Medium    Low`,
          "  Labels:    [x] backend  [ ] frontend  [ ] infra",
          "",
          dim("Tab to move · Space to toggle · Enter to submit · Esc to cancel"),
        ],
        yellow
      )
    );
  } else {
    bottom.push(...box(cols, [`> ${s.typed}`], dim));
  }
  const left = claude ? "  ? for shortcuts" : "  ctrl+p commands";
  const right = claude ? "◯ Opus 5.5 · 41%  " : "claude-opus-5.5 · build  ";
  bottom.push(dim(left + " ".repeat(Math.max(1, cols - width(left) - width(right))) + right));

  const room = s.rows - bottom.length - 1;
  const screen = [...(room > 0 ? lines.slice(-room) : []), "", ...bottom];
  return `\x1b[H\x1b[2J${screen.join("\r\n")}`;
}

