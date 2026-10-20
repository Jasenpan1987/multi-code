// Turns what the user's shared OpenCode 2 service reports into the activity
// vocabulary everything downstream already speaks: `waiting` (finished), `prompt`
// (needs you) and `prompt-cleared`, for one OpenCode contact. OpenCode's counterpart
// of claudeHooks.ts.
//
// Two sources (docs/knowledge/tech-conventions.md, "Agent state comes from the
// agent"). The service's event stream (backends/opencodeService.ts) says when a turn
// starts and ends and when a dialog opens and closes, for every session of every
// client of the service. Multi-Code's TUI plugin, through `/alert`, says which session
// this contact's terminal shows: nothing else can (spike G-601, "No server event marks
// a route change"). A contact owns the sessions its terminal has shown since this
// spawn started, plus their subagents; everything else on the service is VS Code, a
// plain terminal or another contact, and is ignored.
//
// Every rule follows what OpenCode 2.0.32 was measured to do:
// docs/timeline/2026-10-20_opencode-v2-spike.md (G-603), whose fixtures
// (__fixtures__/opencode-v2/) opencodeAttention.test.ts replays. Where the spike and
// docs/timeline/2026-10-20_opencode-v2-source-reading.md disagree, the spike wins.
//
// No polling. The service's snapshot reads are made only after a (re)connect and
// when the terminal shows a session for the first time; the only timer is the
// plugin-health one, injected as claudeHooks.ts does. Pure otherwise: no electron, no
// fs, nothing but the service client it is handed.

import type {
  ActivityCallback,
  AlertDelivery,
  AlertsDegradedReason,
  AnswerResult,
  AttentionContext,
  DialogAnswer,
  DialogRef,
  HookAttention,
  PromptToolCall,
} from "./types";
import type { HookTimers } from "./claudeHooks";
import type { PromptDetail } from "../remote/promptExtract";
import {
  getOpencodeService,
  toFormInfo,
  toPermissionRequest,
  type FormInfo,
  type OpencodeService,
  type PermissionRequest,
  type ServiceEvent,
  type ServiceSession,
  type ServiceStatus,
} from "./opencodeService";
import { formDetail, formToolCall, permissionDetail, permissionToolCall } from "./opencodePrompt";
import { OPENCODE_INIT_EVENT, OPENCODE_ROUTE_EVENT } from "./opencodePlugin";

// How long after spawn without a word from Multi-Code's TUI plugin before it is taken
// not to have loaded: a user config whose `plugins` couldn't be merged, a TUI that
// failed before setup. The plugin posts `multicode.init` from its setup, which runs
// as the TUI starts (spike G-601, "TUI plugin probe").
const PLUGIN_MISSING_MS = 10_000;

// The plugin's deliveries (backends/opencodePlugin.ts). `multicode.route` carries the
// shown session as the delivery's session id, none on the home screen, and the route
// itself as `payload.route`.
const PLUGIN_INIT_EVENT = OPENCODE_INIT_EVENT;
const PLUGIN_ROUTE_EVENT = OPENCODE_ROUTE_EVENT;

// Bound on a parentID walk. Subagents nest a level or two; this only stops a cycle.
const MAX_DEPTH = 32;

const STARTED = "session.execution.started";
const ENDED = new Set([
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
]);
// Events whose meaning depends on whose session it is: raising a dialog, ending a turn.
// A start only marks the session running, and a closing names its request by id, so
// neither needs to know the session's family.
const NEEDS_FAMILY = new Set([...ENDED, "permission.asked", "form.created"]);
// Everything attention acts on. The rest (text and tool streaming, titles, usage,
// `session.viewed`) says nothing about Finished or Needs-you.
const RELEVANT = new Set([
  ...NEEDS_FAMILY,
  STARTED,
  "permission.replied",
  "form.replied",
  "form.cancelled",
]);

// A form whose session is "global" (an MCP elicitation, source reading "Events
// Multi-Code needs") belongs to no session, so no contact can claim it.
const GLOBAL_SESSION = "global";

const realTimers: HookTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

// The request a reply or a cancel settles: permission.replied names it `requestID`,
// form.replied and form.cancelled `id`.
function settledRequest(event: ServiceEvent): string | undefined {
  if (event.type === "permission.replied") return str(event.data.requestID);
  if (event.type === "form.replied" || event.type === "form.cancelled") return str(event.data.id);
  return undefined;
}

