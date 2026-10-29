// What a paired phone sees of each session, and what it may do to one (mobile-v2
// Stories 2, 4, 5, 6): the RemoteHost the phone server (ws-server.ts) is given.
//
// Everything comes from process-manager's own state, so the phone and the desk
// can't disagree:
//   - Needs you is the secretary's live needs-you event, and its seq is the one an
//     `answer` names. Finished is its finished event, until a phone opens the
//     session or the builder writes to it (a write drops the event). Working is the
//     agent's own report that a turn runs (InstanceInfo.working), not the write
//     gate's `busy`, which any keystroke sets and an Esc interrupt never ends.
//   - Dialogs are answered with the secretary's measured key flows, or OpenCode's
//     API (secretary/dialog.ts). The phone names an effect or option numbers and
//     never sends a key of its own.
//   - A push (Story 7) goes out for each of those Finished and Needs you events, with
//     the same line the list shows, once that line has been read.
//
// Kept apart from remote/index.ts, which wires it to the real process manager, so
// tests drive it with a fake one.

import type { AnswerOutcome, InstanceInfo, ProcessManager, SecretaryEvent } from "../process-manager";
import {
  checkChoice,
  dialogOf,
  type AskBack,
  type Choice,
  type Dialog,
  type EffectOption,
  type OptionEffect,
} from "../secretary/dialog";
import { replyConclusion } from "../../shared/replyStart";
import type {
  RemoteChoice,
  RemoteDialog,
  RemoteEffectOption,
  RemoteInstance,
  RemoteSessionState,
  TranscriptEntry,
} from "../../shared/remote-protocol";
import type { HostAck, LiveDialog, RemoteHost, RemoteServer } from "./ws-server";

// What this needs from process-manager. ProcessManager itself satisfies it.
export type HostProcessManager = Pick<
  ProcessManager,
  | "listInstances"
  | "infoOf"
  | "secretaryEventOf"
  | "onSecretaryEvent"
  | "answerDialog"
  | "isAnswering"
  | "dialogOnScreen"
  | "sendPrompt"
  | "writeToInstance"
  | "interruptInstance"
  | "canInterrupt"
  | "readRecentTurns"
  | "ptySizeOf"
>;

// The server's broadcasts and pushes this drives.
export type HostPush = Pick<
  RemoteServer,
  | "isRunning"
  | "broadcastInstances"
  | "broadcastPromptState"
  | "broadcastPromptCleared"
  | "broadcastTranscript"
  | "pushSession"
>;

// A preview line's length when no sentence ends sooner.
const PREVIEW_CHARS = 120;

// A sentence end sooner than this doesn't end the preview: "Done." alone says
// nothing, and agents open with it ("Done. Created a.txt …", measured live).
const MIN_SENTENCE_CHARS = 24;

// How long after a Stop another one for the same turn is refused. The agent may not
// have reported the turn over yet (Claude's registry is read once a second), and on
// an idle Claude two Escs close together open its rewind menu, where the phone's
// next message would land. After this, a turn still running really is, and the
// builder may try again.
const STOP_SETTLE_MS = 3000;

// What the latest turn says, for the list's line: cached per instance and refreshed
// on each event and on the server's throttled refresh while a turn runs, never
// read per list call.
interface Lines {
  // The first sentence of the turn's conclusion (Finished).
  conclusion?: string;
  // The first sentence of the last thing it said (Idle, and Working before a tool).
  said?: string;
  // The tool it is on, with what it acts on (Working).
  tool?: string;
}

const EFFECTS: ReadonlySet<string> = new Set<OptionEffect>([
  "allow-once",
  "allow-always",
  "deny",
  "approve",
  "approve-auto",
  "revise",
]);

const refuse = (reason: Extract<HostAck, { ok: false }>["reason"], message: string): HostAck => ({
  ok: false,
  reason,
  message,
});

const OK: HostAck = { ok: true };

