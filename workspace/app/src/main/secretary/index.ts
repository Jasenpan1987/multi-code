// The voice secretary's orchestrator (T-505). Each Claude instance's live event
// (T-503, process-manager's `onSecretaryEvent`) becomes a brief (T-504) and, when
// a speech server is set, that brief's audio (T-502), prepared the moment the
// alert fires so it is ready before the click (PRD Story 2).
//
// One entry per instance, its latest brief, in memory only: the text, the wav and
// the state go when a newer event replaces it, when Secretary Mode goes off, or
// when the instance is removed. When its event clears (the builder typed in the
// session or answered the dialog), the brief stays, marked handled, so it can still
// be read and replayed (PRD v1.7, T-527). Nothing here writes to disk (PRD, Privacy).
//
// Per event, text first, then audio:
//
//   preparing ─▶ ready, audio pending ─▶ ready, audio ready | unavailable
//       │                 (text shown)     (no server set, or synthesis failed)
//       └──────▶ failed (no brief could be written)
//
// With no server set, "ready" goes straight to audio unavailable. One brief and at
// most one speech request per event, never retried (Story 7). A newer event for
// the same instance, the mode going off or a removal aborts the work in flight (the
// brief writer kills its CLI, the speech request is cancelled), and anything that
// still comes back for it is discarded. A clear doesn't: the shown session's card
// opens as the event arrives, and a click into its terminal is a write, so aborting
// would close that card before it said anything. While the mode is off nothing is
// spawned or called; turning it on prepares every event still live (Story 1).
//
// The renderer hears every change on `secretary-brief` (instanceId, state | null)
// and the mode on `secretary-mode`; it fetches a ready wav by instance and seq, so
// the audio never rides an update.
//
// A Needs-you brief whose dialog can be answered in words takes replies (T-509,
// PRD Story 6): each one is read by the reply interpreter, held to the dialog by
// dialog.ts, and only then answered with keys through process-manager, which
// writes nothing unless that event is still the live one. Asking back and
// answering a question press nothing. The exchanges live on the job, so they go
// with the brief and come back with a reopened card.

import { BrowserWindow } from "electron";
import { processManager } from "../process-manager";
import type { SecretaryEvent, SecretaryEventListener } from "../process-manager";
import { loadSpeechServer } from "../settings-store";
import { synthesize } from "./speech";
import { normalizeLoudness } from "./loudness";
import type { SpeechOptions, SpeechServer, SynthesizeResult } from "./speech";
import { writeBriefFor } from "./briefWriter";
import type { Brief } from "./briefWriter";
import { answerMismatches, checkChoice, dialogOf, isPlainYes } from "./dialog";
import type { AnswerPlan, AskBack, Checked, Choice, Dialog } from "./dialog";
import { interpretReply } from "./replyInterpreter";
import type { Interpretation, ReplyInterpreterInput } from "./replyInterpreter";
import type { AnswerOutcome } from "../process-manager";
import type {
  BriefLanguage,
  SecretaryBriefState,
  SecretaryExchange,
} from "../../shared/types";

export interface SecretaryDeps {
  onSecretaryEvent(listener: SecretaryEventListener): () => void;
  liveSecretaryEvents(): { instanceId: string; event: SecretaryEvent }[];
  writeBriefFor(
    instanceId: string,
    event: SecretaryEvent,
    signal: AbortSignal
  ): Promise<Brief>;
  // Read once per brief, so a server that comes back, or a new address or key,
  // applies to the next brief without a restart.
  loadSpeechServer(): SpeechServer;
  synthesize(
    server: SpeechServer,
    text: string,
    language: BriefLanguage,
    options: SpeechOptions
  ): Promise<SynthesizeResult>;
  // To the renderer.
  send(channel: string, ...args: unknown[]): void;
  // The dialog a needs-you event can be answered on in words, or null.
  dialogFor(instanceId: string, event: SecretaryEvent): Dialog | null;
  interpretReply(input: ReplyInterpreterInput, signal: AbortSignal): Promise<Interpretation>;
  answerDialog(
    instanceId: string,
    seq: number,
    plan: AnswerPlan,
    signal: AbortSignal
  ): Promise<AnswerOutcome>;
}

export interface Secretary {
  // Subscribe to events and apply the saved mode. Once, at app start.
  start(enabled: boolean): void;
  setMode(enabled: boolean): void;
  isOn(): boolean;
  // Every instance's latest brief, by instance id.
  briefs(): Record<string, SecretaryBriefState>;
  // The wav of the instance's brief for event `seq`, or null when that is no
  // longer its brief or its audio isn't ready.
  audioFor(instanceId: string, seq: number): Buffer | null;
  // Drop the instance's brief, when the instance is removed.
  forget(instanceId: string): void;
  // The builder's reply on the card of the instance's brief for event `seq`.
  // Resolves when the secretary has acted, asked back or answered; never throws.
  reply(instanceId: string, seq: number, text: string): Promise<void>;
  // Unsubscribe and abort everything in flight. At quit.
  stop(): void;
}

