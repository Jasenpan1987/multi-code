import * as pty from "node-pty";
import { BrowserWindow } from "electron";
import path from "path";

interface Shell {
  id: string;
  cwd: string;
  ptyProcess: pty.IPty;
}

export class ShellManager {
  private shells = new Map<string, Shell>();
  private mainWindow: BrowserWindow | null = null;

  setMainWindow(win: BrowserWindow) {
    this.mainWindow = win;
  }

  /**
   * Spawn a shell for the instance if one does not yet exist.
   * Returns true if a new shell was spawned, false if one already existed.
   */
  spawn(instanceId: string, cwd: string): boolean {
    if (this.shells.has(instanceId)) return false;

    const shellCmd = process.env.SHELL || "/bin/zsh";
    const env = {
      ...process.env,
      PATH: [
        path.join(process.env.HOME || "", ".local/bin"),
        "/opt/homebrew/bin",
        "/usr/local/bin",
        process.env.PATH || "",
      ].join(":"),
    } as Record<string, string>;

    const ptyProcess = pty.spawn(shellCmd, [], {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd,
      env,
    });

    const shell: Shell = { id: instanceId, cwd, ptyProcess };
    this.shells.set(instanceId, shell);

    ptyProcess.onData((data: string) => {
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send("shell-output", instanceId, data);
      }
    });

    ptyProcess.onExit(() => {
      this.shells.delete(instanceId);
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send("shell-exit", instanceId);
      }
    });

    return true;
  }

  has(instanceId: string): boolean {
    return this.shells.has(instanceId);
  }

  write(instanceId: string, data: string) {
    const shell = this.shells.get(instanceId);
    if (shell) shell.ptyProcess.write(data);
  }

  resize(instanceId: string, cols: number, rows: number) {
    const shell = this.shells.get(instanceId);
    if (shell) shell.ptyProcess.resize(cols, rows);
  }

  kill(instanceId: string) {
    const shell = this.shells.get(instanceId);
    if (shell) {
      shell.ptyProcess.kill();
      this.shells.delete(instanceId);
    }
  }

  cleanup() {
    for (const shell of this.shells.values()) {
      shell.ptyProcess.kill();
    }
    this.shells.clear();
  }
}

export const shellManager = new ShellManager();
