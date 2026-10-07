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
  Backend,
  BackendName,
  HookAttention,
  PromptToolCall,
  SessionDiscovery,
  SpawnOptions,
} from "./backends";
import type { PromptDetail } from "./remote/promptExtract";
import { remoteServer } from "./remote/ws-server";
import type { TranscriptEntry } from "../shared/remote-protocol";
import type { ContextUsage } from "../shared/types";
import { moveInOrder } from "../shared/reorder";
import { debugTrace } from "./debug-trace";
import { RunStateTracker, type RunState, type WriteVerdict } from "./run-state";
import { INSTANCE_ENV, SPAWN_ENV } from "./backends/instance-env";

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
  isManager?: boolean;
  // Only meaningful while running; `status` already says stopped.
  runState?: RunState;
  // This instance's hooks aren't reaching Multi-Code, so it raises no alerts (PRD
  // Story 6). The renderer shows a bar on its page.
  alertsDegraded?: boolean;
}

/**
 * The latest Finished or Needs-you a Claude instance raised that nobody has dealt
 * with yet: what the voice secretary writes its brief from, and what it checks
 * before answering (docs/specs/voice-secretary/prd.md, Stories 2 and 6).
 *
 * `seq` is unique per event and only ever grows for an instance, across restarts
 * too, so "is this still the event I was working on" is one comparison.
 * `prompt` is there when the dialog decoded into options: the detail the phone
 * would show, plus the tool call exactly as the agent sent it (for a Bash
 * permission, `toolInput.command` is the command). Read-only for consumers.
 */
export interface SecretaryEvent {
  kind: "finished" | "needs-you";
  seq: number;
  at: number;
  prompt?: { detail: PromptDetail; toolName: string; toolInput: unknown };
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
  // Timestamp (Date.now()) of the last PTY byte received from this instance. Feeds
  // the write-safety gate's "did that write land" check and `start_session`'s
  // readiness wait, never activity detection.
  lastPtyByteAt: number;
  // Cached context usage plus when it was read. Optional so the two places that
  // build a ManagedInstance don't need to seed them; absent means "never read".
  contextUsage?: ContextUsage;
  contextUsageAt?: number;
  // When this instance last reported activity (a turn ending, or blocking on a
  // prompt). Distinct from lastPtyByteAt, which moves on every repaint of the
  // spinner. Absent until the first activity.
  lastActivityAt?: number;
  // The coordinator instance. Spawned with the manager MCP tools attached; at most
  // one exists.
  isManager?: boolean;
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
  // Whether it is safe to write to this instance right now. See run-state.ts for
  // the hazard this exists to prevent.
  runState: RunStateTracker;
  // Its hooks don't run, so nothing will alert for it. Per process: a restart
  // builds a fresh instance and starts out trusting its hooks again.
  alertsDegraded?: boolean;
  // Minted per spawn and handed to the agent's hooks (SPAWN_ENV), so a late
  // delivery from the process a restart replaced can be told apart. Absent on a
  // contact that has never been spawned in this run.
  spawnId?: string;
  // See SecretaryEvent. Never set on the manager or on a backend that doesn't keep
  // them; cleared when the builder deals with it, and on exit.
  secretaryEvent?: SecretaryEvent;
}

// Reading context usage parses a transcript that reaches 8MB+, and
// listInstances() runs on every phone broadcast, so the read is throttled
// instead of happening per call. A turn takes far longer than this to complete,
// so nothing user-visible lags behind.
const CONTEXT_USAGE_TTL_MS = 20_000;

const DEFAULT_BACKEND: BackendName = "claude";