export function createRemoteHost(pm: HostProcessManager, push: HostPush): RemoteHost & {
  dispose(): void;
} {
  const lines = new Map<string, Lines>();
  // The session each instance's lines were read from: `/clear` or a resume moves it.
  const linesSession = new Map<string, string | undefined>();
  // The finished event a phone opened, per instance: that one is Idle.
  const seen = new Map<string, number>();
  // The needs-you each instance's phones were shown, for the seq of its clearing.
  const shown = new Map<string, number>();
  // The turn each instance was last stopped in (its workingSince), and when: see
  // STOP_SETTLE_MS.
  const stopping = new Map<string, { turn: number; at: number }>();
  // The state each instance was last listed in, to catch a turn starting.
  const listed = new Map<string, RemoteSessionState>();
  // The seq of each instance's latest event that wasn't a restatement: the latest
  // one that gets a push.
  const fresh = new Map<string, number>();
  const reading = new Set<string>();
  // Per instance being read, who asked for a read meanwhile: they get the next one.
  const readAgain = new Map<string, (() => void)[]>();

  // Read the latest turn, from the end of the session (the phone's own reader), and
  // update the instance's lines. Never inside the call that asked for it, which may
  // be a listing: the change it finds is broadcast as a list of its own. One read at
  // a time per instance, with one more after it when asked meanwhile. Resolves once
  // the lines are from a read that began after the call (a push waits for that), and
  // never rejects.
  function refreshLines(id: string): Promise<void> {
    return new Promise((resolve) => {
      const waiting = readAgain.get(id);
      if (waiting) {
        waiting.push(resolve);
        return;
      }
      if (reading.has(id)) {
        readAgain.set(id, [resolve]);
        return;
      }
      reading.add(id);
      void Promise.resolve()
        .then(() => pm.readRecentTurns(id, 1).entries)
        .catch(() => null)
        .then((turn) => {
          if (!turn) return;
          const next = linesOf(turn);
          const before = lines.get(id);
          lines.set(id, next);
          if (
            before?.conclusion !== next.conclusion ||
            before?.said !== next.said ||
            before?.tool !== next.tool
          ) {
            push.broadcastInstances();
          }
        })
        .catch(() => undefined)
        .finally(() => {
          reading.delete(id);
          resolve();
          const next = readAgain.get(id);
          readAgain.delete(id);
          if (next) void refreshLines(id).then(() => next.forEach((done) => done()));
        });
    });
  }

  // The push for an event, with the line the list shows for it: what the dialog asks,
  // or the conclusion's first sentence, read (refreshLines) before this runs. An event
  // a newer fresh one has followed meanwhile gets none: the newer one's push replaces
  // it on the phone anyway, and it must not arrive after that one. A restatement
  // doesn't count, since it gets no push of its own (an OpenCode turn that ends
  // beside an open dialog reports Finished, then restates the dialog at once). One
  // the builder has already dealt with at the desk still gets its push (Story 7:
  // whether or not the builder is at the desk).
  function pushEvent(id: string, event: SecretaryEvent) {
    const info = pm.infoOf(id);
    if (!info || info.isManager) return;
    if ((fresh.get(id) ?? 0) > event.seq) return;
    const state: RemoteSessionState = event.kind === "needs-you" ? "needs-you" : "finished";
    const body = previewOf(state, event, info, lines.get(id) ?? {});
    // The phone's Needs you count, as its list would show it now.
    const badge = pm
      .listInstances()
      .filter((i) => !i.isManager && pm.secretaryEventOf(i.id)?.kind === "needs-you").length;
    push.pushSession({
      instanceId: id,
      title: `${info.name} · ${state === "needs-you" ? "Needs you" : "Finished"}`,
      ...(body ? { body } : {}),
      badge,
    });
  }

  const unsubscribe = pm.onSecretaryEvent((id, event) => {
    const previous = shown.get(id);
    if (event?.kind === "needs-you") {
      shown.set(id, event.seq);
      push.broadcastPromptState(id);
    } else if (previous !== undefined) {
      shown.delete(id);
      push.broadcastPromptCleared(id, previous);
    }
    if (event) {
      // The agent just stopped: whoever reads it wants what it did, not the
      // transcript from when they opened it.
      push.broadcastTranscript(id);
      // The push needs the line while no phone is connected, so this doesn't wait for
      // one; it only waits for the phone link to be on. With the link off there is no
      // push, and the line is read when the instance is next listed. A restated
      // dialog was pushed when it was first reported.
      if (push.isRunning()) {
        const read = refreshLines(id);
        if (!event.restated) {
          fresh.set(id, event.seq);
          void read.then(() => pushEvent(id, event)).catch(() => undefined);
        }
      } else {
        lines.delete(id);
      }
    }
    push.broadcastInstances();
  });

  const phoneable = (id: string): InstanceInfo | null => {
    const info = pm.infoOf(id);
    return info && !info.isManager && info.status === "running" ? info : null;
  };
  // A dialog is on screen: reported and unanswered, or its answer's keys are still
  // going in (the first key clears the event, the dialog closes on the last), or the
  // agent says one is up though a keystroke into it dropped the event.
  const dialogOpen = (id: string): boolean =>
    pm.secretaryEventOf(id)?.kind === "needs-you" || pm.isAnswering(id) || pm.dialogOnScreen(id);

  return {
    listInstances(): RemoteInstance[] {
      const infos = pm.listInstances().filter((i) => !i.isManager);
      const ids = new Set(infos.map((i) => i.id));
      for (const map of [lines, linesSession, seen, stopping, listed, fresh]) {
        for (const id of map.keys()) if (!ids.has(id)) map.delete(id);
      }
      return infos.map((info) => {
        const event = pm.secretaryEventOf(info.id);
        const { state, since } = stateOf(info, event, seen.get(info.id));
        // Its first listing reads what it last said, once, and so does its first in
        // another session; a turn starting reads again, so Working doesn't show the
        // last turn's line.
        if (!lines.has(info.id) || linesSession.get(info.id) !== info.sessionId) {
          lines.set(info.id, {});
          linesSession.set(info.id, info.sessionId);
          void refreshLines(info.id);
        } else if (state === "working" && listed.get(info.id) !== "working") {
          void refreshLines(info.id);
        }
        listed.set(info.id, state);
        const preview = previewOf(state, event, info, lines.get(info.id) ?? {});
        return {
          id: info.id,
          name: info.name,
          cwd: info.cwd,
          backend: info.backend,
          status: info.status,
          state,
          ...(since !== undefined ? { since } : {}),
          ...(preview ? { preview } : {}),
        };
      });
    },

    liveDialog(id): LiveDialog | null {
      const event = pm.secretaryEventOf(id);
      const info = pm.infoOf(id);
      if (event?.kind !== "needs-you" || !info || info.isManager) return null;
      const dialog = dialogOf(event, info.backend);
      return {
        seq: event.seq,
        summary: summaryOf(event, dialog),
        ...(dialog ? { dialog: remoteDialog(dialog, event) } : {}),
      };
    },

    markSeen(id) {
      const event = pm.secretaryEventOf(id);
      if (event?.kind !== "finished" || seen.get(id) === event.seq) return;
      seen.set(id, event.seq);
      push.broadcastInstances();
    },

    readTranscript: (id, turns) => pm.readRecentTurns(id, turns),

    ptySize: (id) => pm.ptySizeOf(id),

    refreshPreview(id) {
      if (pm.infoOf(id)?.working) void refreshLines(id);
    },

    writeToInstance: (id, data) => pm.writeToInstance(id, data),

    async sendPrompt(id, text) {
      if (!phoneable(id)) return refuse("not-running", "This session isn't running");
      // Text would land in the dialog, and could answer it.
      if (dialogOpen(id)) {
        const shown = pm.secretaryEventOf(id)?.kind === "needs-you" || pm.isAnswering(id);
        return refuse("dialog-open", shown ? "Answer the dialog first" : "A dialog is open in its terminal; answer it there first");
      }
      if (!text.trim()) return refuse("failed", "Nothing to send");
      pm.sendPrompt(id, text);
      return OK;
    },

    async answer(id, seq, choice, confirmed) {
      const event = pm.secretaryEventOf(id);
      if (event?.kind !== "needs-you" || event.seq !== seq) {
        return refuse("gone", "This dialog is no longer open");
      }
      const info = phoneable(id);
      if (!info) return refuse("not-running", "This session isn't running");
      const dialog = dialogOf(event, info.backend);
      if (!dialog) return refuse("unsupported", "This dialog can't be answered from the phone; use the terminal");
      const parsed = choiceOf(choice);
      if (!parsed) return refuse("unsupported", "That isn't one of this dialog's options");

      const checked = checkChoice(dialog, parsed, confirmed);
      if (!checked.ok) {
        if ("refuse" in checked) {
          return checked.refuse === "unsupported"
            ? refuse("unsupported", "This dialog can't be answered from the phone; use the terminal")
            : refuse("unsupported", "That isn't one of this dialog's options");
        }
        return askRefusal(checked.ask);
      }

      // Without `expect`: a session's alert hooks report no PostToolUse
      // (ALERT_HOOK_EVENTS), so the CLI's record of a question box's answers that the
      // check needs never arrives, and waiting for it only held the ack 5 s (measured
      // live). A phone that looks sees what the CLI took.
      let outcome: AnswerOutcome;
      try {
        outcome = await pm.answerDialog(id, seq, { ...checked.plan, expect: undefined });
      } catch {
        outcome = { ok: false, reason: "failed" };
      }
      if (!outcome.ok) {
        switch (outcome.reason) {
          case "answered":
            return refuse("gone", "This dialog is no longer open");
          case "changed":
            return refuse("gone", "A new dialog came up while answering; look again");
          case "interrupted":
            return refuse("gone", "Someone typed in the terminal while answering; look again");
          case "stopped":
            return refuse("not-running", "This session stopped");
          case "failed":
            return refuse("failed", "The answer may not have gone through; check the terminal");
        }
      }
      return OK;
    },

    async interrupt(id) {
      const info = phoneable(id);
      if (!info) return refuse("not-running", "This session isn't running");
      if (dialogOpen(id)) return refuse("dialog-open", "A dialog is open; Esc would answer it");
      if (!info.working) return refuse("not-working", "Nothing is running");
      // OpenCode stops only the session its terminal shows, while that one runs.
      if (!pm.canInterrupt(id)) {
        return refuse("unsupported", "Its terminal isn't showing the running turn; stop it there");
      }
      const turn = info.workingSince ?? 0;
      const last = stopping.get(id);
      if (last?.turn === turn && Date.now() - last.at < STOP_SETTLE_MS) {
        return refuse("not-working", "Already stopping this turn");
      }
      stopping.set(id, { turn, at: Date.now() });
      if (await pm.interruptInstance(id)) return OK;
      if (pm.secretaryEventOf(id)?.kind === "needs-you" || pm.dialogOnScreen(id)) {
        return refuse("dialog-open", "A dialog came up; answer it instead");
      }
      if (!phoneable(id)) return refuse("not-running", "This session stopped");
      return refuse("failed", "Couldn't stop it; check the terminal");
    },

    dispose: unsubscribe,
  };
}

