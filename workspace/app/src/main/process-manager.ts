import * as pty from "node-pty";
import { BrowserWindow } from "electron";
import path from "path";
import crypto from "crypto";
import { loadContacts, saveContacts } from "./store";
import type { SavedContact } from "./store";
import { shellManager } from "./shell-manager";
import { getBackend } from "./backends";
import type {
  AlertDelivery,
  AlertsDegradedReason,
  AnswerResult,
  Backend,
  BackendName,
  DialogRef,
  HookAttention,
  PromptToolCall,
  RecentTurns,
  SessionDiscovery,
  SessionStart,
  SpawnOptions,
} from "./backends";
import type { PromptDetail } from "./remote/promptExtract";
import { remoteServer } from "./remote/ws-server";
import type { ContextUsage } from "../shared/types";
import { moveInOrder } from "../shared/reorder";
import { OPENCODE_VIEW_KEYS } from "../shared/replyStart";
import type { OpencodeViewCommand } from "../shared/replyStart";
import { debugTrace } from "./debug-trace";
import { RunStateTracker, type RunState } from "./run-state";
import { INSTANCE_ENV, SPAWN_ENV } from "./backends/instance-env";
import { KEY_GAP_MS } from "./secretary/dialog";
import type { AnswerPlan } from "./secretary/dialog";

export interface InstanceInfo {
  id: string;
  cwd: string;
  alias?: string;
  status: "running" | "stopped";
  startedAt: number;
  name: string;
  sessionId?: string;
  backend: BackendName;
  contextUsage?: ContextUsage;
  lastActivityAt?: number;
  // Only meaningful while running; `status` already says stopped.
  runState?: RunState;
  // A turn is running and nothing waits on the builder, from the agent's own
  // reports (AttentionContext.onWorking). Only while running. Display only: the
  // contact list's avatar moves, and a paired phone lists it as Working.
  working?: boolean;
  // When `working` last became true; with it.
  workingSince?: number;
  // This instance's hooks aren't reaching Multi-Code, so it raises no alerts (PRD
  // Story 6). The renderer shows a bar on its page.
  alertsDegraded?: boolean;
  alertsDegradedReason?: AlertsDegradedReason;
  // Why the last start launched nothing (SpawnConfig.refusal).
  startError?: string;
}

/**
 * The latest Finished or Needs-you a Claude instance raised that nobody has dealt
 * with yet: what the voice secretary writes its brief from, and what it checks
 * before answering (docs/specs/voice-secretary/prd.md, Stories 2 and 6).
 *
 * `seq` is unique per event and only ever grows, across instance restarts and app
 * launches too (it follows the clock), so "is this still the event I was working
 * on" is one comparison, and a paired phone's answer naming a dialog from before a
 * relaunch can't name a new one (remote-protocol.ts, PromptStateFrame).
 * `prompt` is there when the dialog decoded into options: the detail the phone
 * would show, plus the tool call exactly as the agent sent it (for a Bash
 * permission, `toolInput.command` is the command). Read-only for consumers.
 */
export interface SecretaryEvent {
  kind: "finished" | "needs-you";
  seq: number;
  at: number;
  // `dialog` when the backend answers this dialog through its API (OpenCode).
  prompt?: { detail: PromptDetail; toolName: string; toolInput: unknown; dialog?: DialogRef };
  // A needs-you for a dialog reported before, blocking the contact again
  // (ActivityCallback's `restated`). It is the live dialog, under a new seq, but the
  // builder has been told about it once: a paired phone gets no second push for it.
  restated?: true;
}

// `event` is the instance's new live event, or null when it was cleared.
export type SecretaryEventListener = (
  instanceId: string,
  event: SecretaryEvent | null
) => void;

// Whether a write carries anything besides terminal focus reports and mouse motion
// or wheel reports. Claude turns on focus reporting (`?1004h`,
// docs/timeline/2026-06-08_compose-box-ideation.md), so xterm sends `ESC [ I` /
// `ESC [ O` down the same channel as keystrokes whenever its terminal gains or loses
// focus, including when the builder comes back to the window. It also turns on
// any-motion mouse tracking in SGR form (`?1003h`, `?1006h`, CLI 2.1.292), so the
// pointer merely crossing the terminal sends `ESC [ < Cb ; x ; y M` with Cb's
// motion bit (32) set, and the wheel sends Cb 64 and up. None of those are the
// builder acting on the session. A button press or release still counts: a click
// can pick something in the TUI.
const ESC = "\x1b";
const SGR_MOUSE_REPORT = new RegExp(`${ESC}\\[<(\\d+);\\d+;\\d+[Mm]`, "g");
const MOUSE_MOTION_OR_WHEEL = 32 | 64;

function carriesInput(data: string): boolean {
  return (
    data
      .replaceAll("\x1b[I", "")
      .replaceAll("\x1b[O", "")
      .replace(SGR_MOUSE_REPORT, (report, cb: string) =>
        Number(cb) & MOUSE_MOTION_OR_WHEEL ? "" : report
      ) !== ""
  );
}

interface ManagedInstance {
  id: string;
  cwd: string;
  alias?: string;
  status: "running" | "stopped";
  startedAt: number;
  ptyProcess: pty.IPty | null;
  sessionId?: string;
  backend: BackendName;
  discovery: SessionDiscovery | null;
  // Turns what the agent reports about itself (Claude's hooks, OpenCode's plugin)
  // into its activity. Null while stopped.
  hookAttention: HookAttention | null;
  // See InstanceInfo.working and workingSince. Reset when the process exits.
  working?: boolean;
  workingSince?: number;
  // The PTY's size, as last set: what a paired phone's terminal is drawn at.
  cols: number;
  rows: number;
  // The terminal shows no session (AttentionContext.onHomeShown), so the contact
  // shows no context figure: the one it had is the session it left. Cleared when
  // it shows a session again, and when the process exits.
  homeShown?: boolean;
  // Cached context usage plus when it was read. Optional so the two places that
  // build a ManagedInstance don't need to seed them; absent means "never read".
  contextUsage?: ContextUsage;
  contextUsageAt?: number;
  // When this instance last reported activity (a turn ending, or blocking on a
  // prompt), not every repaint of the spinner. Absent until the first activity.
  lastActivityAt?: number;
  // The session whose turn last ended, when the backend says (OpenCode). Its terminal
  // can be showing another of the contact's sessions by then.
  endedSession?: string;
  // A session id found on disk for this cwd, for instances that don't have a live
  // one. Read paths only.
  //
  // **Deliberately not merged into `sessionId`.** `spawnProcess`'s
  // `isSessionClaimed` treats any instance holding a session id as that session's
  // owner, so a stopped contact pre-filled from disk would veto discovery for a
  // *running* instance in the same directory — and this user has exactly that shape,
  // two contacts on the same repo. Keeping it separate means discovery cannot see
  // it at all.
  resolvedSessionId?: string;
  // When the lookup ran, so a directory with no history isn't rescanned on every
  // list call. Set even when nothing was found.
  resolvedSessionIdAt?: number;
  // The session this contact last worked in, saved in contacts.json and opened
  // again on its next start. Unlike `resolvedSessionId` it is this contact's and
  // nobody else's, so it counts as a claim (isSessionClaimedBy) even while the
  // contact is stopped: no other contact in the directory may adopt it.
  ownSessionId?: string;
  // What it is doing right now; see run-state.ts.
  runState: RunStateTracker;
  // Its hooks don't run, so nothing will alert for it. Per process: a restart
  // builds a fresh instance and starts out trusting its hooks again.
  alertsDegraded?: boolean;
  alertsDegradedReason?: AlertsDegradedReason;
  // See InstanceInfo.startError.
  startError?: string;
  // Minted per spawn and handed to the agent's hooks (SPAWN_ENV), so a late
  // delivery from the process a restart replaced can be told apart. Absent on a
  // contact that has never been spawned in this run.
  spawnId?: string;
  // See SecretaryEvent. Never set on a backend that doesn't keep them; cleared when
  // the builder deals with it, and on exit.
  secretaryEvent?: SecretaryEvent;
  // Waiting for the agent's own report that its dialog cleared, with the call that
  // report carried: answerDialog checks a question box's recorded answers with it.
  // Called with nothing when the process goes.
  dialogClearWaiters?: ((toolCall?: PromptToolCall) => void)[];
  // Writes that carried input, from anyone. answerDialog stops when one lands
  // between its own keys: the builder typed in the terminal, or the phone answered.
  inputWrites?: number;
  // How many answerDialog calls are writing their keys now (isAnswering).
  answering?: number;
}

