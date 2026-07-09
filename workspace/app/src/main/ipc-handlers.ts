import { ipcMain, dialog, BrowserWindow, app, clipboard, shell } from "electron";
import { spawn } from "child_process";
import { writeFileSync, rmSync, statSync, readFileSync } from "fs";
import { tmpdir, homedir } from "os";
import { join, resolve, dirname, basename, extname } from "path";
import { processManager } from "./process-manager";
import { shellManager } from "./shell-manager";
import { getGitStatus } from "./git-status";
import { isBackendAvailable } from "./backends";
import type { BackendName } from "./backends";
import { loadSettings, saveSettings } from "./settings-store";
import type { ThemeName } from "./settings-store";
import type { ReadFileResult } from "../shared/types";

// Per-process counter to disambiguate temp image filenames within the same ms.
let tempImageCounter = 0;
// Filenames produced by save-clipboard-image; used to gate delete-temp-image.
const TEMP_IMAGE_NAME = /^multicode-paste-\d+-\d+\.png$/;

export function registerIpcHandlers() {
  ipcMain.handle(
    "create-instance",
    (_event, cwd: string, alias?: string, backend?: BackendName) => {
      return processManager.createInstance(cwd, alias, backend);
    }
  );

  ipcMain.handle(
    "is-backend-available",
    (_event, backend: BackendName) => {
      return isBackendAvailable(backend);
    }
  );

  ipcMain.handle("kill-instance", (_event, id: string) => {
    processManager.killInstance(id);
  });

  ipcMain.handle("remove-instance", (_event, id: string) => {
    processManager.removeInstance(id);
  });

  ipcMain.handle("restart-instance", (_event, id: string) => {
    return processManager.restartInstance(id);
  });

  ipcMain.handle("list-instances", () => {
    return processManager.listInstances();
  });

  ipcMain.handle("load-contacts", () => {
    return processManager.loadSavedContacts();
  });

  ipcMain.handle("start-instance", (_event, id: string) => {
    return processManager.startInstance(id);
  });

  ipcMain.handle(
    "has-running-instance-at",
    (_event, cwd: string, backend?: BackendName) => {
      return processManager.hasRunningInstanceAt(cwd, backend);
    }
  );

  ipcMain.handle("set-alias", (_event, id: string, alias: string) => {
    processManager.setAlias(id, alias);
  });

  ipcMain.handle("select-directory", async () => {
    const win = BrowserWindow.getFocusedWindow();
    if (!win) return null;
    const result = await dialog.showOpenDialog(win, {
      properties: ["openDirectory"],
      title: "Select project directory",
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  ipcMain.handle("get-git-status", async (_event, id: string) => {
    const instance = processManager
      .listInstances()
      .find((i) => i.id === id);
    if (!instance) return { available: false };
    return getGitStatus(instance.cwd);
  });

  // Markdown view: read a markdown file for the renderer, which has no fs
  // access. The path may be absolute (POSIX or Windows), `~`-relative to the
  // home dir, or relative to the instance's cwd. Returns a discriminated-union
  // result — never throws — so any bad input (missing file, wrong extension,
  // directory, oversized file) degrades to an { ok: false } error the renderer
  // can render. Only .md/.markdown are allowed; the extension is checked before
  // touching fs, and a 2 MB size cap guards against huge files.
  ipcMain.handle(
    "read-file",
    (_event, instanceId: string, rawPath: string): ReadFileResult => {
      try {
        let resolved: string;
        if (
          rawPath.startsWith("/") ||
          /^[a-zA-Z]:[\\/]/.test(rawPath)
        ) {
          resolved = rawPath;
        } else if (rawPath.startsWith("~")) {
          resolved =
            rawPath === "~"
              ? homedir()
              : join(homedir(), rawPath.slice(2));
        } else {
          const instance = processManager
            .listInstances()
            .find((i) => i.id === instanceId);
          if (!instance) {
            return { ok: false, path: rawPath, error: "not-found" };
          }
          resolved = resolve(instance.cwd, rawPath);
        }

        const ext = extname(resolved).toLowerCase();
        if (ext !== ".md" && ext !== ".markdown") {
          return { ok: false, path: resolved, error: "unsupported" };
        }

        let stats;
        try {
          stats = statSync(resolved);
        } catch {
          return { ok: false, path: resolved, error: "not-found" };
        }
        if (stats.isDirectory()) {
          return { ok: false, path: resolved, error: "unsupported" };
        }
        if (stats.size > 2 * 1024 * 1024) {
          return { ok: false, path: resolved, error: "too-large" };
        }

        try {
          const content = readFileSync(resolved, "utf8");
          return { ok: true, path: resolved, content };
        } catch {
          return { ok: false, path: resolved, error: "not-found" };
        }
      } catch {
        return { ok: false, path: rawPath, error: "not-found" };
      }
    }
  );

  ipcMain.handle("open-in-vscode", async (_event, target: string) => {
    return new Promise<{ ok: boolean; error?: string }>((resolve) => {
      const child = spawn("code", [target], {
        detached: true,
        stdio: "ignore",
        env: {
          ...process.env,
          PATH: [
            "/opt/homebrew/bin",
            "/usr/local/bin",
            process.env.PATH || "",
          ].join(":"),
        },
      });
      child.once("error", (err: NodeJS.ErrnoException) => {
        resolve({
          ok: false,
          error: err.code === "ENOENT" ? "not-found" : err.message,
        });
      });
      child.once("spawn", () => {
        child.unref();
        resolve({ ok: true });
      });
    });
  });

  // Open a URL in the OS default browser. Guarded to web/mail schemes so a
  // markdown link can never trigger arbitrary protocol handlers or navigate
  // the renderer.
  ipcMain.handle("open-external", async (_event, url: string) => {
    try {
      const scheme = new URL(url).protocol;
      if (scheme !== "http:" && scheme !== "https:" && scheme !== "mailto:") {
        return { ok: false, error: "unsupported-scheme" };
      }
      await shell.openExternal(url);
      return { ok: true };
    } catch {
      return { ok: false, error: "invalid-url" };
    }
  });

  ipcMain.on("bounce-dock", () => {
    if (process.platform === "darwin" && app.dock) {
      // "informational" bounces once briefly. Use "critical" for sustained
      // bouncing until the user activates the app — matches QQ behavior.
      app.dock.bounce("critical");
    }
  });

  ipcMain.on("pty-input", (_event, id: string, data: string) => {
    processManager.writeToInstance(id, data);
  });

  ipcMain.on("pty-resize", (_event, id: string, cols: number, rows: number) => {
    processManager.resizeInstance(id, cols, rows);
  });

  ipcMain.handle("shell-spawn", (_event, id: string) => {
    const instance = processManager
      .listInstances()
      .find((i) => i.id === id);
    if (!instance) return { ok: false };
    shellManager.spawn(id, instance.cwd);
    return { ok: true };
  });

  ipcMain.handle("shell-kill", (_event, id: string) => {
    shellManager.kill(id);
  });

  ipcMain.on("shell-input", (_event, id: string, data: string) => {
    shellManager.write(id, data);
  });

  ipcMain.on(
    "shell-resize",
    (_event, id: string, cols: number, rows: number) => {
      shellManager.resize(id, cols, rows);
    }
  );

  ipcMain.handle("settings-get", () => {
    return loadSettings();
  });

  ipcMain.handle("settings-set-theme", (_event, theme: ThemeName) => {
    const current = loadSettings();
    const next = { ...current, theme };
    saveSettings(next);
    return next;
  });

  // Compose box: save the current clipboard image to a temp PNG and return its
  // absolute path. The renderer has no fs/clipboard-image access, so this must
  // live in the main process. Returns null (no throw) when the clipboard holds
  // no image, or when writing the temp file fails — the caller treats either as
  // a graceful no-op. The filename carries a per-process counter on top of the
  // timestamp so rapid pastes within the same millisecond never collide.
  ipcMain.handle("save-clipboard-image", (): string | null => {
    const image = clipboard.readImage();
    if (image.isEmpty()) return null;
    const file = join(
      tmpdir(),
      `multicode-paste-${Date.now()}-${tempImageCounter++}.png`
    );
    try {
      writeFileSync(file, image.toPNG());
    } catch {
      return null;
    }
    return file;
  });

  // Compose box: delete a temp image created above. Used on cancel / instance
  // switch / chip removal. Safe if the file is already gone (force: true).
  // Guard against arbitrary path deletion: only remove files we created, i.e.
  // a `multicode-paste-*.png` sitting directly in the OS temp dir.
  ipcMain.handle("delete-temp-image", (_event, path: string) => {
    if (!path) return;
    const resolved = resolve(path);
    if (
      dirname(resolved) !== resolve(tmpdir()) ||
      !TEMP_IMAGE_NAME.test(basename(resolved))
    ) {
      return;
    }
    rmSync(resolved, { force: true });
  });
}