// The session an event is about. A form's is inside the form (`form.created` data is
// `{form}`); everything else carries `sessionID` at the top.
function sessionOf(event: ServiceEvent): string | undefined {
  if (event.type === "form.created") return str(record(event.data.form).sessionID);
  return str(event.data.sessionID);
}

// A dialog the contact is blocked on: the session that asked (a subagent's included),
// what the phone is shown, and the request for the secretary.
interface OpenDialog {
  session: string;
  detail?: PromptDetail;
  toolCall: PromptToolCall;
}

function permissionDialog(request: PermissionRequest): OpenDialog {
  return {
    session: request.sessionID,
    detail: permissionDetail(request),
    toolCall: permissionToolCall(request),
  };
}

function formDialog(form: FormInfo): OpenDialog {
  return { session: form.sessionID, detail: formDetail(form), toolCall: formToolCall(form) };
}

type HealthState = "ok" | AlertsDegradedReason;

// What arrived on the stream during one re-sync: the sessions any event spoke for
// (their run state is the event's), the requests a reply or cancel settled, and the
// sessions whose turn ended (taking their dialogs, and their subagents', with them).
interface SyncNotes {
  sessions: Set<string>;
  settled: Set<string>;
  ended: Set<string>;
}

export interface OpencodeAttentionDeps {
  service?: OpencodeService;
  timers?: HookTimers;
}

export class OpencodeAttention implements HookAttention {
  private readonly service: OpencodeService;
  private readonly timers: HookTimers;
  private readonly unsubscribe: () => void;
  private stopped = false;

  // ── Which sessions are the contact's ──
  // The spawn's own session (it may not exist yet: a minted id is created by the first
  // prompt, spike G-601) and every session the terminal has shown since. Never shrinks
  // during a spawn: a turn left running in a session the builder moved away from still
  // finishes for this contact (PRD Story 3).
  private readonly shown = new Set<string>();
  private lastShown: string | undefined;
  // The session last handed to `onSessionShown`, so a route that comes back to it
  // before a lookup settles isn't reported twice.
  private lastAdopted: string | undefined;
  // Session → its parent, null for a root. From `session.created`, the only event
  // carrying `parentID`, else asked of the service once per session (`GET
  // /api/session/:id`) and kept, "no such session" included. Parentage never changes.
  private readonly parents = new Map<string, string | null>();
  private readonly lookups = new Map<string, Promise<void>>();
  // Events of a session whose family is being looked up, in arrival order, so they
  // apply in the order the service sent them.
  private readonly held = new Map<string, ServiceEvent[]>();

  // ── Turns and dialogs ──
  // Every session with a turn running, the contact's or not: a session the terminal
  // moves to may already be running when the route arrives, and a start is cheap to
  // remember. From `execution.started` and the ends, or the snapshot.
  private readonly running = new Set<string>();
  // Roots whose Finished a re-sync raised because their turn ended while the stream
  // was down. Should that end's own event still turn up, it is the same end.
  private readonly finishedBySync = new Set<string>();
  // Open dialogs by request id (a permission's `per_…`, a form's `frm_…`), oldest first.
  private readonly dialogs = new Map<string, OpenDialog>();
  private promptOutstanding = false;
  // The dialog last reported as the one blocking the contact: what the phone shows and
  // the secretary answers. When it closes and another is still open, that one is said
  // again (restate).
  private live: string | undefined;

  // ── Re-sync ──
  // Bumped by every re-sync and by stop(), so an older one's answers are dropped.
  private syncGen = 0;
  // What the stream said while the current re-sync was reading. An event is newer
  // than the snapshot, so it wins where it speaks, as the official client does
  // (packages/client/src/solid/data.ts).
  private sync: SyncNotes | null = null;

  // ── Health (PRD Story 9) ──
  private pluginHeard = false;
  private pluginMissing = false;
  private serviceDown = false;
  private reportedHealth: HealthState = "ok";
  private healthTimer: unknown = null;