// The four states, in the phone's order of precedence: a dialog over a running
// turn (a turn stopped on one is not working anyway), a running turn over a result
// nobody read.
function stateOf(
  info: InstanceInfo,
  event: SecretaryEvent | undefined,
  seenSeq: number | undefined
): { state: RemoteSessionState; since?: number } {
  if (event?.kind === "needs-you") return { state: "needs-you", since: event.at };
  if (info.working) return { state: "working", since: info.workingSince };
  if (event?.kind === "finished" && event.seq !== seenSeq) {
    return { state: "finished", since: event.at };
  }
  return { state: "idle", since: info.lastActivityAt };
}

function previewOf(
  state: RemoteSessionState,
  event: SecretaryEvent | undefined,
  info: InstanceInfo,
  cached: Lines
): string | undefined {
  switch (state) {
    case "needs-you":
      return event ? summaryOf(event, dialogOf(event, info.backend)) : undefined;
    case "working":
      return cached.tool ?? cached.said;
    case "finished":
      return cached.conclusion ?? cached.said;
    case "idle":
      return cached.said;
  }
}

function linesOf(turn: TranscriptEntry[]): Lines {
  const conclusion = replyConclusion(turn);
  let said: string | undefined;
  let tool: TranscriptEntry | undefined;
  // Back to the last thing it said. Only a pending tool after that counts: one it
  // has talked past is a background task, not what it is on.
  for (let i = turn.length - 1; i >= 0; i--) {
    const entry = turn[i];
    if (entry.kind === "assistant") {
      said = entry.text;
      break;
    }
    if (entry.kind === "tool" && entry.pending) tool ??= entry;
  }
  return {
    conclusion: conclusion ? firstSentence(conclusion) : undefined,
    said: said ? firstSentence(said) : undefined,
    tool: tool ? oneLine(tool.text ? `${tool.tool ?? "Tool"}: ${tool.text}` : (tool.tool ?? "Tool")) : undefined,
  };
}