// How long to let the slash-command autocomplete menu draw before submitting, and
// again between the two submissions. Both CLIs render a TUI frame in well under
// this; the cost of being generous is a fifth of a second on a command the manager
// then waits seconds for anyway.
const MENU_SETTLE_MS = 120;

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
  private activityListeners = new Set<(id: string, type: string) => void>();
  private secretaryListeners = new Set<SecretaryEventListener>();
  // One counter for every instance's secretary events. A per-record one would
  // restart at zero when start or restart builds a fresh record, and an old
  // event's seq could then outrank the new spawn's.
  private secretarySeq = 0;
  // Set from outside rather than resolved here: the options carry the manager MCP
  // server's port and bearer token, and importing that module would close a cycle
  // (it imports this one to reach the instance list). main/index.ts and the
  // create-manager IPC handler own the ordering — start the server, then set this,
  // then spawn.
  private managerSpawnOptions: SpawnOptions | null = null;
  // What every other Claude instance spawns with: the alert hooks' settings file.
  // Set once at startup, after the server that the hooks report to is listening.
  // Null when it isn't, and sessions then spawn without alert hooks.
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
  // paired phone and the manager read would be the old one too.
  private syncLiveSessionId(instance: ManagedInstance) {
    const ptyProcess = instance.ptyProcess;
    // A stopped instance has no live session to follow; its read paths already
    // fall back to whatever this directory last worked on.
    if (!ptyProcess) return;

    let live: string | null;
    try {
      live = getBackend(instance.backend).findLiveSessionId(
        instance.cwd,
        ptyProcess.pid
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

  // Whether any *other* instance is already reading this session.
  private isSessionClaimedBy(sessionId: string, exceptId: string): boolean {
    for (const other of this.instances.values()) {
      if (other.id !== exceptId && other.sessionId === sessionId) return true;
    }
    return false;
  }

  setManagerSpawnOptions(opts: SpawnOptions | null) {
    this.managerSpawnOptions = opts;
  }

  setSessionSpawnOptions(opts: SpawnOptions | null) {
    this.sessionSpawnOptions = opts;
  }

  // Subscribe to activity from any instance, returning an unsubscribe function.
  //
  // Exists for the manager's `wait_for_idle`, which has to know the moment a turn
  // ends. The alternative was polling a transcript, and polling is what made the
  // manager slow: each poll costs it a whole model turn to decide to poll again, so
  // waiting on one session ran into minutes. A listener costs nothing while idle.
  //
  // `type` is the instance's activity event, plus `exit` when the pty dies — a waiter
  // has to give up on a session that is no longer there.
  onActivity(listener: (id: string, type: string) => void): () => void {
    this.activityListeners.add(listener);
    return () => {
      this.activityListeners.delete(listener);
    };
  }

  private emitActivity(id: string, type: string) {
    for (const listener of this.activityListeners) {
      try {
        listener(id, type);
      } catch {
        // A broken waiter must not take down the activity callback that feeds
        // every other consumer of this event.
      }
    }
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

  // What the secretary's brief writer reads for an instance: the name the builder
  // knows it by, and the session it is on now. The live session is re-checked
  // first rather than waiting for the next poll, so a turn that ends within
  // seconds of a `/clear` is read from the new transcript, not the abandoned one.
  // Null for an id that isn't an instance.
  secretarySource(id: string): { name: string; sessionId?: string } | null {
    const instance = this.instances.get(id);
    if (!instance) return null;
    this.syncLiveSessionId(instance);
    return {
      name: instance.alias || path.basename(instance.cwd),
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
    toolCall?: PromptToolCall
  ) {
    if (type === "prompt-cleared") {
      if (instance.secretaryEvent?.kind === "needs-you") {
        this.clearSecretaryEvent(instance);
      }
      return;
    }
    if (type !== "waiting" && type !== "prompt") return;
    // The manager has no secretary in v1 (PRD Story 2); the backend says whether
    // its instances do.
    if (instance.isManager || !getBackend(instance.backend).keepsSecretaryEvents) {
      return;
    }
    // A record a restart has replaced reports nothing any more.
    if (this.instances.get(instance.id) !== instance) return;

    const seq = ++this.secretarySeq;
    const at = Date.now();
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
                  },
                }
              : {}),
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
  // keys at the desk, the compose box, a paired phone, the manager. Any of them
  // means the session's pending event has been dealt with, a needs-you included:
  // the CLI reports nothing at all when a dialog is denied (fixtures
  // permission-denied-no, permission-denied-esc), so the keystroke is the only
  // sign. Focus reports alone don't count; see carriesInput.
  private noteWrite(instance: ManagedInstance, data: string) {
    instance.runState.onWrite();
    if (carriesInput(data)) this.clearSecretaryEvent(instance);
  }

  // The manager is a singleton. Callers check before offering to create one, and
  // createInstance refuses a second regardless.
  hasManager(): boolean {
    for (const instance of this.instances.values()) {
      if (instance.isManager) return true;
    }
    return false;
  }

  // Put the manager first in storage, once.
  //
  // The contact list used to pin it to the top at render time, so its stored position
  // was wherever it happened to be created — last, for anyone who added it after their
  // projects. Now that the list is drag-reorderable, the stored order *is* the display
  // order, and leaving that render-time sort in place would mean the one row the user
  // can't move. Without this migration the manager would appear to jump to the bottom
  // the first time they open the new build.
  //
  // Runs at most once: after it writes, the manager is already first.
  private migrateManagerToTop(saved: SavedContact[]): SavedContact[] {
    const at = saved.findIndex((c) => c.isManager);
    if (at <= 0) return saved;
    const reordered = [saved[at], ...saved.filter((_, i) => i !== at)];
    saveContacts(reordered);
    return reordered;
  }

  loadSavedContacts(): InstanceInfo[] {
    const saved = this.migrateManagerToTop(loadContacts());
    for (const contact of saved) {
      if (!this.instances.has(contact.id)) {
        this.instances.set(contact.id, {
          id: contact.id,
          cwd: contact.cwd,
          alias: contact.alias,
          status: "stopped",
          startedAt: 0,
          ptyProcess: null,
          backend: contact.backend ?? DEFAULT_BACKEND,
          discovery: null,
          hookAttention: null,
          lastPtyByteAt: 0,
          isManager: contact.isManager,
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
        isManager: i.isManager,
      })
    );
    saveContacts(contacts);
  }

  createInstance(
    cwd: string,
    alias?: string,
    backend: BackendName = DEFAULT_BACKEND,
    isManager = false
  ): InstanceInfo {
    if (isManager) {
      if (this.hasManager()) {
        throw new Error("A manager already exists; only one is supported.");
      }
      // The manager's tools depend on `--allowedTools`, which OpenCode has no
      // equivalent for — it would stop for a permission prompt on every call.
      // Refuse rather than create one that can't coordinate.
      if (backend !== "claude") {
        throw new Error(`The manager must run on claude, not ${backend}.`);
      }
    }

    const id = crypto.randomUUID();
    const instance = this.spawnProcess(id, cwd, alias, backend, isManager);
    this.instances.set(id, instance);
    this.persist();
    remoteServer.broadcastInstances();
    return this.toInfo(instance);
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
      instance.isManager
    );
    this.instances.set(id, started);
    remoteServer.broadcastInstances();
    const info = this.toInfo(started);
    // Push to the renderer as well as returning, because this is no longer only
    // reached from an IPC call the renderer made. The manager's `start_session`
    // tool calls it directly, and without this the desktop went on showing the
    // session as OFFLINE while its process was up and working — observed
    // 2026-09-15, with a live `claude --continue` behind an OFFLINE panel.
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send("instance-started", info);
    }
    return info;
  }

  private spawnProcess(
    id: string,
    cwd: string,
    alias: string | undefined,
    backendName: BackendName,
    isManager?: boolean
  ): ManagedInstance {
    const cols = 120;
    const rows = 30;

    const backend: Backend = getBackend(backendName);
    // Manager options only for the manager. A project session must never get the
    // fleet-driving tools, which is why this is keyed off the instance rather than
    // applied globally. Sessions get the alert hooks or plugin alone.
    const opts = isManager ? this.managerSpawnOptions : this.sessionSpawnOptions;
    const spawnedWithoutAlertHooks =
      backendName === "claude" ? !opts?.settingsPath : !opts?.opencodePlugin;
    if (spawnedWithoutAlertHooks) {
      debugTrace(
        `[alert-hook] ${id.slice(0, 8)} spawned without alert hooks (server not listening or files unwritable)`
      );
    }
    const { command, args, env } = backend.spawn(cwd, opts ?? undefined);

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
      lastPtyByteAt: Date.now(),
      isManager,
      runState: new RunStateTracker(),
      alertsDegraded: spawnedWithoutAlertHooks || undefined,
      spawnId,
    };

    // Created at spawn, before any session exists: the hooks report from the
    // process's first moment, and keep reporting across /clear.
    instance.hookAttention = backend.createHookAttention(
      ptyProcess.pid,
      (type, detail, toolCall) =>
        this.reportActivity(instance, type, detail, toolCall),
      (ok) => this.setAlertsDegraded(instance, !ok)
    );

    const isSessionClaimed = (candidate: string): boolean =>
      this.isSessionClaimedBy(candidate, id);

    instance.discovery = backend.discoverSessionId(
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
      instance.lastPtyByteAt = Date.now();
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
      // A dead process has no dialog to answer and no turn to report on.
      this.clearSecretaryEvent(instance);
      this.teardownObservers(instance);
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send("instance-exit", id, exitCode);
      }
      remoteServer.broadcastExit(id, exitCode);
      // Wakes anything waiting on this instance to finish a turn. Without it a
      // waiter would sit out its whole timeout on a session that has gone.
      this.emitActivity(id, "exit");
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
  }

  // One activity event, from the agent's own reports, to everything that
  // listens: run state, the renderer's chime and red dot, a paired phone, the
  // manager's waiters, and the secretary.
  private reportActivity(
    instance: ManagedInstance,
    type: string,
    detail?: PromptDetail,
    toolCall?: PromptToolCall
  ) {
    const id = instance.id;
    debugTrace(`[activity] ${id.slice(0, 8)} ${type} at ${new Date().toISOString()}`);
    instance.runState.onActivity(type);
    // Recorded for every activity except the bookkeeping one, so the manager can
    // tell a session that just finished from one that has been idle for hours.
    if (type !== "prompt-cleared") instance.lastActivityAt = Date.now();
    // A finished turn is exactly when context usage moved, so refresh now instead
    // of waiting for the TTL. Cheap: once per turn, not per list call.
    if (type === "waiting") this.refreshContextUsage(instance);
    // Before anything else hears of it, so a write made in reaction to this
    // activity clears the event it raised instead of landing before it exists.
    this.updateSecretaryEvent(instance, type, detail, toolCall);
    // "prompt-cleared" exists for paired phones (drop the stale option buttons);
    // the desktop UI has nothing to do with it, so it isn't forwarded to the
    // renderer.
    if (type !== "prompt-cleared" && this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send("instance-activity", id, type);
    }
    remoteServer.broadcastActivity(id, type, detail);
    this.emitActivity(id, type);
  }

  private setAlertsDegraded(instance: ManagedInstance, degraded: boolean) {
    if (!!instance.alertsDegraded === degraded) return;
    instance.alertsDegraded = degraded || undefined;
    debugTrace(
      `[alert-hook] ${instance.id.slice(0, 8)} hooks ${degraded ? "not running: alerts off" : "running again"} at ${new Date().toISOString()}`
    );
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send("instance-alerts-degraded", instance.id, degraded);
    }
  }

  // A hook delivery from the `/alert` endpoint, routed to the instance that sent
  // it. Wired in manager-mcp/index.ts, which owns the server; this module must not
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

  // Whether it is safe for something automated to write to this instance right now.
  // Deliberately not consulted by writeToInstance or sendPrompt: those carry the
  // user's own keystrokes from the desktop or their phone, and the user is allowed to
  // answer a dialog. This gate is for writes nobody is watching — see run-state.ts.
  canAcceptWrite(id: string): WriteVerdict {
    const instance = this.instances.get(id);
    if (!instance) return { ok: false, reason: "no such instance" };
    if (!instance.ptyProcess) {
      return { ok: false, reason: "not running — start it in Multi-Code first" };
    }
    return instance.runState.canAcceptWrite(Date.now() - instance.lastPtyByteAt);
  }

  runStateOf(id: string): RunState | undefined {
    const instance = this.instances.get(id);
    if (!instance?.ptyProcess) return undefined;
    return instance.runState.state();
  }

  // How long this instance's terminal has been quiet. Undefined when it isn't
  // running. Used by `start_session` to tell a CLI that has finished painting from
  // one still booting — a session resumed with `--continue` never reports a finished
  // turn, so silence is the only signal available there.
  msSincePtyByte(id: string): number | undefined {
    const instance = this.instances.get(id);
    if (!instance?.ptyProcess) return undefined;
    return Date.now() - instance.lastPtyByteAt;
  }

  writeToInstance(id: string, data: string) {
    const instance = this.instances.get(id);
    if (instance?.ptyProcess) {
      this.noteWrite(instance, data);
      instance.ptyProcess.write(data);
      // Typing at the desk answers whatever was pending, so drop the phone's
      // badge and stale option buttons now rather than waiting for the agent to
      // report it. Harmless when nothing was pending.
      remoteServer.clearActivity(id);
    }
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

  // Dispatch a task to an instance on behalf of something automated, refusing when
  // the target isn't safe to write to. Separate from sendPrompt, which carries the
  // user's own keystrokes and is theirs to aim wherever they like.
  //
  // Writing to a *busy* target is fine and deliberate: the CLI queues it, verified
  // 2026-09-02 — the screen showed `queued` and the task ran once the current turn
  // finished. Don't add a queue of our own on top of that one.
  trySendTask(id: string, text: string): WriteVerdict {
    const verdict = this.canAcceptWrite(id);
    if (!verdict.ok) return verdict;
    this.sendPrompt(id, text);
    return { ok: true };
  }

  // Run a slash command in an instance, on behalf of something automated.
  //
  // Separate from trySendTask because a slash command is not text: **a leading `/`
  // opens the CLI's autocomplete menu, and that menu swallows the first carriage
  // return.** A command delivered the way a task is delivered arrives on screen and
  // never runs, which is exactly the failure the user hit — the manager reported
  // "sent but not executed" and was telling the truth.
  //
  // So: type the command, let the menu render, submit it, then submit again. The
  // delay matters as much as the second return; both returns fired back-to-back land
  // before the menu has drawn and the second one is swallowed too.
  //
  // No bracketed paste here, unlike sendPrompt. Pasted text is what the TUI folds
  // into a `[Pasted text]` placeholder, and a placeholder is not a command.
  tryRunCommand(id: string, command: string): WriteVerdict {
    const verdict = this.canAcceptWrite(id);
    if (!verdict.ok) return verdict;

    const instance = this.instances.get(id);
    if (!instance?.ptyProcess) {
      return { ok: false, reason: "not running — start it in Multi-Code first" };
    }

    const ptyProcess = instance.ptyProcess;
    // Everything this call writes, the two returns below included.
    this.noteWrite(instance, `${command}\r\r`);
    ptyProcess.write(command);
    // Fire-and-forget: the caller gets its verdict now rather than holding the tool
    // call open for a quarter of a second. A write to a pty that exits in between is
    // swallowed by node-pty, so the re-check is about correctness of state, not
    // about avoiding a throw.
    setTimeout(() => {
      const still = this.instances.get(id);
      if (still?.ptyProcess !== ptyProcess) return;
      ptyProcess.write("\r");
      setTimeout(() => {
        const alive = this.instances.get(id);
        if (alive?.ptyProcess !== ptyProcess) return;
        ptyProcess.write("\r");
      }, MENU_SETTLE_MS);
    }, MENU_SETTLE_MS);

    return { ok: true };
  }

  // Ask the backend that owns this instance how to select option `index`.
  // Routed through the backend because the CLIs use different keys and a wrong
  // guess can confirm the wrong choice — see Backend.keystrokeForChoice.
  keystrokeForChoice(
    id: string,
    tool: string,
    index: number,
    optionCount: number
  ): string | null {
    const instance = this.instances.get(id);
    if (!instance) return null;
    return getBackend(instance.backend).keystrokeForChoice(
      tool,
      index,
      optionCount
    );
  }

  // Reflowable conversation tail for the phone and for the manager's read tools.
  // Empty when neither a live nor a disk-resolved session exists, or when the
  // backend can't read it.
  readTranscript(id: string, limit: number): TranscriptEntry[] {
    const instance = this.instances.get(id);
    if (!instance) return [];
    const sessionId = this.readableSessionId(instance);
    if (!sessionId) return [];
    try {
      return getBackend(instance.backend).readTranscript(sessionId, limit);
    } catch {
      return [];
    }
  }

  // Whether this instance has any transcript to read, live or from disk. Lets a
  // caller give a specific reason rather than an empty list.
  hasReadableTranscript(id: string): boolean {
    const instance = this.instances.get(id);
    return !!instance && this.readableSessionId(instance) !== undefined;
  }

  // The session id read paths should use: the live one when there is one, otherwise
  // whatever this directory last worked on.
  //
  // A stopped contact has no live id at all after an app restart — contacts.json
  // doesn't store one — which is why every stopped session reported
  // `context=unknown` and could not be read. The lookup touches the filesystem or
  // sqlite, so it is cached, including the negative result.
  private readableSessionId(instance: ManagedInstance): string | undefined {
    if (instance.sessionId) return instance.sessionId;

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
    }
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
      // Must be carried through, or restarting the manager silently produces one
      // with no tools — it would look alive and be unable to do anything.
      instance.isManager
    );
    this.instances.set(id, restarted);
    remoteServer.broadcastInstances();
    return this.toInfo(restarted);
  }

  listInstances(): InstanceInfo[] {
    this.refreshStaleContextUsage();
    return Array.from(this.instances.values()).map((i) => this.toInfo(i));
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
    const sessionId = this.readableSessionId(instance);
    if (!sessionId) return;
    instance.contextUsageAt = Date.now();
    try {
      const usage = getBackend(instance.backend).readContextUsage(sessionId);
      // Keep the last known figure when a read comes back empty. A stopped
      // instance still has a real transcript, and a transient failure (sqlite
      // locked mid-write) shouldn't blank a number the user was reading.
      if (usage) instance.contextUsage = usage;
    } catch {
      // Backends are documented to return null rather than throw, but a
      // surprise here must not take down a list call.
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

  setAlias(id: string, alias: string) {
    const instance = this.instances.get(id);
    if (instance) {
      instance.alias = alias;
      this.persist();
      remoteServer.broadcastInstances();
    }
  }

  // Instances a quit would cut off mid-task: a turn still running, or a dialog
  // waiting on the user. Idle ones are left out: they lose nothing, since the next
  // start picks the session up with --continue, and counting them would mean asking
  // on every quit.
  unfinishedInstances(): { name: string; state: "busy" | "blocked" }[] {
    const unfinished: { name: string; state: "busy" | "blocked" }[] = [];
    for (const instance of this.instances.values()) {
      if (!instance.ptyProcess) continue;
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
      isManager: instance.isManager,
      runState: instance.ptyProcess ? instance.runState.state() : undefined,
      alertsDegraded: instance.ptyProcess ? instance.alertsDegraded : undefined,
    };
  }
}

export const processManager = new ProcessManager();