  constructor(
    private readonly onActivity: ActivityCallback,
    // false (with why) once alerts can't work for this contact, true when they can
    // again. One state for both causes: see reportHealth.
    private readonly onHooksHealth: (ok: boolean, reason?: AlertsDegradedReason) => void,
    private readonly context: AttentionContext,
    deps: OpencodeAttentionDeps = {}
  ) {
    this.service = deps.service ?? getOpencodeService();
    this.timers = deps.timers ?? realTimers;
    if (context.sessionId) this.shown.add(context.sessionId);
    this.healthTimer = this.timers.setTimeout(() => {
      this.healthTimer = null;
      if (this.stopped || this.pluginHeard) return;
      this.pluginMissing = true;
      this.reportHealth();
    }, PLUGIN_MISSING_MS);
    // The service tells a new subscriber its status, and re-syncs it at once when its
    // stream is already up; otherwise the re-sync follows `server.connected`.
    this.unsubscribe = this.service.subscribe({
      onEvent: (event) => this.onEvent(event),
      onResync: () => void this.resync(),
      onStatus: (status) => this.onStatus(status),
    });
  }

  // Deliveries from Multi-Code's TUI plugin. Anything else reaching this contact's
  // `/alert` (a stray 1.x plugin, say) is not ours and proves nothing.
  handle(delivery: AlertDelivery) {
    if (this.stopped) return;
    if (delivery.event !== PLUGIN_INIT_EVENT && delivery.event !== PLUGIN_ROUTE_EVENT) return;
    // Any delivery proves the plugin loaded: its posts are fire-and-forget, so the
    // init itself can be the one that was lost. Init's `pid` is not needed here.
    this.notePluginHeard();
    if (delivery.event !== PLUGIN_ROUTE_EVENT) return;

    const route = record(delivery.payload.route);
    const session =
      delivery.sessionId ?? (route.type === "session" ? str(route.sessionID) : undefined);
    // Home (`/new`, `/clear`, or a minted id before its first prompt): no session is
    // shown, and the one before stays the contact's until a prompt makes a new one.
    if (!session) return;
    const first = !this.shown.has(session);
    this.shown.add(session);
    if (session !== this.lastShown) {
      this.lastShown = session;
      void this.adoptIfRoot(session);
    }
    // A session shown for the first time may be mid-turn or blocked already (`/sessions`
    // into a session VS Code is running, or a start or dialog that beat the route here),
    // and those events were another owner's when they came. The snapshot says.
    if (first) void this.resync();
  }

  // The contact takes the shown session as its own (the one its next start reopens)
  // only when it is a root. The TUI can show a subagent's session too, and reopening
  // that would put the contact in the middle of someone else's turn. Its family is
  // asked of the service once when unknown; a session it can't find counts as a root
  // (lookup), which is right for the spawn's own and for one just created.
  private async adoptIfRoot(session: string) {
    if (!this.parents.has(session)) await this.lookup(session);
    if (this.stopped || this.lastShown !== session || this.lastAdopted === session) return;
    if (!this.isRoot(session)) return;
    this.lastAdopted = session;
    this.context.onSessionShown(session);
  }

  stop() {
    // A stopped contact raises nothing, whatever its sessions do in the service
    // (PRD Story 11, builder 2026-10-20).
    if (this.stopped) return;
    this.stopped = true;
    this.syncGen++;
    this.sync = null;
    this.held.clear();
    this.unsubscribe();
    if (this.healthTimer !== null) {
      this.timers.clearTimeout(this.healthTimer);
      this.healthTimer = null;
    }
  }

  // Through the service's reply endpoints, to the request's own session (a subagent's
  // request answered on its root is a 404, source reading "Answering dialogs through
  // the API"). The terminal is never written to. "Already answered" comes back as
  // `gone` from the service; a ref of one kind with an answer of the other is refused.
  async answer(ref: DialogRef, answer: DialogAnswer): Promise<AnswerResult> {
    if (ref.kind === "permission" && answer.kind === "permission") {
      return this.service.replyPermission(ref.sessionId, ref.requestId, answer.decision, answer.message);
    }
    if (ref.kind === "form" && answer.kind === "form") {
      return this.service.replyForm(ref.sessionId, ref.requestId, answer.answer);
    }
    return { ok: false, reason: "failed" };
  }

  // ── The event stream ──────────────────────────────────────────────────────