// One line of a needs-you event: what the dialog asks, as the list row and
// `prompt-state.summary` show it ("Bash: pnpm test:e2e", the question).
function summaryOf(event: SecretaryEvent, dialog: Dialog | null): string {
  if (dialog?.kind === "permission") {
    const subject = subjectOf(dialog);
    return oneLine(subject ? `${dialog.toolName}: ${subject}` : dialog.toolName);
  }
  if (dialog?.kind === "questions") return oneLine(dialog.questions[0].question);
  if (dialog?.kind === "plan") {
    const title = plainText(dialog.plan.split("\n").find((l) => plainText(l)) ?? "");
    if (!title) return "Plan ready for review";
    return oneLine(/^plan\b/i.test(title) ? title : `Plan: ${title}`);
  }
  const detail = event.prompt?.detail;
  return oneLine(detail?.question ?? detail?.tool ?? "Waiting for you in the terminal");
}

// The dialog as the phone draws it, from what the secretary answers it with.
function remoteDialog(dialog: Dialog, event: SecretaryEvent): RemoteDialog {
  // The decoded options' descriptions where they say more ("OpenCode saves
  // "touch *" for this project…"), matched by label.
  const described = new Map(
    (event.prompt?.detail.options ?? []).map((o) => [o.label, o.description] as const)
  );
  const options = (list: EffectOption[]): RemoteEffectOption[] =>
    list.map((o) => {
      const description = described.get(o.label) ?? o.description;
      return { effect: o.effect, label: o.label, ...(description ? { description } : {}) };
    });

  if (dialog.kind === "permission") {
    const subject = subjectOf(dialog);
    const description = str(asRecord(dialog.toolInput)?.description);
    return {
      kind: "permission",
      tool: dialog.toolName,
      ...(subject ? { subject } : {}),
      ...(description ? { description } : {}),
      options: options(dialog.options),
      reasonAllowed: takesReason(dialog),
    };
  }
  if (dialog.kind === "plan") return { kind: "plan", plan: dialog.plan, options: options(dialog.options) };
  return {
    kind: "questions",
    questions: dialog.questions.map((q) => ({
      question: q.question,
      ...(q.header ? { header: q.header } : {}),
      multiSelect: q.multiSelect,
      options: q.options.map((o) => (o.description ? { label: o.label, description: o.description } : { label: o.label })),
    })),
    textAllowed: takesText(dialog),
  };
}