// What answerDialog did. `answered`: the event it was asked about isn't the live
// one any more, or the CLI said its dialog was already answered, so nothing was
// written. `changed`: a new dialog came up while the keys were going in, and the rest
// weren't written. `interrupted`: someone else's input landed between its keys, and
// the rest weren't written. `stopped`: the process went, or the caller called it off.
// `failed`: an answer through the CLI's API didn't go through (the CLI couldn't be
// reached or refused it, or the event names no dialog to answer); it may or may not
// have landed, so the builder should look.
export type AnswerOutcome =
  | { ok: true; recorded?: PromptToolCall }
  | { ok: false; reason: "answered" | "changed" | "interrupted" | "stopped" | "failed" };

export interface AnswerTiming {
  keyGapMs: number;
  // After the keys, before a denial's reason goes in as a prompt. The CLI is idle
  // 41 ms after a denial (T-509 spike); the prompt would queue even if it weren't.
  followUpDelayMs: number;
  // How long to wait for a question box's PostToolUse, which carries its answers,
  // counted from the last key.
  clearWaitMs: number;
  // How old the dialog must be before its first key. Claude's plan box drops keys
  // for a moment after its PermissionRequest hook: on 2.1.312 an approve written 40
  // and 100 ms after the hook was lost (the box stayed up, while our key had cleared
  // the event, so the desk and the phone called the session idle), one at 250 ms was
  // taken; a permission box took one at 40 ms (T-813). A phone can answer that fast.
  dialogSettleMs?: number;
}

const ANSWER_TIMING: AnswerTiming = {
  keyGapMs: KEY_GAP_MS,
  followUpDelayMs: 600,
  clearWaitMs: 5000,
  dialogSettleMs: 500,
};

// Reading context usage parses a transcript that reaches 8MB+, and
// listInstances() runs on every phone broadcast, so the read is throttled
// instead of happening per call. A turn takes far longer than this to complete,
// so nothing user-visible lags behind.
const CONTEXT_USAGE_TTL_MS = 20_000;

// After a finished turn whose read still found the old figure, how long to wait
// before each further read. The CLI writes its transcript behind its hooks: a
// manual `/compact`'s PostCompact arrived 11ms after its compact_boundary row's own
// timestamp, yet the read made then found the pre-compaction 26k, and the same file
// read later 6k (measured 2026-10-22, CLI 2.1.308). Without a re-read the old
// figure stood until the TTL and the renderer's next poll, over a minute with the
// window in the background.
const CONTEXT_REREAD_MS = [1000, 5000];

function sameUsage(a: ContextUsage | undefined, b: ContextUsage | undefined): boolean {
  return a?.inputTokens === b?.inputTokens && a?.updatedAt === b?.updatedAt;
}

const DEFAULT_BACKEND: BackendName = "claude";

// The size every PTY starts at, until the desktop's terminal fits it.
const SPAWN_COLS = 120;
const SPAWN_ROWS = 30;

// How long a disk-resolved session id is trusted before looking again. Long,
// because it only changes when a session is created or resumed in that directory,
// and the lookup reads a directory listing or queries sqlite.
const RESOLVED_SESSION_TTL_MS = 60_000;

// How often a running instance is re-checked against the CLI's own idea of which
// session it is on. `/new` and `/clear` move a process to a fresh transcript, and
// until we follow it the instance is reading a file nobody writes to any more.
//
// Four seconds because the cost is one small file read per running instance and
// the consequence of lagging is a missed completion notification. Not tied to the
// context-usage TTL (20s), which only affects a number on screen.
const LIVE_SESSION_POLL_MS = 4000;

export class ProcessManager {
  private instances = new Map<string, ManagedInstance>();
  private mainWindow: BrowserWindow | null = null;
  private secretaryListeners = new Set<SecretaryEventListener>();
  // One counter for every instance's secretary events. A per-record one would
  // restart at zero when start or restart builds a fresh record, and an old
  // event's seq could then outrank the new spawn's. Each seq is at least the clock
  // in ms, so a relaunch, which takes far longer than a millisecond, starts above
  // every seq the previous launch handed out; nothing keeps them across launches.
  private secretarySeq = 0;
  // What every instance spawns with: the alert hooks' settings file or the TUI
  // plugin. Set from outside, once at startup, after the server the hooks report
  // to is listening (alert-server/index.ts; importing it would close a cycle). Null
  // when it isn't, and sessions then spawn without alert hooks.
  private sessionSpawnOptions: SpawnOptions | null = null;

  private liveSessionTimer: ReturnType<typeof setInterval> | null = null;

  setMainWindow(win: BrowserWindow) {
    this.mainWindow = win;
    this.startLiveSessionPolling();
  }

  // Follows each running instance's current session. Started here rather than in a
  // constructor so tests that import this module don't get a timer they never asked
  // for, and so it exists for exactly as long as there is a window to report to.
  private startLiveSessionPolling() {
    if (this.liveSessionTimer) return;
    this.liveSessionTimer = setInterval(() => {
      for (const instance of this.instances.values()) {
        this.syncLiveSessionId(instance);
      }
    }, LIVE_SESSION_POLL_MS);
    // Nothing here should hold the process open at shutdown.
    this.liveSessionTimer.unref?.();
  }

  // Adopt the session the running process actually has, if it has moved.
  //
  // The visible symptom of not doing this is a context percentage frozen at the
  // previous session's figure, which is how it was reported. The transcript a
  // paired phone reads would be the old one too.
  private syncLiveSessionId(instance: ManagedInstance) {
    const ptyProcess = instance.ptyProcess;
    // A stopped instance has no live session to follow; its read paths already
    // fall back to its own session, or whatever this directory last worked on.
    if (!ptyProcess) return;

    let live: string | null;
    try {
      live = getBackend(instance.backend).findLiveSessionId(
        instance.cwd,
        ptyProcess.pid,
        instance.startedAt
      );
    } catch {
      // Registry unreadable or mid-write. Nothing to do but try again next tick.
      return;
    }

    if (!live || live === instance.sessionId) return;
    // Another instance already owns this id. Both reading one transcript would
    // have them both report its turns, and at least one of them would be lying.
    if (this.isSessionClaimedBy(live, instance.id)) return;

    debugTrace(
      `[session-moved] ${instance.id.slice(0, 8)} ${instance.sessionId ?? "none"} -> ${live} at ${new Date().toISOString()}`
    );
    this.attachSession(instance, live);
  }