  private onEvent(event: ServiceEvent) {
    if (this.stopped) return;
    if (event.type === "session.created") {
      const session = str(event.data.sessionID);
      if (session) this.parents.set(session, str(event.data.parentID) ?? null);
      return;
    }
    if (!RELEVANT.has(event.type)) return;
    const session = sessionOf(event);
    if (!session || session === GLOBAL_SESSION) return;
    // Noted on arrival, held or not: a held event is newer than any snapshot in flight.
    this.noteDuringSync(event, session);

    const held = this.held.get(session);
    if (held) {
      held.push(event);
      return;
    }
    if (NEEDS_FAMILY.has(event.type) && this.unknownLink(session) !== null) {
      this.held.set(session, [event]);
      void this.releaseWhenKnown(session);
      return;
    }
    this.apply(event, session);
  }

  private apply(event: ServiceEvent, session: string) {
    this.noteDuringSync(event, session);
    const type = event.type;

    if (type === STARTED) {
      this.running.add(session);
      this.finishedBySync.delete(session);
      return;
    }

    if (ENDED.has(type)) {
      // `succeeded`, and `failed` (an API or model error, api-error) like Claude's
      // StopFailure (attention-alerts G-002), are a turn's end the builder hears.
      // `interrupted` is not, by reason: `user` is the builder's own double Esc
      // (interrupt-esc); `shutdown` is a plain Reject or a dismissed question
      // (permission-reject, question-dismiss) or the service going away; `superseded`
      // another runner took over. `inactivity` is OpenCode evicting the location after
      // 60 minutes, which killed the turn without anyone ending it (PRD Story 3
      // assumption: the builder wants to know). A reason not known here stays silent.
      const finishing =
        type !== "session.execution.interrupted" || event.data.reason === "inactivity";
      this.turnEnded(session, finishing);
      return;
    }

    if (type === "permission.asked") {
      if (!this.owned(session)) return;
      const request = toPermissionRequest(event.data);
      if (request) {
        this.raise(request.id, permissionDialog(request));
        return;
      }
      // A shape this version doesn't know still blocks the builder: say so, with
      // nothing to answer it by but the terminal.
      const id = str(event.data.id);
      if (id) this.raise(id, { session, toolCall: { toolName: "permission", toolInput: event.data } });
      return;
    }

    if (type === "form.created") {
      if (!this.owned(session)) return;
      const raw = record(event.data.form);
      const form = toFormInfo(raw);
      if (form) {
        this.raise(form.id, formDialog(form));
        return;
      }
      const id = str(raw.id);
      if (id) this.raise(id, { session, toolCall: { toolName: "form", toolInput: raw } });
      return;
    }

    // Only a request this contact has open means anything; the rest are other owners'.
    this.close(settledRequest(event));
  }

  private noteDuringSync(event: ServiceEvent, session: string) {
    const sync = this.sync;
    if (!sync) return;
    sync.sessions.add(session);
    if (ENDED.has(event.type)) sync.ended.add(session);
    const settled = settledRequest(event);
    if (settled) sync.settled.add(settled);
  }

  private turnEnded(session: string, finishing: boolean) {
    this.running.delete(session);
    const alreadyFinished = this.finishedBySync.delete(session);
    if (!this.owned(session)) return;
    // Every dialog of the tree goes with its turn: an interrupted turn drops a pending
    // permission without a `permission.replied` (interrupt-pending-permission), and a
    // subagent's turn ending leaves nothing of its own open.
    const closed = this.closeTree(session);
    if (closed && this.dialogs.size === 0) this.clearPrompt(closed);
    // A subagent's end is never the contact's (PRD Story 3); its root carries on, even
    // after a Reject inside the subagent (subagent-reject-noreason), and finishes with
    // its own end.
    const finished = finishing && !alreadyFinished && this.isRoot(session);
    if (finished) this.onActivity("waiting");
    // Another root's dialog still blocks the contact. Said again after a finish, or the
    // finish reads as the whole contact being idle, and the write gate would let an
    // automated write land in that dialog as its answer; and when the dialog the phone
    // and secretary were shown went with this turn.
    if (finished || !this.liveOpen()) this.restateNewest();
  }

  // ── Dialogs ───────────────────────────────────────────────────────────────

