import * as pty from "node-pty";
import { BrowserWindow } from "electron";
import path from "path";
import crypto from "crypto";
import { loadContacts, saveContacts } from "./store";
import type { SavedContact } from "./store";
import { shellManager } from "./shell-manager";
import { getBackend } from "./backends";
import type {
  Backend,
  BackendName,
  CompletionDetector,
  SessionDiscovery,
  SpawnOptions,
} from "./backends";
import { remoteServer } from "./remote/ws-server";
import type { TranscriptEntry } from "../shared/remote-protocol";
import type { ContextUsage } from "../shared/types";
import { moveInOrder } from "../shared/reorder";
import { debugTrace } from "./debug-trace";
import { RunStateTracker, type RunState, type WriteVerdict } from "./run-state";

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
  detector: CompletionDetector | null;
  // Timestamp (Date.now()) of the last PTY byte received from this instance.
  // Used by the backend's CompletionDetector to tell "screen static (waiting
  // on user)" apart from "spinner ticking (running tool/subagent)".
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
  // Set from outside rather than resolved here: the options carry the manager MCP
  // server's port and bearer token, and importing that module would close a cycle
  // (it imports this one to reach the instance list). main/index.ts and the
  // create-manager IPC handler own the ordering — start the server, then set this,
  // then spawn.
  private managerSpawnOptions: SpawnOptions | null = null;

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
  // previous session's figure, which is how it was reported. The unseen half is
  // worse: the completion detector, and therefore notifications, prompt detection
  // for a paired phone, and the write-safety gate, all keep watching the old
  // transcript.
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

  // Subscribe to activity from any instance, returning an unsubscribe function.
  //
  // Exists for the manager's `wait_for_idle`, which has to know the moment a turn
  // ends. The alternative was polling a transcript, and polling is what made the
  // manager slow: each poll costs it a whole model turn to decide to poll again, so
  // waiting on one session ran into minutes. A listener costs nothing while idle.
  //
  // `type` is the backend detector's event, plus `exit` when the pty dies — a waiter
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
        // A broken waiter must not take down the detector callback that feeds
        // every other consumer of this event.
      }
    }
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
          detector: null,
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
    // applied globally.
    const { command, args, env } = backend.spawn(
      cwd,
      isManager ? (this.managerSpawnOptions ?? undefined) : undefined
    );

    const ptyProcess = pty.spawn(command, args, {
      name: "xterm-256color",
      cols,
      rows,
      cwd,
      env,
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
      detector: null,
      lastPtyByteAt: Date.now(),
      isManager,
      runState: new RunStateTracker(),
    };

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
      // Backends whose blocking state is only visible on screen (OpenCode's
      // permission dialog) read it from here. Claude's detector doesn't
      // implement this, so the call is optional.
      instance.detector?.onPtyData?.(data);
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

  // Point every read path at `sessionId` and start watching it.
  //
  // Called from discovery at spawn, and again whenever a running process moves to
  // a different session. A session id is not stable for the life of a process:
  // `/new` and `/clear` start a fresh transcript under a new id and never write to
  // the old file again (measured 2026-09-17). Rebuilding the detector is the part
  // that matters most, and the part with no visible symptom — it feeds completion
  // notifications, the prompt detection a paired phone renders, and the
  // write-safety gate, all of which go quiet on a transcript nobody is writing.
  private attachSession(instance: ManagedInstance, sessionId: string) {
    const id = instance.id;
    const backend = getBackend(instance.backend);

    // Stopped, not merely replaced: two detectors on one instance would report
    // every turn twice, and the outgoing one is polling a file that will never
    // change again.
    if (instance.detector) {
      instance.detector.stop();
      instance.detector = null;
    }

    // Relies on a detector starting from the transcript's *current* end rather
    // than its beginning (claude.ts:279 takes stat.size in its constructor). If
    // that ever changes, attaching to a session that already has content would
    // replay its whole history as fresh activity — every past turn firing a
    // notification at once.

    instance.sessionId = sessionId;
    // The cached usage belongs to the session we just left, and `/new` resets it
    // to zero. Dropping the timestamp too forces the next read instead of showing
    // the old session's figure for up to the TTL.
    instance.contextUsage = undefined;
    instance.contextUsageAt = undefined;
    // Disk-resolved fallbacks are stale for the same reason.
    instance.resolvedSessionId = undefined;
    instance.resolvedSessionIdAt = undefined;

    instance.detector = backend.createCompletionDetector(
      sessionId,
      (type, detail) => {
        debugTrace(
          `[activity] ${id.slice(0, 8)} ${type} at ${new Date().toISOString()}`
        );
        instance.runState.onActivity(type);
        // Recorded for every activity except the bookkeeping one, so the
        // manager can tell a session that just finished from one that has
        // been idle for hours.
        if (type !== "prompt-cleared") instance.lastActivityAt = Date.now();
        // A finished turn is exactly when context usage moved, so refresh
        // now instead of waiting for the TTL. Cheap: once per turn, not per
        // list call.
        if (type === "waiting") this.refreshContextUsage(instance);
        // "prompt-cleared" exists for paired phones (drop the stale option
        // buttons); the desktop UI has nothing to do with it, so it isn't
        // forwarded to the renderer.
        if (
          type !== "prompt-cleared" &&
          this.mainWindow &&
          !this.mainWindow.isDestroyed()
        ) {
          this.mainWindow.webContents.send("instance-activity", id, type);
        }
        remoteServer.broadcastActivity(id, type, detail);
        this.emitActivity(id, type);
      },
      (ms) => Date.now() - instance.lastPtyByteAt >= ms
    );

    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send("instance-session-id", id, sessionId);
    }
  }

  private teardownObservers(instance: ManagedInstance) {
    if (instance.discovery) {
      instance.discovery.cancel();
      instance.discovery = null;
    }
    if (instance.detector) {
      instance.detector.stop();
      instance.detector = null;
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
      instance.runState.onWrite();
      instance.ptyProcess.write(data);
      // Typing at the desk answers whatever was pending, so drop the phone's
      // badge and stale option buttons now rather than waiting for the detector
      // to notice. Harmless when nothing was pending.
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
    instance.runState.onWrite();
    instance.ptyProcess.write(`\x1b[200~${text}\x1b[201~`);
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
    instance.runState.onWrite();
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
    if (instance) this.teardownObservers(instance);
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
    };
  }
}

export const processManager = new ProcessManager();
