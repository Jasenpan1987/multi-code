import * as pty from "node-pty";
import { BrowserWindow } from "electron";
import path from "path";
import crypto from "crypto";
import { loadContacts, saveContacts } from "./store";
import type { SavedContact } from "./store";
import { shellManager } from "./shell-manager";
import { PromptDetector } from "./prompt-detector";
import { getBackend } from "./backends";
import type {
  Backend,
  BackendName,
  CompletionDetector,
  SessionDiscovery,
} from "./backends";

export interface InstanceInfo {
  id: string;
  cwd: string;
  alias?: string;
  status: "running" | "stopped";
  startedAt: number;
  name: string;
  sessionId?: string;
  backend: BackendName;
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
  promptDetector: PromptDetector | null;
}

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
          promptDetector: null,
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
      promptDetector: null,
    };

    // Watches the raw PTY text for an interactive prompt waiting on the user
    // (e.g. a yes/no permission box). The JSONL-based CompletionDetector only
    // sees "turn finished" (end_turn) and can't tell an approval-pending
    // tool_use from an auto-approved one, so this fills the gap by reading the
    // on-screen prompt. It reuses the same "instance-activity" event, so the
    // renderer beeps exactly as it does for a finished turn.
    instance.promptDetector = new PromptDetector(() => {
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send("instance-activity", id, "prompt");
      }
    });

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
        tracked.detector = backend.createCompletionDetector(
          sessionId,
          (type) => {
            if (this.mainWindow && !this.mainWindow.isDestroyed()) {
              this.mainWindow.webContents.send("instance-activity", id, type);
            }
          }
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
      instance.promptDetector?.feed(data);
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send("pty-output", id, data);
      }
    });

    ptyProcess.onExit(({ exitCode }) => {
      instance.status = "stopped";
      instance.ptyProcess = null;
      this.teardownObservers(instance);
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send("instance-exit", id, exitCode);
      }
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
    // PromptDetector holds no timers/resources, just drop the reference.
    instance.promptDetector = null;
  }

  writeToInstance(id: string, data: string) {
    const instance = this.instances.get(id);
    if (instance?.ptyProcess) {
      instance.ptyProcess.write(data);
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
    return this.toInfo(restarted);
  }

  listInstances(): InstanceInfo[] {
    return Array.from(this.instances.values()).map((i) => this.toInfo(i));
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
    };
  }
}

export const processManager = new ProcessManager();