  private raise(id: string, dialog: OpenDialog) {
    // Already reported (by the snapshot, or the same event twice): no second chime.
    if (this.dialogs.has(id)) return;
    this.dialogs.set(id, dialog);
    this.promptOutstanding = true;
    this.live = id;
    this.onActivity("prompt", dialog.detail, dialog.toolCall);
  }

  // A reply closes its request; Needs-you clears once nothing is left open. The
  // clearing carries the closed request's call: the secretary's waiters only take a
  // clearing with a call (process-manager `dialogClearWaiters`). When the one closed
  // was the live one and another is still open, the phone and the secretary move to
  // that one.
  private close(id: string | undefined) {
    if (!id) return;
    const dialog = this.dialogs.get(id);
    if (!dialog) return;
    this.dialogs.delete(id);
    if (this.dialogs.size === 0) this.clearPrompt(dialog.toolCall);
    else if (!this.liveOpen()) this.restateNewest();
  }

  // Drops every open dialog of `root`'s tree without a word, returning the call of the
  // last one dropped.
  private closeTree(root: string): PromptToolCall | undefined {
    let closed: PromptToolCall | undefined;
    for (const [id, dialog] of this.dialogs) {
      if (!this.inTree(dialog.session, root)) continue;
      this.dialogs.delete(id);
      closed = dialog.toolCall;
    }
    return closed;
  }

  private liveOpen(): boolean {
    return this.live !== undefined && this.dialogs.has(this.live);
  }

  // The newest dialog still open, said again as the one blocking the contact. It was
  // reported when it opened, so it is marked a restatement: run state, the phone's
  // buttons and the secretary follow it, but it doesn't chime or count twice.
  private restateNewest() {
    const newest = [...this.dialogs].at(-1);
    if (!newest) return;
    const [id, dialog] = newest;
    this.promptOutstanding = true;
    this.live = id;
    this.onActivity("prompt", dialog.detail, dialog.toolCall, true);
  }

  private clearPrompt(toolCall: PromptToolCall) {
    this.live = undefined;
    if (!this.promptOutstanding) return;
    this.promptOutstanding = false;
    this.onActivity("prompt-cleared", undefined, toolCall);
  }

  // ── Families ──────────────────────────────────────────────────────────────

  private owned(session: string): boolean {
    let current: string | null | undefined = session;
    for (let depth = 0; current && depth < MAX_DEPTH; depth++) {
      if (this.shown.has(current)) return true;
      current = this.parents.get(current);
    }
    return false;
  }

  // Known to have no parent. A session whose family is unknown is not taken for a
  // root: its events wait for the lookup (onEvent), and a root that can't be looked up
  // is recorded as one (lookup).
  private isRoot(session: string): boolean {
    return this.parents.get(session) === null;
  }

  private inTree(session: string, root: string): boolean {
    let current: string | null | undefined = session;
    for (let depth = 0; current && depth < MAX_DEPTH; depth++) {
      if (current === root) return true;
      current = this.parents.get(current);
    }
    return false;
  }

  // The first session up `session`'s parent chain whose parent isn't known, or null
  // when the chain is known all the way to its root.
  private unknownLink(session: string): string | null {
    let current = session;
    for (let depth = 0; depth < MAX_DEPTH; depth++) {
      if (!this.parents.has(current)) return current;
      const parent = this.parents.get(current);
      if (!parent) return null;
      current = parent;
    }
    return null;
  }

  // Learn `session`'s chain to its root, one lookup per unknown link. Each lookup
  // records an answer, so this ends.
  private async resolveChain(session: string): Promise<void> {
    for (let depth = 0; depth < MAX_DEPTH && !this.stopped; depth++) {
      const missing = this.unknownLink(session);
      if (missing === null) return;
      await this.lookup(missing);
    }
  }

  // One request per session however many events wait on it. A session the service
  // doesn't know, or can't be asked about, is kept as a root: it is then the
  // contact's only if the terminal showed it, which is the case where calling it a
  // root is right (a spawn's session and a shown one are roots).
  private lookup(session: string): Promise<void> {
    let pending = this.lookups.get(session);
    if (pending) return pending;
    pending = Promise.resolve()
      .then(() => this.service.session(session))
      .catch((): ServiceSession | null => null)
      .then((info) => {
        this.lookups.delete(session);
        // A `session.created` that arrived meanwhile is as good an answer.
        if (!this.parents.has(session)) this.parents.set(session, info?.parentID ?? null);
      });
    this.lookups.set(session, pending);
    return pending;
  }