  // Whether any *other* instance is already reading this session, or has it as
  // its own to go back to.
  private isSessionClaimedBy(sessionId: string, exceptId: string): boolean {
    for (const other of this.instances.values()) {
      if (other.id === exceptId) continue;
      if (other.sessionId === sessionId || other.ownSessionId === sessionId) return true;
    }
    return false;
  }

  // The conversation a contact's next spawn opens: its own when it has one on
  // record. Otherwise the directory's most recent, unless that one is another
  // contact's, as it is for the first start after a contact on the same project
  // was duplicated. Then a fresh one, or the two would share it.
  private sessionStartFor(
    id: string,
    cwd: string,
    backend: BackendName,
    ownSessionId?: string
  ): SessionStart {
    if (ownSessionId) return { kind: "own", sessionId: ownSessionId };
    const isClaimed = (sessionId: string) => this.isSessionClaimedBy(sessionId, id);
    const impl = getBackend(backend);
    if (impl.picksLatestSession) return { kind: "latest", isClaimed };
    let latest: string | null = null;
    try {
      latest = impl.findLatestSessionId(cwd);
    } catch {
      // Unreadable: --continue is what every start did before.
    }
    if (latest && isClaimed(latest)) return { kind: "fresh" };
    return { kind: "latest", isClaimed };
  }

  setSessionSpawnOptions(opts: SpawnOptions | null) {
    this.sessionSpawnOptions = opts;
  }

  // Subscribe to secretary events, returning an unsubscribe function. Fires with
  // the new event when one is set (a newer one replaces the old, with a higher
  // seq), and with null when the live one is cleared.
  onSecretaryEvent(listener: SecretaryEventListener): () => void {
    this.secretaryListeners.add(listener);
    return () => {
      this.secretaryListeners.delete(listener);
    };
  }

  // The instance's live secretary event, if it has one.
  secretaryEventOf(id: string): SecretaryEvent | undefined {
    return this.instances.get(id)?.secretaryEvent;
  }

  backendOf(id: string): BackendName | undefined {
    return this.instances.get(id)?.backend;
  }

  // Write the keys of the secretary's answer to a dialog (voice-secretary T-509),
  // only while `seq` is still the instance's live needs-you: the builder may have
  // answered in the terminal or on the phone while the reply was being read. Keys go
  // in one at a time, `keyGapMs` apart, the way they were measured, and stop if a new
  // dialog comes up in between. A plan's `followUp` goes in as an ordinary prompt
  // once the dialog is gone. For a question box, resolves with the call the CLI
  // reported when the box cleared, which holds its record of the answers. Aborting
  // `signal` (the brief was replaced, or Secretary Mode went off) stops the rest.
  //
  // A plan with an `answer` (OpenCode, opencode-v2 T-607) writes no keys: the answer
  // goes once through the CLI's API to the request the event names, after the same
  // checks. It names the request by id, so unlike a key it can't land in a dialog
  // that came up meanwhile; the CLI says `gone` when the builder got there first.
  async answerDialog(
    id: string,
    seq: number,
    plan: AnswerPlan,
    signal?: AbortSignal,
    timing: AnswerTiming = ANSWER_TIMING
  ): Promise<AnswerOutcome> {
    const instance = this.instances.get(id);
    const ptyProcess = instance?.ptyProcess;
    if (!instance || !ptyProcess || signal?.aborted) return { ok: false, reason: "stopped" };
    const event = instance.secretaryEvent;
    if (event?.kind !== "needs-you" || event.seq !== seq) return { ok: false, reason: "answered" };

    if (plan.answer) {
      const ref = event.prompt?.dialog;
      const attention = instance.hookAttention;
      if (!ref || ref.kind !== plan.answer.kind || !attention?.answer) {
        return { ok: false, reason: "failed" };
      }
      let result: AnswerResult;
      try {
        result = await attention.answer(ref, plan.answer);
      } catch {
        result = { ok: false, reason: "failed" };
      }
      if (!result.ok) return { ok: false, reason: result.reason === "gone" ? "answered" : "failed" };
      return { ok: true };
    }

    const same = () => this.instances.get(id) === instance && instance.ptyProcess === ptyProcess;
    const settle = (timing.dialogSettleMs ?? 0) - (Date.now() - event.at);
    if (settle > 0) {
      await delay(settle);
      if (!same() || signal?.aborted) return { ok: false, reason: "stopped" };
      // Answered at the desk, typed into, or replaced while we waited.
      if (instance.secretaryEvent !== event) return { ok: false, reason: "answered" };
    }
    // Registered before the first key, so a box that clears at once isn't missed.
    const record = plan.expect ? this.waitForAnswerRecord(instance) : undefined;
    let mine = 0;
    // Before each key after the first, and before a follow-up. Our own first key
    // clears the event, so any needs-you after it is a new dialog.
    const stillOurs = (): AnswerOutcome | null => {
      if (!same() || signal?.aborted) return { ok: false, reason: "stopped" };
      if (instance.secretaryEvent?.kind === "needs-you") return { ok: false, reason: "changed" };
      if ((instance.inputWrites ?? 0) !== mine) return { ok: false, reason: "interrupted" };
      return null;
    };

    // The dialog stays open until the last key, though the first one cleared its
    // event: a paired phone's compose and Stop wait until then (isAnswering).
    instance.answering = (instance.answering ?? 0) + 1;
    try {
      for (const [i, key] of plan.keys.entries()) {
        if (i > 0) {
          await delay(timing.keyGapMs);
          const stop = stillOurs();
          if (stop) {
            record?.cancel();
            return stop;
          }
        }
        this.noteWrite(instance, key);
        ptyProcess.write(key);
        mine = instance.inputWrites ?? 0;
      }
    } finally {
      instance.answering -= 1;
    }

    if (plan.followUp) {
      await delay(timing.followUpDelayMs);
      const stop = stillOurs();
      if (stop) return stop;
      this.sendPrompt(id, plan.followUp);
    }
    if (!record) return { ok: true };
    const recorded = await record.wait(timing.clearWaitMs);
    if (!same()) return { ok: false, reason: "stopped" };
    return { ok: true, recorded };
  }

  // Whether Stop's keys would stop a turn now (HookAttention.interruptTarget): for
  // OpenCode, its terminal shows the running session; Claude's shows only its own.
  canInterrupt(id: string): boolean {
    const attention = this.instances.get(id)?.hookAttention;
    return !attention?.interruptTarget || attention.interruptTarget() !== undefined;
  }

  // Whether answerDialog is writing a dialog's keys to this instance now. Its first
  // key clears the needs-you event while the dialog is still on screen, so text or an
  // Esc written meanwhile would land in the dialog.
  isAnswering(id: string): boolean {
    return (this.instances.get(id)?.answering ?? 0) > 0;
  }

  // Whether the agent says a dialog is on its screen (HookAttention.dialogOnScreen),
  // with or without the needs-you event that a keystroke into it drops.
  dialogOnScreen(id: string): boolean {
    const instance = this.instances.get(id);
    return !!instance?.ptyProcess && instance.hookAttention?.dialogOnScreen?.() === true;
  }

