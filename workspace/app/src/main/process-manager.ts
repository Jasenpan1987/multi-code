import * as pty from "node-pty";
import { BrowserWindow } from "electron";
import path from "path";
import crypto from "crypto";
import fs from "fs";
import { loadContacts, saveContacts } from "./store";
import type { SavedContact } from "./store";
import { sessionWatcher } from "./session-watcher";

function findClaude(): string {
  const candidates = [
    path.join(process.env.HOME || "", ".local/bin/claude"),
    "/usr/local/bin/claude",
    "/opt/homebrew/bin/claude",
  ];

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }

  return "claude";
}

const claudePath = findClaude();

export interface InstanceInfo {
  id: string;
  cwd: string;
  alias?: string;
  status: "running" | "stopped";
  startedAt: number;
  name: string;
}

interface ManagedInstance {
  id: string;
  cwd: string;
  alias?: string;
  status: "running" | "stopped";
  startedAt: number;
  ptyProcess: pty.IPty | null;
}

export class ProcessManager {
  private instances = new Map<string, ManagedInstance>();
  private mainWindow: BrowserWindow | null = null;

  setMainWindow(win: BrowserWindow) {
    this.mainWindow = win;
    sessionWatcher.setMainWindow(win);
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
        });
      }
    }
    return this.listInstances();
  }

  private persist() {
    const contacts: SavedContact[] = Array.from(this.instances.values()).map(
      (i) => ({ id: i.id, cwd: i.cwd, alias: i.alias })
    );
    saveContacts(contacts);
  }

  createInstance(cwd: string, alias?: string): InstanceInfo {
    const id = crypto.randomUUID();
    const instance = this.spawnProcess(id, cwd, alias);
    this.instances.set(id, instance);
    this.persist();
    return this.toInfo(instance);
  }

  startInstance(id: string): InstanceInfo | null {
    const instance = this.instances.get(id);
    if (!instance) return null;
    if (instance.status === "running") return this.toInfo(instance);

    const started = this.spawnProcess(id, instance.cwd, instance.alias);
    this.instances.set(id, started);
    return this.toInfo(started);
  }

  private spawnProcess(id: string, cwd: string, alias?: string): ManagedInstance {
    const cols = 120;
    const rows = 30;

    const env = {
      ...process.env,
      PATH: [
        path.join(process.env.HOME || "", ".local/bin"),
        "/opt/homebrew/bin",
        "/usr/local/bin",
        process.env.PATH || "",
      ].join(":"),
    } as Record<string, string>;

    const ptyProcess = pty.spawn(claudePath, ["--continue"], {
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
    };

    // Watch the session JSONL for structured events (use cwd to find session)
    sessionWatcher.watchProcess(id, cwd);

    ptyProcess.onData((data: string) => {
      this.mainWindow?.webContents.send("pty-output", id, data);
    });

    ptyProcess.onExit(({ exitCode }) => {
      instance.status = "stopped";
      instance.ptyProcess = null;
      sessionWatcher.unwatch(id);
      this.mainWindow?.webContents.send("instance-exit", id, exitCode);
    });

    return instance;
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
    this.instances.delete(id);
    this.persist();
  }

  restartInstance(id: string): InstanceInfo | null {
    const instance = this.instances.get(id);
    if (!instance) return null;

    if (instance.ptyProcess) {
      instance.ptyProcess.kill();
    }

    const restarted = this.spawnProcess(id, instance.cwd, instance.alias);
    this.instances.set(id, restarted);
    return this.toInfo(restarted);
  }

  listInstances(): InstanceInfo[] {
    return Array.from(this.instances.values()).map((i) => this.toInfo(i));
  }

  hasRunningInstanceAt(cwd: string): boolean {
    for (const instance of this.instances.values()) {
      if (instance.cwd === cwd && instance.status === "running") {
        return true;
      }
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
    };
  }
}

export const processManager = new ProcessManager();