  private async releaseWhenKnown(session: string) {
    await this.resolveChain(session);
    if (this.stopped) return;
    const events = this.held.get(session) ?? [];
    this.held.delete(session);
    for (const event of events) this.apply(event, session);
  }

  // ── Re-sync ───────────────────────────────────────────────────────────────

  // After every (re)connect, a replaced service's included, the stream has missed
  // whatever happened while it was down: a resumed turn's `execution.started` is
  // published before any subscriber can reconnect (spike finding 2, service-restart),
  // a dialog may have been answered elsewhere, a turn may have ended. The snapshot
  // says how things stand; only the difference from what was already reported is
  // raised, so a dialog still open chimes once, not twice.
  private async resync(): Promise<void> {
    if (this.stopped) return;
    const gen = ++this.syncGen;
    const sync: SyncNotes = { sessions: new Set(), settled: new Set(), ended: new Set() };
    this.sync = sync;
    // Dialogs known before any read went out. One of these missing from its session's
    // snapshot was settled, whatever the stream says meanwhile.
    const before = new Set(this.dialogs.keys());
    const current = () => !this.stopped && gen === this.syncGen;
    try {
      const active = await this.read(() => this.service.activeSessions());
      // Unreachable: nothing is known, so nothing changes.
      if (!current() || !active) return;
      // Families of everything running (a subagent may have been created while the
      // stream was down) and of every shown session (a root's end has to know it is one).
      await Promise.all([...active, ...this.shown].map((id) => this.resolveChain(id)));
      if (!current()) return;

      // Dialogs live only on running sessions (spike, "a session waiting on a
      // permission is listed as running"); sessions with a dialog open are read too,
      // to confirm it gone.
      const sessions = new Set<string>();
      for (const id of active) if (this.owned(id)) sessions.add(id);
      for (const dialog of this.dialogs.values()) sessions.add(dialog.session);
      const pending = new Map<string, Map<string, OpenDialog> | null>();
      await Promise.all(
        [...sessions].map(async (id) => {
          const [permissions, forms] = await Promise.all([
            this.read(() => this.service.pendingPermissions(id)),
            this.read(() => this.service.pendingForms(id)),
          ]);
          pending.set(id, permissions && forms ? this.snapshotDialogs(id, permissions, forms) : null);
        })
      );
      if (!current()) return;

      // An owned root running before and not now ended while the stream was down. Its
      // record says how; the end event itself is gone.
      const ended = [...this.running].filter(
        (id) => !active.has(id) && !sync.sessions.has(id) && this.owned(id) && this.isRoot(id)
      );
      const outcomes = new Map<string, ServiceSession["outcome"]>();
      await Promise.all(
        ended.map(async (id) => {
          outcomes.set(id, (await this.read(() => this.service.session(id)))?.outcome);
        })
      );
      if (!current()) return;

      this.applySnapshot(active, pending, ended, outcomes, sync, before);
    } finally {
      if (gen === this.syncGen) this.sync = null;
    }
  }

  private async read<T>(fn: () => Promise<T | null>): Promise<T | null> {
    try {
      return await fn();
    } catch {
      return null;
    }
  }

  private snapshotDialogs(
    session: string,
    permissions: PermissionRequest[],
    forms: FormInfo[]
  ): Map<string, OpenDialog> {
    const dialogs = new Map<string, OpenDialog>();
    for (const request of permissions) {
      if (request.sessionID === session) dialogs.set(request.id, permissionDialog(request));
    }
    for (const form of forms) {
      if (form.sessionID === session) dialogs.set(form.id, formDialog(form));
    }
    return dialogs;
  }

  // Whether `session`, or a session above it, is in `sessions`: a root's end closes
  // its subagents' dialogs too.
  private withinAny(session: string, sessions: Set<string>): boolean {
    let current: string | null | undefined = session;
    for (let depth = 0; current && depth < MAX_DEPTH; depth++) {
      if (sessions.has(current)) return true;
      current = this.parents.get(current);
    }
    return false;
  }