  // The agent's report that a question box cleared with its answers: a clearing whose
  // call has `answers`, so an unrelated tool finishing meanwhile (a subagent's Bash)
  // isn't taken for it. The timer starts only once every key is in; the process
  // going ends the wait at once.
  private waitForAnswerRecord(instance: ManagedInstance): {
    wait(timeoutMs: number): Promise<PromptToolCall | undefined>;
    cancel(): void;
  } {
    const waiters = (instance.dialogClearWaiters ??= []);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settle: (call?: PromptToolCall) => void = () => {};
    const settled = new Promise<PromptToolCall | undefined>((resolve) => {
      settle = resolve;
    });
    const finish = (call?: PromptToolCall) => {
      if (timer) clearTimeout(timer);
      const i = waiters.indexOf(onClear);
      if (i >= 0) waiters.splice(i, 1);
      settle(call);
    };
    const onClear = (call?: PromptToolCall) => {
      if (!call) return finish(undefined);
      const input = call.toolInput as { answers?: unknown } | null | undefined;
      if (typeof input?.answers === "object" && input.answers !== null) finish(call);
    };
    waiters.push(onClear);
    return {
      wait(timeoutMs) {
        timer = setTimeout(() => finish(undefined), timeoutMs);
        return settled;
      },
      cancel: () => finish(undefined),
    };
  }

  // What the secretary's brief writer reads for an instance: the name the builder
  // knows it by, the backend whose session it reads, and the session it is on now. The live session is re-checked
  // first rather than waiting for the next poll, so a turn that ends within
  // seconds of a `/clear` is read from the new transcript, not the abandoned one.
  // Null for an id that isn't an instance.
  secretarySource(
    id: string
  ): { name: string; backend: BackendName; sessionId?: string } | null {
    const instance = this.instances.get(id);
    if (!instance) return null;
    this.syncLiveSessionId(instance);
    return {
      name: instance.alias || path.basename(instance.cwd),
      backend: instance.backend,
      sessionId: this.readableSessionId(instance),
    };
  }

  // Every live secretary event, for a consumer starting up with events already
  // pending (Secretary Mode turned on while red dots show).
  liveSecretaryEvents(): { instanceId: string; event: SecretaryEvent }[] {
    const live: { instanceId: string; event: SecretaryEvent }[] = [];
    for (const instance of this.instances.values()) {
      if (instance.secretaryEvent) {
        live.push({ instanceId: instance.id, event: instance.secretaryEvent });
      }
    }
    return live;
  }

  // Set from the agent's own report. Called for every activity; only `waiting`
  // and `prompt` set an event, and `prompt-cleared` clears a needs-you (the
  // dialog was answered). Writes and exit clear through clearSecretaryEvent.
  private updateSecretaryEvent(
    instance: ManagedInstance,
    type: string,
    detail?: PromptDetail,
    toolCall?: PromptToolCall,
    restated = false
  ) {
    if (type === "prompt-cleared") {
      if (instance.secretaryEvent?.kind === "needs-you") {
        this.clearSecretaryEvent(instance);
      }
      return;
    }
    if (type !== "waiting" && type !== "prompt") return;
    // The backend says whether its instances keep secretary events.
    if (!getBackend(instance.backend).keepsSecretaryEvents) {
      return;
    }
    // A record a restart has replaced reports nothing any more.
    if (this.instances.get(instance.id) !== instance) return;

    const at = Date.now();
    const seq = (this.secretarySeq = Math.max(this.secretarySeq + 1, at));
    const event: SecretaryEvent =
      type === "waiting"
        ? { kind: "finished", seq, at }
        : {
            kind: "needs-you",
            seq,
            at,
            ...(detail && toolCall
              ? {
                  prompt: {
                    detail,
                    toolName: toolCall.toolName,
                    toolInput: toolCall.toolInput,
                    ...(toolCall.dialog ? { dialog: toolCall.dialog } : {}),
                  },
                }
              : {}),
            ...(restated ? { restated: true as const } : {}),
          };
    instance.secretaryEvent = event;
    this.emitSecretaryEvent(instance.id, event);
  }

  // Drop the live event, if any. Listeners hear about it only while this record
  // is still the instance's current one: the process a restart replaced exits
  // after the new one is up, and a null from it would wipe the new spawn's event.
  private clearSecretaryEvent(instance: ManagedInstance) {
    if (!instance.secretaryEvent) return;
    instance.secretaryEvent = undefined;
    if (this.instances.get(instance.id) === instance) {
      this.emitSecretaryEvent(instance.id, null);
    }
  }

  private emitSecretaryEvent(id: string, event: SecretaryEvent | null) {
    for (const listener of this.secretaryListeners) {
      try {
        listener(id, event);
      } catch {
        // Same as activity: one broken consumer must not break the report path.
      }
    }
  }

  // Every write to an instance's pty goes through here first, whoever sent it:
  // keys at the desk, the compose box, a paired phone. Any of them means the
  // session's pending event has been dealt with, a needs-you included: the CLI
  // reports nothing at all when a dialog is denied (fixtures permission-denied-no,
  // permission-denied-esc), so the keystroke is the only sign. Focus reports alone
  // don't count; see carriesInput.
  private noteWrite(instance: ManagedInstance, data: string) {
    instance.runState.onWrite();
    if (carriesInput(data)) {
      this.clearSecretaryEvent(instance);
      instance.inputWrites = (instance.inputWrites ?? 0) + 1;
    }
  }

  loadSavedContacts(): InstanceInfo[] {
    const saved = loadContacts();
    // Whatever a backend's first spawn needs, prepared before anyone presses start.
    for (const name of new Set(saved.map((c) => c.backend ?? DEFAULT_BACKEND))) {
      try {
        getBackend(name).warm?.();
      } catch {
        // Only a head start: the spawn prepares it itself if this failed.
      }
    }
    for (const contact of saved) {
      if (!this.instances.has(contact.id)) {
        this.instances.set(contact.id, {
          id: contact.id,
          cwd: contact.cwd,
          alias: contact.alias,
          ownSessionId: contact.sessionId,
          status: "stopped",
          startedAt: 0,
          ptyProcess: null,
          cols: SPAWN_COLS,
          rows: SPAWN_ROWS,
          backend: contact.backend ?? DEFAULT_BACKEND,
          discovery: null,
          hookAttention: null,
          runState: new RunStateTracker(),
        });
      }
    }
    return this.listInstances();
  }

  // Apply one drag: put `dragId` immediately before or after `targetId`.
  //
  // **Takes the move, not the resulting order, on purpose.** An earlier version
  // accepted the renderer's complete list, reasoning that it should match what the
  // user saw. It has the opposite effect: a renderer whose list is stale — it missed
  // an instance, or holds an older order — would overwrite the stored order wholesale
  // with its own, silently reshuffling rows nobody dragged. A move is applied against
  // the order that is actually stored, so the worst a stale renderer can do is land
  // one row next to the wrong neighbour.
  //
  // The Map's insertion order is what listInstances and persist both walk, so applying
  // the move means rebuilding it.
  moveInstance(
    dragId: string,
    targetId: string,
    placeBefore: boolean
  ): InstanceInfo[] {
    const current = [...this.instances.keys()];
    const next = moveInOrder(current, dragId, targetId, placeBefore);
    // Same array back means nothing moved — no write, no broadcast.
    if (next === current) return this.listInstances();

    const rebuilt = new Map<string, ManagedInstance>();
    for (const id of next) {
      const instance = this.instances.get(id);
      if (instance) rebuilt.set(id, instance);
    }
    this.instances = rebuilt;
    this.persist();
    remoteServer.broadcastInstances();
    return this.listInstances();
  }

