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
} from "./backends";
import { remoteServer } from "./remote/ws-server";
import type { TranscriptEntry } from "../shared/remote-protocol";
import type { ContextUsage } from "../shared/types";
import { debugTrace } from "./debug-trace";

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
}

// Reading context usage parses a transcript that reaches 8MB+, and
// listInstances() runs on every phone broadcast, so the read is throttled
// instead of happening per call. A turn takes far longer than this to complete,
// so nothing user-visible lags behind.
const CONTEXT_USAGE_TTL_MS = 20_000;

const DEFAULT_BACKEND: BackendName = "claude";

export class ProcessManager {
  private instances = new Map<string, ManagedInstance>();
  private mainWindow: BrowserWindow | null = null;

  setMainWindow(win: BrowserWindow) {
    this.mainWindow = win;
  }

  loadSavedContacts(): InstanceInfo[] {
    const saved = loadContacts();
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
        });
      }
    }
    return this.listInstances();
  }

  private persist() {
    const contacts: SavedContact[] = Array.from(this.instances.values()).map(
      (i) => ({
        id: i.id,
        cwd: i.cwd,
        alias: i.alias,
        backend: i.backend,
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
    const instance = this.spawnProcess(id, cwd, alias, backend);
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
      instance.backend
    );
    this.instances.set(id, started);
    remoteServer.broadcastInstances();
    return this.toInfo(started);
  }

  private spawnProcess(
    id: string,
    cwd: string,
    alias: string | undefined,
    backendName: BackendName
  ): ManagedInstance {
    const cols = 120;
    const rows = 30;

    const backend: Backend = getBackend(backendName);
    const { command, args, env } = backend.spawn(cwd);

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
    };

    const isSessionClaimed = (candidate: string): boolean => {
      for (const other of this.instances.values()) {
        if (other.id !== id && other.sessionId === candidate) return true;
      }
      return false;
    };

    instance.discovery = backend.discoverSessionId(
      cwd,
      (sessionId) => {
        const tracked = this.instances.get(id);
        if (!tracked) return;
        // Final guard: if another instance claimed this id between
        // discovery's check and now, drop this assignment so the next
        // poll picks a different jsonl.
        if (isSessionClaimed(sessionId)) return;
        tracked.sessionId = sessionId;
        debugTrace(
          `[discovery] ${id.slice(0, 8)} backend=${tracked.backend} session=${sessionId} at ${new Date().toISOString()}`
        );
        tracked.detector = backend.createCompletionDetector(
          sessionId,
          (type, detail) => {
            debugTrace(
              `[activity] ${id.slice(0, 8)} ${type} at ${new Date().toISOString()}`
            );
            // A finished turn is exactly when context usage moved, so refresh
            // now instead of waiting for the TTL. Cheap: once per turn, not per
            // list call.
            if (type === "waiting") this.refreshContextUsage(tracked);
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
          },
          (ms) => Date.now() - tracked.lastPtyByteAt >= ms
        );
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
          this.mainWindow.webContents.send(
            "instance-session-id",
            id,
            sessionId
          );
        }
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
      this.teardownObservers(instance);
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send("instance-exit", id, exitCode);
      }
      remoteServer.broadcastExit(id, exitCode);
    });

    return instance;
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

  writeToInstance(id: string, data: string) {
    const instance = this.instances.get(id);
    if (instance?.ptyProcess) {
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
    instance.ptyProcess.write(`\x1b[200~${text}\x1b[201~`);
    instance.ptyProcess.write("\r");
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

  // Reflowable conversation tail for the phone. Empty until the session has been
  // discovered, or when the backend can't read it.
  readTranscript(id: string, limit: number): TranscriptEntry[] {
    const instance = this.instances.get(id);
    if (!instance?.sessionId) return [];
    try {
      return getBackend(instance.backend).readTranscript(
        instance.sessionId,
        limit
      );
    } catch {
      return [];
    }
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
      instance.backend
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
  private refreshStaleContextUsage() {
    const now = Date.now();
    for (const instance of this.instances.values()) {
      if (!instance.sessionId) continue;
      if (now - (instance.contextUsageAt ?? 0) < CONTEXT_USAGE_TTL_MS) continue;
      this.refreshContextUsage(instance);
    }
  }

  private refreshContextUsage(instance: ManagedInstance) {
    if (!instance.sessionId) return;
    instance.contextUsageAt = Date.now();
    try {
      const usage = getBackend(instance.backend).readContextUsage(
        instance.sessionId
      );
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
    };
  }
}

export const processManager = new ProcessManager();
