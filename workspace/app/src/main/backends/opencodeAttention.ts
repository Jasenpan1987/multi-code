// Turns an OpenCode instance's plugin deliveries into the activity vocabulary
// everything downstream already speaks: `waiting` (finished), `prompt` (needs you),
// and `prompt-cleared`. OpenCode's counterpart of claudeHooks.ts.
//
// Replaces polling OpenCode's SQLite rows and parsing its permission dialog off the
// screen (see docs/knowledge/tech-conventions.md, "Agent state comes from the
// agent"). Every rule follows something OpenCode 1.18.35 was measured to report
// through the plugin (backends/opencodePlugin.ts):
// docs/timeline/2026-10-06_attention-alerts-investigation.md, "OpenCode plugin
// spike". The fixtures those runs produced are what opencodeAttention.test.ts
// replays.
//
// A delivery's `event` is the OpenCode event type, `sessionId` its session, and
// `payload.properties` the event's properties.
//
// No timers decide anything here: OpenCode reports a turn's end exactly, so the
// only timer is the plugin-health one. Pure otherwise: no electron, no fs.

import type { ActivityCallback, AlertDelivery } from "./types";
import type { HookTimers } from "./claudeHooks";
import type { PromptDetail } from "../remote/promptExtract";
import { permissionDetail, questionDetail } from "./opencodePrompt";

// How long after spawn without a single delivery before the plugin is taken not to
// run: `--pure`, a config that broke loading, an inherited OPENCODE_CONFIG_CONTENT
// Multi-Code couldn't merge into. There is no registry to start the clock on, and
// the plugin's init delivery arrived 1.9–2.2s after spawn in every T-410 run.
const PLUGIN_MISSING_MS = 10_000;

// OpenCode's current names and the v2 ones it is moving to (both in the 1.18.35
// binary). The v2 payloads are unmeasured; read the same fields, best effort.
const ASKED = new Set([
  "permission.asked",
  "permission.v2.asked",
  "question.asked",
  "question.v2.asked",
]);
const ANSWERED = new Set([
  "permission.replied",
  "permission.v2.replied",
  "question.replied",
  "question.v2.replied",
  "question.rejected",
  "question.v2.rejected",
]);