// Whether a denial's reason reaches the agent, by what checkChoice plans for one: a
// prompt after the keys (Claude) or the Reject's message (OpenCode).
function takesReason(dialog: Extract<Dialog, { kind: "permission" }>): boolean {
  const checked = checkChoice(dialog, { effect: "deny", feedback: "reason", explicit: true });
  if (!checked.ok) return false;
  const { followUp, answer } = checked.plan;
  return followUp !== undefined || (answer?.kind === "permission" && answer.message !== undefined);
}

// Whether every question takes typed text, by whether checkChoice accepts it.
function takesText(dialog: Extract<Dialog, { kind: "questions" }>): boolean {
  const answers = dialog.questions.map((_, q) => ({ question: q + 1, picks: [], text: "text" }));
  return checkChoice(dialog, { answers }).ok;
}

// What a permission acts on, as the CLI shows it: the command, file path or URL
// (Claude's tool input), or the resources OpenCode asks about.
function subjectOf(dialog: Extract<Dialog, { kind: "permission" }>): string | undefined {
  const input = asRecord(dialog.toolInput);
  if (!input) return undefined;
  if (dialog.backend === "opencode") {
    const resources = Array.isArray(input.resources)
      ? input.resources.filter((r): r is string => typeof r === "string" && r.length > 0)
      : [];
    return resources.length > 0 ? resources.join(", ") : undefined;
  }
  for (const key of ["command", "file_path", "notebook_path", "url", "pattern", "path"]) {
    const value = str(input[key]);
    if (value) return value;
  }
  return undefined;
}