  private applySnapshot(
    active: Set<string>,
    pending: Map<string, Map<string, OpenDialog> | null>,
    ended: string[],
    outcomes: Map<string, ServiceSession["outcome"]>,
    sync: SyncNotes,
    before: Set<string>
  ) {
    // Turns, except where an event spoke since the read.
    const touched = sync.sessions;
    for (const id of this.running) {
      if (!active.has(id) && !touched.has(id)) this.running.delete(id);
    }
    for (const id of active) {
      if (touched.has(id)) continue;
      this.running.add(id);
      this.finishedBySync.delete(id);
    }

    // Roots whose turn ended while away take their dialogs with them. `succeeded` and
    // `failed` are a finish as their events would have been; `interrupted` can't say
    // which reason, and none of the silent ones should chime, so it stays silent, as
    // does a record that couldn't be read.
    let closed: PromptToolCall | undefined;
    const finished: string[] = [];
    const endedRoots = ended.filter((id) => !touched.has(id));
    for (const id of endedRoots) {
      closed = this.closeTree(id) ?? closed;
      const outcome = outcomes.get(id);
      if (outcome === "succeeded" || outcome === "failed") finished.push(id);
    }

    // Dialogs: those gone (answered elsewhere, or dropped with their turn) and those
    // new to us (asked while the stream was down, or by a resumed turn under a new id).
    // A read that failed leaves its session's dialogs as they were. The stream wins
    // where it spoke since the read went out: a dialog raised since isn't judged by the
    // read, and one the read lists isn't taken up if a reply settled it or its turn
    // ended since.
    const fresh: [string, OpenDialog][] = [];
    for (const [session, dialogs] of pending) {
      if (!dialogs) continue;
      for (const [id, dialog] of this.dialogs) {
        if (dialog.session !== session || dialogs.has(id) || !before.has(id)) continue;
        this.dialogs.delete(id);
        closed = dialog.toolCall;
      }
      for (const [id, dialog] of dialogs) {
        if (this.dialogs.has(id) || sync.settled.has(id)) continue;
        if (this.withinAny(dialog.session, sync.ended)) continue;
        if (endedRoots.some((root) => this.inTree(dialog.session, root))) continue;
        fresh.push([id, dialog]);
      }
    }

    // In the order they happened: what closed, the turns that ended, then what is
    // open now, which leaves the contact blocked if anything still is.
    if (closed && this.dialogs.size === 0) this.clearPrompt(closed);
    for (const id of finished) {
      this.finishedBySync.add(id);
      this.onActivity("waiting");
    }
    for (const [id, dialog] of fresh) this.raise(id, dialog);
    if (fresh.length === 0 && (finished.length > 0 || !this.liveOpen())) this.restateNewest();
  }

  // ── Health ────────────────────────────────────────────────────────────────

  private onStatus(status: ServiceStatus) {
    if (this.stopped) return;
    // The client says `unreachable` only after 15 s down (PRD Story 9's threshold), so
    // it shows at once. `connecting` changes nothing: a short outage or a version
    // replacement isn't worth a bar, and one already shown stays until `connected`.
    if (status.state === "unreachable") this.serviceDown = true;
    else if (status.state === "connected") this.serviceDown = false;
    this.reportHealth();
  }

  private notePluginHeard() {
    if (this.pluginHeard) return;
    this.pluginHeard = true;
    if (this.healthTimer !== null) {
      this.timers.clearTimeout(this.healthTimer);
      this.healthTimer = null;
    }
    if (!this.pluginMissing) return;
    this.pluginMissing = false;
    this.reportHealth();
  }

  // One state from both causes, said only when it changes. The service outranks the
  // plugin: without the service nothing at all reaches Multi-Code, while a missing
  // plugin still leaves the spawn's own session watched. So the bar names the service
  // while it is down, and the plugin once the service is back if the plugin is still
  // missing.
  private reportHealth() {
    const state: HealthState = this.serviceDown ? "service" : this.pluginMissing ? "plugin" : "ok";
    if (state === this.reportedHealth) return;
    this.reportedHealth = state;
    if (state === "ok") this.onHooksHealth(true);
    else this.onHooksHealth(false, state);
  }
}