const realTimers: HookTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export class OpencodePluginAttention {
  // Subagent session → its parent, from `info.parentID` on session.created/updated:
  // the only place a child is marked. Everything else is a root. A resumed root
  // announces no `session.created`, but a child is always created during the
  // process's life.
  private parents = new Map<string, string>();
  // Root sessions whose turn is under way: busy seen, idle not yet. `busy` arrives
  // 3–5 times a turn and `idle` twice after an error or abort, so Finished is this
  // set losing a session, which happens once.
  private busyRoots = new Set<string>();
  // Open dialogs, request id → the session that asked and what it asked.
  private openRequests = new Map<string, { session: string; detail?: PromptDetail }>();
  private promptOutstanding = false;
  // Roots whose turn the builder ended: a Reject (or Esc) on a permission, Esc on a
  // question, or an Esc interrupt, in that root or one of its subagents. OpenCode
  // reports idle right after each, and that idle is theirs, not a finish. Cleared by
  // the root going busy again, so a turn that carries on after a subagent's dialog
  // was rejected still finishes. Per root: one OpenCode can run several sessions at
  // once, and ending one must not silence another.
  private endedByBuilder = new Set<string>();
  private stopped = false;

  // Plugin health (PRD Story 6), watched from spawn until the first delivery.
  private heard = false;
  private reportedMissing = false;
  private healthTimer: unknown = null;

  constructor(
    private readonly onActivity: ActivityCallback,
    private readonly timers: HookTimers = realTimers,
    // false once the plugin is taken not to run, true again when it is heard.
    private readonly onPluginHealth: (ok: boolean) => void = () => {}
  ) {
    this.healthTimer = this.timers.setTimeout(() => {
      this.healthTimer = null;
      if (this.stopped || this.heard) return;
      this.reportedMissing = true;
      this.onPluginHealth(false);
    }, PLUGIN_MISSING_MS);
  }

  handle(delivery: AlertDelivery) {
    if (this.stopped) return;
    this.noteHeard();
    const event = delivery.event;
    const props = record(delivery.payload.properties);
    const session = delivery.sessionId ?? "";

    if (event === "session.created" || event === "session.updated") {
      const info = record(props.info);
      if (typeof info.id === "string" && typeof info.parentID === "string" && info.parentID) {
        this.parents.set(info.id, info.parentID);
      }
      return;
    }

    if (event === "session.status") {
      const status = record(props.status).type;
      if (!session) return;
      if (this.parents.has(session)) {
        // A subagent finishing is never the instance finishing. Its open dialogs
        // are over, though: an abort sends no reply.
        if (status === "idle") this.clearRequests((s) => s === session);
        return;
      }
      if (status === "busy") {
        this.busyRoots.add(session);
        this.endedByBuilder.delete(session);
        return;
      }
      if (status === "idle") {
        // The turn is over, and with it every dialog of its subagents.
        this.clearRequests((s) => this.rootOf(s) === session);
        if (!this.busyRoots.delete(session)) return;
        if (this.endedByBuilder.delete(session)) return;
        // An API error ends here too, after its session.error, and chimes like a
        // normal finish (G-002).
        this.onActivity("waiting");
        // Another root's dialog still blocks the instance. Said again, or the finish
        // above reads as the whole instance being idle, and the write gate would let
        // an automated write land in that dialog as its answer.
        this.reraiseOpenPrompt();
      }
      // `retry` (rate limited, repeats ~2s apart) is neither: the turn goes on.
      return;
    }

    if (event === "session.error") {
      // An abort while a dialog is open sends no reply for it.
      this.clearRequests((s) => s === session);
      if (record(props.error).name === "MessageAbortedError") {
        this.endedByBuilder.add(this.rootOf(session));
      }
      return;
    }

    if (ASKED.has(event)) {
      // From any session: a subagent's dialog blocks the builder just the same.
      const detail = event.startsWith("permission")
        ? permissionDetail(props)
        : (questionDetail(props) ?? undefined);
      if (typeof props.id === "string") this.openRequests.set(props.id, { session, detail });
      this.promptOutstanding = true;
      this.onActivity("prompt", detail);
      return;
    }

    if (ANSWERED.has(event)) {
      if (props.reply === "reject" || event.endsWith(".rejected")) {
        this.endedByBuilder.add(this.rootOf(session));
      }
      if (typeof props.requestID === "string") this.openRequests.delete(props.requestID);
      if (this.openRequests.size === 0) this.clearPrompt();
      return;
    }
    // multicode.init and anything else: nothing an alert depends on.
  }

  stop() {
    this.stopped = true;
    if (this.healthTimer !== null) {
      this.timers.clearTimeout(this.healthTimer);
      this.healthTimer = null;
    }
  }

  private noteHeard() {
    if (this.heard) return;
    this.heard = true;
    if (this.reportedMissing) {
      this.reportedMissing = false;
      this.onPluginHealth(true);
    }
  }

  // The root session a session belongs to: itself, or its subagent chain's top.
  private rootOf(session: string): string {
    let current = session;
    for (let depth = 0; depth < 32; depth++) {
      const parent = this.parents.get(current);
      if (parent === undefined) return current;
      current = parent;
    }
    return current;
  }

  private clearRequests(matches: (session: string) => boolean) {
    for (const [id, request] of this.openRequests) {
      if (matches(request.session)) this.openRequests.delete(id);
    }
    if (this.openRequests.size === 0) this.clearPrompt();
  }

  // The newest dialog still open, raised again.
  private reraiseOpenPrompt() {
    const newest = [...this.openRequests.values()].at(-1);
    if (!newest) return;
    this.promptOutstanding = true;
    this.onActivity("prompt", newest.detail);
  }

  private clearPrompt() {
    if (!this.promptOutstanding) return;
    this.promptOutstanding = false;
    this.onActivity("prompt-cleared");
  }
}