export const BRIEF_CHANNEL = "secretary-brief";
export const MODE_CHANNEL = "secretary-mode";

export const NO_SERVER_REASON = "no speech server set";

interface Job {
  event: SecretaryEvent;
  state: SecretaryBriefState;
  abort: AbortController;
  wav?: Buffer;
  handled?: boolean;
  dialog: Dialog | null;
  exchanges: SecretaryExchange[];
  // A wider choice the secretary has asked the builder to confirm, with what it will
  // say once it is pressed. Only the very next reply can confirm it.
  confirming?: { choice: Choice; message: string };
}

// What the secretary says itself, rather than the interpreter: refusals, checks
// that stopped a choice, and what went wrong. In the reply's language.
const SAY = {
  busy: ["我还在处理你上一条回复。", "I'm still working on your last reply."],
  answered: ["这个对话框已经答过了。我什么都没按。", "This dialog was already answered. I pressed nothing."],
  answeredMeanwhile: [
    "我在想的时候，对话框已经答了。我什么都没按。",
    "The dialog was answered while I was thinking. I pressed nothing.",
  ],
  unsupported: [
    "这个对话框我答不了。请在终端里回答。",
    "I can't answer this dialog. Please answer it in the terminal.",
  ],
  badChoice: [
    "我没法把它准确对上选项，所以什么都没按。请在终端里回答。",
    "I couldn't match that to an option safely, so I pressed nothing. Please answer in the terminal.",
  ],
  failed: [
    "我没读懂这条回复，所以什么都没按。请再说一次。",
    "I couldn't read that reply, so I pressed nothing. Please say it again.",
  ],
  changed: [
    "按到一半，又弹出了新的对话框。我停下了。请看一下终端。",
    "A new dialog came up while I was pressing keys. I stopped. Please check the terminal.",
  ],
  interrupted: [
    "我按键的时候，终端里也有人按了键。我停下了。请看一下终端。",
    "Someone typed in the terminal while I was pressing keys. I stopped. Please check the terminal.",
  ],
  stopped: ["这个会话已经停了。", "The session has stopped."],
} as const;

const ASK_BACK: Record<AskBack, readonly [string, string]> = {
  "once-or-always": ["只允许这一次，还是以后都不再问？", "Allow it just this once, or never ask again?"],
  "approve-how": [
    "批准以后，改动要逐个问你，还是自动接受？",
    "Once approved, should it ask before each edit, or accept edits on its own?",
  ],
  "confirm-always": [
    "确认一下：以后这类操作都不再问你，直接允许，对吗？回答“是”我就照办。",
    "To confirm: allow it, and never ask again for calls like it? Reply \"yes\" and I'll do it.",
  ],
  "confirm-auto": [
    "确认一下：批准计划，以后的改动都自动接受，不再逐个问你，对吗？回答“是”我就照办。",
    "To confirm: approve, and accept every edit without asking? Reply \"yes\" and I'll do it.",
  ],
  "what-to-change": ["你想让它改计划里的什么？", "What should it change in the plan?"],
  unanswered: [
    "还有问题没答。请把剩下的也告诉我。",
    "Some questions are still open. Please tell me the rest.",
  ],
};

function mismatchNote(zh: boolean, questions: string[]): string {
  const list = questions.join(zh ? "、" : "; ");
  return zh
    ? `注意：CLI 记下的答案和我想按的不一样：${list}。请看一下终端。`
    : `Note: what the CLI recorded differs from what I meant for: ${list}. Please check the terminal.`;
}