// The phone's choice as checkChoice takes it, or null for a shape it can't be.
// `explicit`: the builder tapped this very option, so a wider one is held only to
// the phone's "Are you sure?" (`confirmed`), never asked about again.
function choiceOf(value: RemoteChoice): Choice | null {
  const choice = asRecord(value);
  if (!choice) return null;
  if (typeof choice.effect === "string") {
    if (!EFFECTS.has(choice.effect)) return null;
    if (choice.feedback !== undefined && typeof choice.feedback !== "string") return null;
    return { effect: choice.effect as OptionEffect, feedback: choice.feedback, explicit: true };
  }
  if (!Array.isArray(choice.answers)) return null;
  const answers: Extract<Choice, { answers: unknown }>["answers"] = [];
  for (const raw of choice.answers) {
    const a = asRecord(raw);
    if (!a || typeof a.question !== "number" || !Array.isArray(a.picks)) return null;
    if (!a.picks.every((p): p is number => typeof p === "number")) return null;
    if (a.text !== undefined && typeof a.text !== "string") return null;
    answers.push({ question: a.question, picks: a.picks, text: a.text });
  }
  return { answers };
}

function askRefusal(ask: AskBack): HostAck {
  switch (ask) {
    case "confirm-always":
    case "confirm-auto":
      return refuse("needs-confirm", "Confirm first: this widens what the agent may do");
    case "what-to-change":
      return refuse("failed", "Say what the plan should change");
    case "unanswered":
      return refuse("failed", "Answer every question first");
    case "once-or-always":
    case "approve-how":
      return refuse("failed", "Pick one of the options");
  }
}

// The first sentence of a Markdown text, as one plain line: from its first line
// that isn't a heading (or the first heading, when it is all headings), cut at the
// first sentence end past MIN_SENTENCE_CHARS, or at PREVIEW_CHARS.
export function firstSentence(text: string): string {
  const rows = text
    .split("\n")
    .filter((row) => !row.trimStart().startsWith("```"))
    .filter((row) => plainText(row));
  const row = rows.find((r) => !/^\s*#/.test(r)) ?? rows[0] ?? "";
  const line = plainText(row);
  const ends = /[.!?](?=\s|$)|[。！？]/g;
  for (let m = ends.exec(line); m && m.index < PREVIEW_CHARS; m = ends.exec(line)) {
    if (m.index + 1 >= MIN_SENTENCE_CHARS) return line.slice(0, m.index + 1);
  }
  return oneLine(line);
}

// A Markdown line without its marks: headings, quotes, bullets, bold, code ticks,
// and links as their text. Single `*` and `_` stay: they are as often part of a
// name (snake_case) as emphasis.
function plainText(line: string): string {
  return line
    .replace(/^\s*(?:#+|>|[-*+]|\d+[.)])\s+/, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\*\*|__|`/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function oneLine(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > PREVIEW_CHARS ? `${line.slice(0, PREVIEW_CHARS - 1)}…` : line;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}