  private persist() {
    const contacts: SavedContact[] = Array.from(this.instances.values()).map(
      (i) => ({
        id: i.id,
        cwd: i.cwd,
        alias: i.alias,
        backend: i.backend,
        sessionId: i.ownSessionId,
      })
    );
    saveContacts(contacts);
  }

  createInstance(
    cwd: string,
    alias?: string,
    backend: BackendName = DEFAULT_BACKEND
  ): InstanceInfo {
    const id = crypto.randomUUID();
    const instance = this.spawnProcess(
      id,
      cwd,
      alias,
      backend,
      this.sessionStartFor(id, cwd, backend)
    );
    this.instances.set(id, instance);
    this.persist();
    remoteServer.broadcastInstances();
    return this.toInfo(instance);
  }

  // A second contact on the same project and backend, running a fresh session of
  // its own, placed right below the one it came from. Nothing of the original's
  // conversation comes along.
  duplicateInstance(sourceId: string): InstanceInfo | null {
    const source = this.instances.get(sourceId);
    if (!source) return null;

    const id = crypto.randomUUID();
    const instance = this.spawnProcess(
      id,
      source.cwd,
      this.duplicateAlias(source),
      source.backend,
      { kind: "fresh" }
    );
    const rebuilt = new Map<string, ManagedInstance>();
    for (const [key, value] of this.instances) {
      rebuilt.set(key, value);
      if (key === sourceId) rebuilt.set(id, instance);
    }
    this.instances = rebuilt;
    this.persist();
    remoteServer.broadcastInstances();
    return this.toInfo(instance);
  }

  // "HRR" gives "HRR 2", then "HRR 3": the first number no contact is named with.
  // Duplicating "HRR 2" counts on from "HRR", not "HRR 2 2".
  private duplicateAlias(source: ManagedInstance): string {
    const name = source.alias || path.basename(source.cwd);
    const base = name.replace(/ \d+$/, "") || name;
    const taken = new Set(
      [...this.instances.values()].map((i) => i.alias || path.basename(i.cwd))
    );
    let n = 2;
    while (taken.has(`${base} ${n}`)) n++;
    return `${base} ${n}`;
  }

  startInstance(id: string): InstanceInfo | null {
    const instance = this.instances.get(id);
    if (!instance) return null;
    if (instance.status === "running") return this.toInfo(instance);

    const started = this.spawnProcess(
      id,
      instance.cwd,
      instance.alias,
      instance.backend,
      this.sessionStartFor(id, instance.cwd, instance.backend, instance.ownSessionId)
    );
    this.instances.set(id, started);
    if (started.ownSessionId !== instance.ownSessionId) this.persist();
    remoteServer.broadcastInstances();
    return this.toInfo(started);
  }

  private spawnProcess(
    id: string,
    cwd: string,
    alias: string | undefined,
    backendName: BackendName,
    session: SessionStart
  ): ManagedInstance {
    const cols = SPAWN_COLS;
    const rows = SPAWN_ROWS;

    const backend: Backend = getBackend(backendName);
    const opts = this.sessionSpawnOptions;
    const spawnedWithoutAlertHooks =
      backendName === "claude" ? !opts?.settingsPath : !opts?.opencodePlugin;
    if (spawnedWithoutAlertHooks) {
      debugTrace(
        `[alert-hook] ${id.slice(0, 8)} spawned without alert hooks (server not listening or files unwritable)`
      );
    }
    const {
      command,
      args,
      env,
      sessionId: openedSessionId,
      refusal,
    } = backend.spawn(cwd, opts ?? undefined, session);

    // The backend won't run this CLI (OpenCode 1.x): nothing is spawned, and the
    // contact stays stopped with the reason on its page. It keeps the session it had,
    // so upgrading and starting again picks the conversation up where it was.
    if (refusal) {
      debugTrace(`[spawn] ${id.slice(0, 8)} refused: ${refusal}`);
      return {
        id,
        cwd,
        alias,
        status: "stopped",
        startedAt: 0,
        ptyProcess: null,
        backend: backendName,
        discovery: null,
        hookAttention: null,
        runState: new RunStateTracker(),
        ownSessionId: session.kind === "own" ? session.sessionId : undefined,
        startError: refusal,
        cols,
        rows,
      };
    }

    const spawnId = crypto.randomUUID();
    const ptyProcess = pty.spawn(command, args, {
      name: "xterm-256color",
      cols,
      rows,
      cwd,
      // Names this instance to its own hooks, which send it back as a header so a
      // delivery lands on the right contact even when two share a cwd. Set here, on
      // this one spawn: every env Multi-Code builds strips an inherited value first.
      env: { ...env, [INSTANCE_ENV]: id, [SPAWN_ENV]: spawnId },
    });

    const instance: ManagedInstance = {
      id,
      cwd,
      alias,
      status: "running",
      startedAt: Date.now(),
      ptyProcess,
      backend: backendName,
      discovery: null,
      hookAttention: null,
      runState: new RunStateTracker(),
      cols,
      rows,
      alertsDegraded: spawnedWithoutAlertHooks || undefined,
      alertsDegradedReason: spawnedWithoutAlertHooks
        ? backendName === "claude" ? "hooks" : "plugin"
        : undefined,
      spawnId,
      // Known up front when the backend resumed it or named it. Otherwise
      // discovery finds it, and attachSession records it then.
      sessionId: openedSessionId,
      ownSessionId: openedSessionId,
    };

    // Created at spawn, before any session exists: the hooks report from the
    // process's first moment, and keep reporting across /clear.
    const isSessionClaimed = (candidate: string): boolean =>
      this.isSessionClaimedBy(candidate, id);

    instance.hookAttention = backend.createHookAttention(
      ptyProcess.pid,
      (type, detail, toolCall, restated, endedSession) =>
        this.reportActivity(instance, type, detail, toolCall, restated, endedSession),
      (ok, reason) => this.setAlertsDegraded(instance, !ok, reason),
      {
        instanceId: id,
        sessionId: openedSessionId,
        // The terminal moved to another session (`/new`, `/sessions`). Only while
        // this record is the contact's current one, and never onto a session another
        // contact holds.
        onSessionShown: (sessionId) => {
          if (this.instances.get(id) !== instance) return;
          if (sessionId === instance.sessionId || isSessionClaimed(sessionId)) return;
          debugTrace(
            `[session-moved] ${id.slice(0, 8)} ${instance.sessionId ?? "none"} -> ${sessionId} (shown) at ${new Date().toISOString()}`
          );
          this.attachSession(instance, sessionId);
        },
        // Home hides the figure; any session shown after it brings the contact's
        // back, read now. By then a session the contact took is already attached.
        onHomeShown: (home) => {
          if (this.instances.get(id) !== instance || !!instance.homeShown === home) return;
          instance.homeShown = home || undefined;
          instance.contextUsageAt = undefined;
          if (home) instance.contextUsage = undefined;
          else this.refreshContextUsage(instance);
          this.sendContextUsage(instance);
        },
        onWorking: (working) => {
          if (this.instances.get(id) !== instance || !instance.ptyProcess) return;
          instance.working = working || undefined;
          instance.workingSince = working ? Date.now() : undefined;
          if (this.mainWindow && !this.mainWindow.isDestroyed()) {
            this.mainWindow.webContents.send("instance-working", id, working);
          }
          // A paired phone lists it as Working, or no longer.
          remoteServer.broadcastInstances();
        },
      }
    );

    // Nothing to discover when the backend said which session it opened. A guess
    // here could only be worse: the directory's newest unclaimed transcript.
    instance.discovery = openedSessionId ? null : backend.discoverSessionId(
      cwd,
      (sessionId) => {
        const tracked = this.instances.get(id);
        if (!tracked) return;
        // Final guard: if another instance claimed this id between
        // discovery's check and now, drop this assignment so the next
        // poll picks a different jsonl.
        if (isSessionClaimed(sessionId)) return;
        debugTrace(
          `[discovery] ${id.slice(0, 8)} backend=${tracked.backend} session=${sessionId} at ${new Date().toISOString()}`
        );
        this.attachSession(tracked, sessionId);
      },
      isSessionClaimed
    );

    ptyProcess.onData((data: string) => {
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send("pty-output", id, data);
      }
      // Same bytes to any paired phone mirroring this instance. Also keeps the
      // replay buffer fed, so a phone connecting later sees the current screen.
      remoteServer.broadcastOutput(id, data);
    });