export function createSecretary(deps: SecretaryDeps): Secretary {
  let on = false;
  let unsubscribe: (() => void) | null = null;
  const jobs = new Map<string, Job>();

  const isCurrent = (instanceId: string, job: Job) => jobs.get(instanceId) === job;

  // Every state carries the job's own marks, whichever step it comes from:
  // `handled` after a clear, `replyable` and the exchanges for a dialog.
  const publish = (instanceId: string, job: Job, state: SecretaryBriefState) => {
    const step = { ...state };
    delete step.handled;
    delete step.replyable;
    delete step.exchanges;
    job.state = {
      ...step,
      ...(job.handled ? { handled: true } : {}),
      ...(job.dialog ? { replyable: true } : {}),
      ...(job.exchanges.length ? { exchanges: job.exchanges.map((e) => ({ ...e })) } : {}),
    } as SecretaryBriefState;
    deps.send(BRIEF_CHANNEL, instanceId, job.state);
  };

  const markHandled = (instanceId: string) => {
    const job = jobs.get(instanceId);
    if (!job || job.handled) return;
    job.handled = true;
    publish(instanceId, job, job.state);
  };

  const drop = (instanceId: string) => {
    const job = jobs.get(instanceId);
    if (!job) return;
    jobs.delete(instanceId);
    job.abort.abort();
    deps.send(BRIEF_CHANNEL, instanceId, null);
  };

  const prepare = (instanceId: string, event: SecretaryEvent) => {
    const current = jobs.get(instanceId);
    // Already on this event (or, impossibly, a newer one).
    if (current && current.event.seq >= event.seq) return;
    // Replaced in place: the renderer goes straight from the old brief to the new
    // one's "preparing", with no null in between.
    current?.abort.abort();
    const job: Job = {
      event,
      abort: new AbortController(),
      state: { seq: event.seq, kind: event.kind, status: "preparing" },
      dialog: event.kind === "needs-you" ? deps.dialogFor(instanceId, event) : null,
      exchanges: [],
    };
    jobs.set(instanceId, job);
    publish(instanceId, job, job.state);
    void run(instanceId, job).catch((err) => {
      // Last resort: run() catches the writer and the speech client itself, and
      // reading the speech settings doesn't throw. A brief stuck on "preparing"
      // would leave the card waiting forever, so say why instead.
      if (isCurrent(instanceId, job) && job.state.status === "preparing") {
        publish(instanceId, job, { ...job.state, status: "failed", reason: reasonOf(err) });
      }
    });
  };

  async function run(instanceId: string, job: Job) {
    const { seq, kind } = job.event;
    const { signal } = job.abort;

    let brief: Brief;
    try {
      brief = await deps.writeBriefFor(instanceId, job.event, signal);
    } catch (err) {
      brief = { ok: false, reason: reasonOf(err) };
    }
    if (!isCurrent(instanceId, job)) return;
    if (!brief.ok) {
      publish(instanceId, job, { seq, kind, status: "failed", reason: brief.reason });
      return;
    }

    const { text, language } = brief;
    const ready = { seq, kind, status: "ready", text, language } as const;
    const server = deps.loadSpeechServer();
    if (!server.url.trim()) {
      publish(instanceId, job, { ...ready, audio: "unavailable", voiceReason: NO_SERVER_REASON });
      return;
    }
    publish(instanceId, job, { ...ready, audio: "pending" });

    let spoken: SynthesizeResult;
    try {
      spoken = await deps.synthesize(server, text, language, { signal });
    } catch (err) {
      spoken = { ok: false, reason: reasonOf(err) };
    }
    if (!isCurrent(instanceId, job)) return;
    if (spoken.ok) {
      // The server speaks about 10 dB under ordinary speech (T-515).
      job.wav = normalizeLoudness(spoken.wav);
      publish(instanceId, job, { ...ready, audio: "ready" });
    } else {
      publish(instanceId, job, { ...ready, audio: "unavailable", voiceReason: spoken.reason });
    }
  }

  async function reply(instanceId: string, seq: number, text: string): Promise<void> {
    const job = jobs.get(instanceId);
    const said = text.trim();
    if (!job || job.event.seq !== seq || !said) return;
    const zh = /[\u3400-\u9fff]/.test(said);
    const { signal } = job.abort;
    const say = (line: readonly [string, string]) => (zh ? line[0] : line[1]);
    const busy = job.exchanges.some((e) => !e.outcome);
    const exchange: SecretaryExchange = { reply: said };
    job.exchanges.push(exchange);
    publish(instanceId, job, job.state);

    const settle = (
      outcome: NonNullable<SecretaryExchange["outcome"]>,
      response: string,
      detail?: string
    ) => {
      exchange.outcome = outcome;
      exchange.response = response;
      if (detail) exchange.detail = detail;
      if (isCurrent(instanceId, job)) publish(instanceId, job, job.state);
    };

    if (busy) return settle("refused", say(SAY.busy));
    if (job.handled) return settle("refused", say(SAY.answered));
    const { dialog } = job;
    if (!dialog) return settle("refused", say(SAY.unsupported));

    // The answer to "to confirm: …?" is read here, not by the model.
    const confirming = job.confirming;
    job.confirming = undefined;
    if (confirming && isPlainYes(said)) {
      return press(checkChoice(dialog, confirming.choice, true), confirming.message);
    }

    const earlier = job.exchanges
      .filter((e) => e !== exchange && (e.outcome === "asked" || e.outcome === "answered"))
      .map((e) => ({ builder: e.reply, secretary: e.response ?? "" }));
    const brief = job.state.status === "ready" ? job.state.text : "";
    let read: Interpretation;
    try {
      read = await deps.interpretReply({ dialog, brief, earlier, reply: said }, signal);
    } catch (err) {
      read = { ok: false, reason: reasonOf(err) };
    }
    if (!isCurrent(instanceId, job)) return;
    if (!read.ok) return settle("failed", say(SAY.failed), read.reason);
    if (job.handled) return settle("refused", say(SAY.answeredMeanwhile));
    if (read.action !== "choose") {
      return settle(read.action === "ask" ? "asked" : "answered", read.message);
    }

    const checked = checkChoice(dialog, read.choice);
    if (!checked.ok && "ask" in checked) {
      if (checked.ask === "confirm-always" || checked.ask === "confirm-auto") {
        job.confirming = { choice: read.choice, message: read.message };
      }
      return settle("asked", say(ASK_BACK[checked.ask]));
    }
    return press(checked, read.message);

    // The keys of a checked choice, and what the card says after.
    async function press(checked: Checked, message: string): Promise<void> {
      if (!checked.ok) {
        if ("ask" in checked) return settle("asked", say(ASK_BACK[checked.ask]));
        return settle("refused", say(checked.refuse === "unsupported" ? SAY.unsupported : SAY.badChoice));
      }
      let outcome: AnswerOutcome;
      try {
        outcome = await deps.answerDialog(instanceId, seq, checked.plan, signal);
      } catch {
        outcome = { ok: false, reason: "stopped" };
      }
      if (!outcome.ok) {
        const why = {
          answered: SAY.answeredMeanwhile,
          changed: SAY.changed,
          interrupted: SAY.interrupted,
          stopped: SAY.stopped,
        };
        return settle("refused", say(why[outcome.reason]));
      }
      let response = message;
      if (checked.plan.expect && outcome.recorded) {
        const off = answerMismatches(checked.plan.expect, outcome.recorded.toolInput);
        if (off.length) response = `${response} ${mismatchNote(zh, off)}`;
      }
      settle("pressed", response);
    }
  }

  const onEvent: SecretaryEventListener = (instanceId, event) => {
    if (!on) return;
    if (event) prepare(instanceId, event);
    else markHandled(instanceId);
  };

  const setMode = (enabled: boolean) => {
    if (enabled === on) return;
    on = enabled;
    deps.send(MODE_CHANNEL, on);
    if (on) {
      for (const { instanceId, event } of deps.liveSecretaryEvents()) {
        prepare(instanceId, event);
      }
    } else {
      for (const instanceId of jobs.keys()) drop(instanceId);
    }
  };

  return {
    start(enabled) {
      if (unsubscribe) return;
      unsubscribe = deps.onSecretaryEvent(onEvent);
      setMode(enabled);
    },
    setMode,
    isOn: () => on,
    briefs() {
      const all: Record<string, SecretaryBriefState> = {};
      for (const [instanceId, job] of jobs) all[instanceId] = job.state;
      return all;
    },
    audioFor(instanceId, seq) {
      const job = jobs.get(instanceId);
      if (!job || job.event.seq !== seq) return null;
      return job.wav ?? null;
    },
    forget: drop,
    reply: (instanceId, seq, text) =>
      reply(instanceId, seq, text).catch(() => {
        // reply() catches the interpreter and the key writer itself; nothing else
        // in it throws. A reply must never reject into the IPC handler.
      }),
    stop() {
      unsubscribe?.();
      unsubscribe = null;
      on = false;
      for (const instanceId of jobs.keys()) drop(instanceId);
    },
  };
}

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sendToRenderer(channel: string, ...args: unknown[]) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, ...args);
  }
}

// The app's secretary, on the real modules. main/index.ts starts it with the
// saved mode; the secretary:* IPC handlers drive it.
export const secretary = createSecretary({
  onSecretaryEvent: (listener) => processManager.onSecretaryEvent(listener),
  liveSecretaryEvents: () => processManager.liveSecretaryEvents(),
  writeBriefFor,
  loadSpeechServer,
  synthesize,
  send: sendToRenderer,
  dialogFor: (instanceId, event) =>
    dialogOf(event, processManager.backendOf(instanceId) ?? "claude"),
  interpretReply: (input, signal) => interpretReply(input, { signal }),
  answerDialog: (instanceId, seq, plan, signal) =>
    processManager.answerDialog(instanceId, seq, plan, signal),
});