    ptyProcess.onExit(({ exitCode }) => {
      instance.status = "stopped";
      instance.ptyProcess = null;
      instance.runState.onExit();
      // A dead process has no turn to report on.
      instance.working = undefined;
      instance.workingSince = undefined;
      // Stopped, it shows its own session's figure again.
      if (instance.homeShown) {
        instance.homeShown = undefined;
        instance.contextUsageAt = undefined;
      }
      this.clearSecretaryEvent(instance);
      for (const waiter of (instance.dialogClearWaiters ?? []).slice()) waiter(undefined);
      this.teardownObservers(instance);
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send("instance-exit", id, exitCode);
      }
      remoteServer.broadcastExit(id, exitCode);
    });

    return instance;
  }

  // Point every read path at `sessionId`: the transcript, context usage.
  //
  // Called from discovery at spawn, and again whenever a running process moves to
  // a different session. A session id is not stable for the life of a process:
  // `/new` and `/clear` start a fresh transcript under a new id and never write to
  // the old file again (measured 2026-09-17). Activity doesn't depend on it: the
  // agent's own reports are per process.
  private attachSession(instance: ManagedInstance, sessionId: string) {
    const id = instance.id;
    instance.sessionId = sessionId;
    // The one its next start goes back to.
    if (instance.ownSessionId !== sessionId) {
      instance.ownSessionId = sessionId;
      if (this.instances.get(id) === instance) this.persist();
    }
    // The cached usage belongs to the session we just left, and `/new` resets it
    // to zero. Dropping the timestamp too forces the next read instead of showing
    // the old session's figure for up to the TTL.
    instance.contextUsage = undefined;
    instance.contextUsageAt = undefined;
    // Disk-resolved fallbacks are stale for the same reason.
    instance.resolvedSessionId = undefined;
    instance.resolvedSessionIdAt = undefined;

    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send("instance-session-id", id, sessionId);
    }
    // A paired phone's line for it is the new session's (remote-host.ts).
    remoteServer.broadcastInstances();
  }

  // One activity event, from the agent's own reports, to everything that listens:
  // run state, the renderer's chime and red dot, and the secretary's event, which a
  // paired phone follows (remote/remote-host.ts).
  private reportActivity(
    instance: ManagedInstance,
    type: string,
    detail?: PromptDetail,
    toolCall?: PromptToolCall,
    // A dialog reported before, blocking the contact again (ActivityCallback).
    restated = false,
    endedSession?: string
  ) {
    const id = instance.id;
    debugTrace(
      `[activity] ${id.slice(0, 8)} ${type}${restated ? " (restated)" : ""} at ${new Date().toISOString()}`
    );
    instance.runState.onActivity(type);
    // Recorded for every activity except the bookkeeping ones, so a paired phone can
    // say how long a session has been idle (remote-host.ts).
    if (type !== "prompt-cleared" && !restated) instance.lastActivityAt = Date.now();
    // A finished turn is exactly when context usage moved, so refresh now instead
    // of waiting for the TTL. Cheap: once per turn, not per list call.
    if (type === "waiting") {
      this.refreshContextUsageAfterTurn(instance);
      instance.endedSession = endedSession;
    }
    // Before anything else hears of it, so a write made in reaction to this
    // activity clears the event it raised instead of landing before it exists.
    this.updateSecretaryEvent(instance, type, detail, toolCall, restated);
    // Only with a call: a clearing without one isn't the record anybody waits for,
    // and a call-less waiter run means the process went.
    if (type === "prompt-cleared" && toolCall) {
      // A copy: each waiter removes itself as it runs.
      for (const waiter of (instance.dialogClearWaiters ?? []).slice()) waiter(toolCall);
    }
    // "prompt-cleared" ends the secretary's needs-you (and with it a paired phone's
    // dialog card); the desktop UI has nothing to do with it, so it isn't forwarded
    // to the renderer. Nor is a restatement: the renderer chimes and counts every
    // event it hears, and this dialog has had its chime.
    if (
      type !== "prompt-cleared" &&
      !restated &&
      this.mainWindow &&
      !this.mainWindow.isDestroyed()
    ) {
      this.mainWindow.webContents.send("instance-activity", id, type);
      // A phone showing this session has it on screen as it lands, so it is read
      // there. Sent after the activity, so the renderer's debounce drops the count
      // the activity just started and the red dot never lights; the chime stays.
      // Not for a turn that ended in another of the contact's sessions (an OpenCode
      // tab in the background): the phone shows the contact's session, not that one.
      const elsewhere = type === "waiting" && !!endedSession && endedSession !== instance.sessionId;
      if (!elsewhere && remoteServer.isReading(id)) this.readOnPhone(id);
    }
  }

  // The instance was read on a paired phone: opened or shown again there
  // (remote/ws-server.ts, setReadListener), or reporting while one shows it. The
  // renderer clears its unread without acknowledging it back (useNotifications.ts,
  // readOnPhone).
  readOnPhone(id: string) {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send("instance-read-on-phone", id);
    }
  }

  private setAlertsDegraded(
    instance: ManagedInstance,
    degraded: boolean,
    reason?: AlertsDegradedReason
  ) {
    const nextReason = degraded ? reason ?? "hooks" : undefined;
    if (!!instance.alertsDegraded === degraded && instance.alertsDegradedReason === nextReason) {
      return;
    }
    instance.alertsDegraded = degraded || undefined;
    instance.alertsDegradedReason = nextReason;
    debugTrace(
      `[alert-hook] ${instance.id.slice(0, 8)} ${degraded ? `alerts off (${nextReason})` : "alerts on again"} at ${new Date().toISOString()}`
    );
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(
        "instance-alerts-degraded",
        instance.id,
        degraded,
        nextReason
      );
    }
  }

  // A hook delivery from the `/alert` endpoint, routed to the instance that sent
  // it. Wired in alert-server/index.ts, which owns the server; this module must not
  // import it. An id no running instance has (a contact removed meanwhile, or a
  // late delivery from a process that has exited) is dropped.
  handleAlertDelivery(delivery: AlertDelivery) {
    const instance = this.instances.get(delivery.instanceId);
    if (!instance?.hookAttention) {
      debugTrace(
        `[alert-hook] ${delivery.instanceId.slice(0, 8)} ${delivery.event} dropped: no running instance with hooks`
      );
      return;
    }
    // Same contact, earlier process: a restart keeps the id, and that process's
    // async hooks can land after the new one is up.
    if (delivery.spawnId !== instance.spawnId) {
      debugTrace(
        `[alert-hook] ${delivery.instanceId.slice(0, 8)} ${delivery.event} dropped: from an earlier spawn`
      );
      return;
    }
    instance.hookAttention.handle(delivery);
    // `/new` and `/clear` start a session, and the CLI had already put its id in the
    // registry when this hook ran (measured 2026-10-30, Claude 2.1.312: the registry at
    // +1.1 s after Enter, the hook at +1.7 s). Followed now rather than at the next
    // poll, up to LIVE_SESSION_POLL_MS later, so a phone that has the contact open
    // shows the new session at once. Should the registry lag, the poll still follows.
    if (delivery.event === "SessionStart") this.syncLiveSessionId(instance);
  }

  private teardownObservers(instance: ManagedInstance) {
    if (instance.discovery) {
      instance.discovery.cancel();
      instance.discovery = null;
    }
    if (instance.hookAttention) {
      instance.hookAttention.stop();
      instance.hookAttention = null;
    }
  }

  writeToInstance(id: string, data: string) {
    const instance = this.instances.get(id);
    if (instance?.ptyProcess) {
      // Typing at the desk answers whatever was pending: noteWrite drops the
      // secretary's event, and with it a paired phone's dialog card, rather than
      // waiting for the agent to report it.
      this.noteWrite(instance, data);
      instance.ptyProcess.write(data);
    }
  }

  // Where to read the conclusion of a turn that just ended, to show it in the
  // terminal (read-reply-conclusion): the contact's session, and only when it is
  // both the one that ended and the one on screen. Null otherwise: another of the
  // contact's sessions ended (an OpenCode tab in the background), or the terminal
  // shows a session that isn't the contact's: a subagent's (the contact's stays the
  // root), one another contact holds (never taken over), or home.
  replySource(id: string): { backend: BackendName; sessionId: string } | null {
    const instance = this.instances.get(id);
    if (!instance?.sessionId) return null;
    const attention = instance.hookAttention;
    const onScreen = attention?.shownSession ? attention.shownSession() : instance.sessionId;
    if (onScreen !== instance.sessionId) return null;
    if (instance.endedSession && instance.endedSession !== instance.sessionId) return null;
    return { backend: instance.backend, sessionId: instance.sessionId };
  }

  // One of the keys that move an OpenCode terminal's view to a finished turn's
  // conclusion (shared/replyStart.ts). Not input, so none of what a write means
  // follows: the run state, the secretary's event and the phone's badge stay as they
  // are. False for anything but a running OpenCode instance.
  sendViewKey(id: string, command: OpencodeViewCommand): boolean {
    const instance = this.instances.get(id);
    if (!instance?.ptyProcess || instance.backend !== "opencode") return false;
    instance.ptyProcess.write(OPENCODE_VIEW_KEYS[command].bytes);
    return true;
  }

  // Send a whole prompt as one unit, the way the desktop compose box does:
  // bracketed paste (so the TUI folds it into a [Pasted text] placeholder and
  // multi-line text doesn't submit early), then a separate \r to submit. Used by
  // the phone's answer box.
  sendPrompt(id: string, text: string) {
    const instance = this.instances.get(id);
    if (!instance?.ptyProcess) return;
    const pasted = `\x1b[200~${text}\x1b[201~`;
    this.noteWrite(instance, `${pasted}\r`);
    instance.ptyProcess.write(pasted);
    instance.ptyProcess.write("\r");
  }

  // Stop the running turn the way Esc does at the desk, for a paired phone's Stop:
  // the backend's interrupt keys, as typed, `gapMs` apart. The caller checks that a
  // turn runs and no dialog is open; between keys this checks the second part again,
  // since on a dialog the next Esc would answer it. Resolves false when not every key
  // went in: the process went, or a dialog came up.
  async interruptInstance(id: string): Promise<boolean> {
    const instance = this.instances.get(id);
    const ptyProcess = instance?.ptyProcess;
    if (!instance || !ptyProcess || !this.canInterrupt(id)) return false;
    const attention = instance.hookAttention;
    // The turn the keys are aimed at, held to between them: a view moved meanwhile
    // would take the next Esc somewhere else.
    const target = attention?.interruptTarget?.();
    // And the turn: one that ended meanwhile is stopped, and the next one, started from
    // a queued message, isn't the one the builder asked to stop.
    const turn = instance.workingSince;
    const { keys, gapMs } = getBackend(instance.backend).interrupt;
    for (const [i, key] of keys.entries()) {
      if (i > 0) {
        await delay(gapMs);
        if (this.instances.get(id) !== instance || instance.ptyProcess !== ptyProcess) return false;
        if (instance.secretaryEvent?.kind === "needs-you" || this.dialogOnScreen(id)) return false;
        if (instance.workingSince !== turn) return !instance.working;
        if (attention?.interruptTarget && attention.interruptTarget() !== target) return false;
      }
      this.noteWrite(instance, key);
      ptyProcess.write(key);
    }
    return true;
  }

  // The last `turns` turns of the session the phone has open (Backend.readRecentTurns),
  // and which session that is (readableSessionId). `turns`
  // comes from the phone, so it is taken as a whole number of at least one.
  //
  // A session the process has moved to (`/new`) is read from the moment it is known,
  // file or no file yet, never the one before it: readableSessionId falls back only
  // while no live id is known.
  readRecentTurns(id: string, turns: number): RecentTurns & { session?: string } {
    const instance = this.instances.get(id);
    if (!instance) return { entries: [], hasEarlier: false };
    const sessionId = this.readableSessionId(instance);
    if (!sessionId) return { entries: [], hasEarlier: false };
    try {
      const read = getBackend(instance.backend).readRecentTurns(sessionId, Math.max(1, Math.floor(turns) || 1));
      return { ...read, session: sessionId };
    } catch {
      return { entries: [], hasEarlier: false, session: sessionId };
    }
  }

  // The session id read paths should use: the live one when there is one, then the
  // contact's own, otherwise whatever this directory last worked on.
  //
  // A stopped contact has no live id at all after an app restart, and contacts
  // saved before contacts.json kept their session have no own one either, which is
  // why every stopped session reported `context=unknown` and could not be read. The
  // lookup touches the filesystem or sqlite, so it is cached, including the
  // negative result.
  private readableSessionId(instance: ManagedInstance): string | undefined {
    if (instance.sessionId) return instance.sessionId;
    if (instance.ownSessionId) return instance.ownSessionId;

    const now = Date.now();
    if (
      instance.resolvedSessionIdAt !== undefined &&
      now - instance.resolvedSessionIdAt < RESOLVED_SESSION_TTL_MS
    ) {
      return instance.resolvedSessionId;
    }
    instance.resolvedSessionIdAt = now;
    try {
      instance.resolvedSessionId =
        getBackend(instance.backend).findLatestSessionId(instance.cwd) ??
        undefined;
    } catch {
      instance.resolvedSessionId = undefined;
    }
    return instance.resolvedSessionId;
  }

  resizeInstance(id: string, cols: number, rows: number) {
    const instance = this.instances.get(id);
    if (instance?.ptyProcess) {
      instance.ptyProcess.resize(cols, rows);
      // A phone's terminal is drawn at the PTY's width, so it is told when that
      // changes. The resize itself goes through either way, as it always has.
      if (instance.cols === cols && instance.rows === rows) return;
      instance.cols = cols;
      instance.rows = rows;
      remoteServer.broadcastResize(id, cols, rows);
    }
  }

  // The PTY's size, for a paired phone's terminal. Null when it isn't running.
  ptySizeOf(id: string): { cols: number; rows: number } | null {
    const instance = this.instances.get(id);
    return instance?.ptyProcess ? { cols: instance.cols, rows: instance.rows } : null;
  }

  killInstance(id: string) {
    const instance = this.instances.get(id);
    if (instance?.ptyProcess) {
      instance.ptyProcess.kill();
    }
  }

  removeInstance(id: string) {
    this.killInstance(id);
    shellManager.kill(id);
    const instance = this.instances.get(id);
    if (instance) {
      // Now, while it is still the current record: its pty's exit lands later.
      this.clearSecretaryEvent(instance);
      this.teardownObservers(instance);
    }
    this.instances.delete(id);
    this.persist();
    remoteServer.broadcastInstances();
  }

  restartInstance(id: string): InstanceInfo | null {
    const instance = this.instances.get(id);
    if (!instance) return null;

    if (instance.ptyProcess) {
      instance.ptyProcess.kill();
    }
    // Before the new record replaces this one; see clearSecretaryEvent.
    this.clearSecretaryEvent(instance);
    this.teardownObservers(instance);

    const restarted = this.spawnProcess(
      id,
      instance.cwd,
      instance.alias,
      instance.backend,
      this.sessionStartFor(id, instance.cwd, instance.backend, instance.ownSessionId)
    );
    this.instances.set(id, restarted);
    if (restarted.ownSessionId !== instance.ownSessionId) this.persist();
    remoteServer.broadcastInstances();
    return this.toInfo(restarted);
  }

  listInstances(): InstanceInfo[] {
    this.refreshStaleContextUsage();
    return Array.from(this.instances.values()).map((i) => this.toInfo(i));
  }

  // One instance as listInstances shows it, from what is cached: no read.
  infoOf(id: string): InstanceInfo | undefined {
    const instance = this.instances.get(id);
    return instance ? this.toInfo(instance) : undefined;
  }

  // Re-read context usage for any instance whose cached figure has aged out.
  // Only sessions that have been discovered are worth reading — before that
  // there is no transcript to look at.
  // Stopped instances are included, not skipped: their transcript is a real file and
  // its usage figure is what makes the contact list useful the moment the app opens,
  // rather than only after the user has started something.
  private refreshStaleContextUsage() {
    const now = Date.now();
    for (const instance of this.instances.values()) {
      if (now - (instance.contextUsageAt ?? 0) < CONTEXT_USAGE_TTL_MS) continue;
      this.refreshContextUsage(instance);
    }
  }

  private refreshContextUsage(instance: ManagedInstance) {
    if (instance.homeShown) return;
    const sessionId = this.readableSessionId(instance);
    if (!sessionId) return;
    instance.contextUsageAt = Date.now();
    try {
      const usage = getBackend(instance.backend).readContextUsage(sessionId);
      // Keep the last known figure when a read comes back empty. A stopped
      // instance still has a real transcript, and a transient failure (sqlite
      // locked mid-write) shouldn't blank a number the user was reading. A
      // compaction is the exception: the figure it leaves is known to be wrong.
      if (usage === "compacted") instance.contextUsage = undefined;
      else if (usage) instance.contextUsage = usage;
    } catch {
      // Backends are documented to return null rather than throw, but a
      // surprise here must not take down a list call.
    }
  }

  // Read now; when that finds the figure unchanged, read again after each of
  // CONTEXT_REREAD_MS until it moves, and tell the renderer when it does. The
  // first read needs no telling: the renderer asks on the activity itself.
  private refreshContextUsageAfterTurn(instance: ManagedInstance) {
    const moved = () => {
      const before = instance.contextUsage;
      this.refreshContextUsage(instance);
      return !sameUsage(before, instance.contextUsage);
    };
    if (moved()) return;
    const retry = (attempt: number) => {
      const delay = CONTEXT_REREAD_MS[attempt];
      if (delay === undefined) return;
      const timer = setTimeout(() => {
        if (this.instances.get(instance.id) !== instance) return;
        if (moved()) this.sendContextUsage(instance);
        else retry(attempt + 1);
      }, delay);
      timer.unref?.();
    };
    retry(0);
  }

  // A figure that changed outside a turn, which the renderer would otherwise only
  // pick up at its next poll.
  private sendContextUsage(instance: ManagedInstance) {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(
        "instance-context-usage",
        instance.id,
        instance.contextUsage ?? null
      );
    }
  }

  hasRunningInstanceAt(cwd: string, backend?: BackendName): boolean {
    for (const instance of this.instances.values()) {
      if (instance.cwd !== cwd) continue;
      if (instance.status !== "running") continue;
      if (backend && instance.backend !== backend) continue;
      return true;
    }
    return false;
  }

  // The name the contact list shows. Blank goes back to the folder name.
  setAlias(id: string, alias: string): InstanceInfo | null {
    const instance = this.instances.get(id);
    if (!instance) return null;
    instance.alias = alias.trim() || undefined;
    this.persist();
    remoteServer.broadcastInstances();
    return this.toInfo(instance);
  }

  // Instances a quit would cut off mid-task: a turn still running, or a dialog
  // waiting on the user. Idle ones are left out: they lose nothing, since the next
  // start reopens their session, and counting them would mean asking on every quit.
  unfinishedInstances(): { name: string; state: "busy" | "blocked" }[] {
    const unfinished: { name: string; state: "busy" | "blocked" }[] = [];
    for (const instance of this.instances.values()) {
      if (!instance.ptyProcess) continue;
      // OpenCode 2's turns run in its shared background service, which outlives
      // the terminal: quitting cuts none of them off (opencode-v2 Story 11).
      if (instance.backend === "opencode") continue;
      const state = instance.runState.state();
      if (state !== "busy" && state !== "blocked") continue;
      unfinished.push({
        name: instance.alias || path.basename(instance.cwd),
        state,
      });
    }
    return unfinished;
  }

  cleanup() {
    for (const instance of this.instances.values()) {
      if (instance.ptyProcess) {
        instance.ptyProcess.kill();
      }
      this.teardownObservers(instance);
      instance.status = "stopped";
      instance.ptyProcess = null;
    }
    // Don't clear instances — they are persisted as contacts
  }

  private toInfo(instance: ManagedInstance): InstanceInfo {
    return {
      id: instance.id,
      cwd: instance.cwd,
      alias: instance.alias,
      status: instance.status,
      startedAt: instance.startedAt,
      name: instance.alias || path.basename(instance.cwd),
      sessionId: instance.sessionId,
      backend: instance.backend,
      // Cache only — refreshing happens in listInstances and on activity, never
      // here, since this runs once per instance per broadcast.
      contextUsage: instance.contextUsage,
      lastActivityAt: instance.lastActivityAt,
      runState: instance.ptyProcess ? instance.runState.state() : undefined,
      working: instance.ptyProcess ? instance.working : undefined,
      workingSince: instance.ptyProcess ? instance.workingSince : undefined,
      alertsDegraded: instance.ptyProcess ? instance.alertsDegraded : undefined,
      alertsDegradedReason: instance.ptyProcess ? instance.alertsDegradedReason : undefined,
      startError: instance.startError,
    };
  }
}

export const processManager = new ProcessManager();

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
