import {
  ipcMain,
  dialog,
  BrowserWindow,
  app,
  clipboard,
  nativeImage,
  shell,
} from "electron";
import { spawn } from "child_process";
import { writeFileSync, rmSync, statSync, readFileSync } from "fs";
import { stat } from "fs/promises";
import { tmpdir, homedir } from "os";
import { join, resolve, dirname, basename, extname } from "path";
import { processManager } from "./process-manager";
import { shellManager } from "./shell-manager";
import { getGitStatus } from "./git-status";
import { getFileDiff, isInsideCwd } from "./git-diff";
import { backendAvailability, getBackend } from "./backends";
import type { BackendName } from "./backends";
import {
  loadDropFolder,
  loadSecretarySettings,
  loadSettings,
  loadSpeechServer,
  saveSettings,
  setDropFolder,
  setSecretaryMode,
  setSpeechServer,
} from "./settings-store";
import type { ThemeName } from "./settings-store";
import { testServer } from "./secretary/speech";
import { secretary } from "./secretary";
import { copyIntoFolder, describePath, displayPath, dropStillWaiting } from "./file-drop";
import { debugTrace } from "./debug-trace";
import type {
  DiffSide,
  DropCopyOutcome,
  DropFolder,
  DroppedItem,
  FileDiff,
  ReadFileResult,
  RemotePairing,
  SpeechKeyChange,
} from "../shared/types";
import { OPENCODE_VIEW_KEYS, replyConclusion } from "../shared/replyStart";
import type { OpencodeViewCommand } from "../shared/replyStart";
import { remoteServer } from "./remote/ws-server";
import { acknowledgeInstance, setRemoteEnabled } from "./remote";
import { openTailscaleApp } from "./remote/tailscale";
import QRCode from "qrcode";

// Per-process counter to disambiguate temp image filenames within the same ms.
let tempImageCounter = 0;
// Where the project picker opens next; see select-directory.
let lastPickedParent: string | undefined;
// Filenames produced by save-clipboard-image; used to gate delete-temp-image.
const TEMP_IMAGE_NAME = /^multicode-paste-\d+-\d+\.png$/;

// The clipboard's image as PNG bytes, or null when it holds none. Electron 44 kept
// only the W3C-style `clipboard.read()`, which hands back each item's bytes as
// they are; a screenshot is already image/png, and any other image type is
// converted.
async function readClipboardPng(): Promise<Buffer | null> {
  for (const item of await clipboard.read()) {
    const type = item.types.find((t) => t.startsWith("image/"));
    if (!type) continue;
    const blob = await item.getType(type);
    // Only `electron application/bookmark` resolves to something other than a Blob.
    if (!("arrayBuffer" in blob)) continue;
    const bytes = Buffer.from(await blob.arrayBuffer());
    if (type === "image/png") return bytes.length > 0 ? bytes : null;
    const image = nativeImage.createFromBuffer(bytes);
    return image.isEmpty() ? null : image.toPNG();
  }
  return null;
}

// The project a drop on this contact goes into: its directory as stored, which
// also keys its default folder, so contacts on one project share it.
function dropProjectDir(instanceId: unknown): string {
  const instance = processManager.listInstances().find((i) => i.id === instanceId);
  if (!instance) {
    throw new Error("this contact has no project to drop files into");
  }
  return instance.cwd;
}

async function dropFolderOf(projectDir: string): Promise<DropFolder> {
  const folder = loadDropFolder(projectDir);
  if (folder === null) return { path: null, exists: false, display: null };
  // stat, not lstat: a default folder reached through a link is still there.
  const exists = await stat(folder).then(
    (s) => s.isDirectory(),
    () => false
  );
  return { path: folder, exists, display: displayPath(folder, projectDir, homedir(), true) };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

export function registerIpcHandlers() {
  ipcMain.handle(
    "create-instance",
    (_event, cwd: string, alias?: string, backend?: BackendName) => {
      return processManager.createInstance(cwd, alias, backend);
    }
  );

  // Whether a backend's CLI can start, and why not: the New Instance dialog warns
  // about a missing `opencode` and about one too old to run (1.x).
  ipcMain.handle(
    "backend-availability",
    (_event, backend: BackendName) => {
      return backendAvailability(backend);
    }
  );

  ipcMain.handle("kill-instance", (_event, id: string) => {
    processManager.killInstance(id);
  });

  ipcMain.handle("remove-instance", (_event, id: string) => {
    processManager.removeInstance(id);
    // The secretary keeps a brief after its event clears; not for a contact that's gone.
    secretary.forget(id);
  });

  ipcMain.handle("duplicate-instance", (_event, id: string) => {
    if (typeof id !== "string") return null;
    return processManager.duplicateInstance(id);
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

  // Drag-to-reorder. Takes the move rather than the resulting order — see
  // moveInstance for why a stale renderer must not be able to rewrite the whole list.
  ipcMain.handle(
    "move-contact",
    (_event, dragId: string, targetId: string, placeBefore: boolean) => {
      if (typeof dragId !== "string" || typeof targetId !== "string") {
        return processManager.listInstances();
      }
      return processManager.moveInstance(dragId, targetId, !!placeBefore);
    }
  );

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
    if (typeof id !== "string" || typeof alias !== "string") return null;
    return processManager.setAlias(id, alias);
  });

  // Since Electron 43 the picker opens in Downloads unless given a folder, and
  // macOS no longer remembers the last one. So it starts beside the last project
  // picked, or else beside the newest contact's, where the next project most
  // likely lives too.
  ipcMain.handle("select-directory", async () => {
    const win = BrowserWindow.getFocusedWindow();
    if (!win) return null;
    const newest = processManager.listInstances().at(-1);
    const result = await dialog.showOpenDialog(win, {
      properties: ["openDirectory"],
      title: "Select project directory",
      defaultPath: lastPickedParent ?? (newest ? dirname(newest.cwd) : undefined),
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    lastPickedParent = dirname(result.filePaths[0]);
    return result.filePaths[0];
  });

  ipcMain.handle("get-git-status", async (_event, id: string) => {
    const instance = processManager
      .listInstances()
      .find((i) => i.id === id);
    if (!instance) return { available: false };
    return getGitStatus(instance.cwd);
  });

  // The diff behind the Git section's "View" tag. Read-only: getFileDiff can only
  // reach `git diff`. `relPath` arrives repo-relative from the Git section, and is
  // refused if it points anywhere outside the instance's cwd — diffs for files
  // outside the project are out of scope, so there is no reason to resolve one.
  ipcMain.handle(
    "get-file-diff",
    async (
      _event,
      id: string,
      relPath: string,
      side: DiffSide,
      oldPath?: string
    ): Promise<FileDiff> => {
      const instance = processManager.listInstances().find((i) => i.id === id);
      if (!instance) {
        return { ok: false, reason: "failed", detail: "unknown instance" };
      }
      if (typeof relPath !== "string" || relPath === "") {
        return { ok: false, reason: "failed", detail: "no path" };
      }
      if (side !== "unstaged" && side !== "staged" && side !== "untracked") {
        return { ok: false, reason: "failed", detail: "bad side" };
      }
      if (!isInsideCwd(instance.cwd, relPath)) {
        return { ok: false, reason: "failed", detail: "path outside project" };
      }
      // A rename's old path reaches git as a pathspec too, so it gets the same check.
      if (oldPath !== undefined && !isInsideCwd(instance.cwd, oldPath)) {
        return { ok: false, reason: "failed", detail: "path outside project" };
      }
      return getFileDiff(instance.cwd, relPath, side, oldPath);
    }
  );

  // Resume Elsewhere: the command that reattaches to this instance's session
  // from a standalone terminal. Backend-specific (claude --resume vs
  // opencode --session), so the backend module builds it — the renderer stays
  // backend-agnostic and just copies the string. Returns null when the
  // instance is unknown or its sessionId hasn't been discovered yet.
  ipcMain.handle("get-resume-command", (_event, id: string): string | null => {
    const instance = processManager
      .listInstances()
      .find((i) => i.id === id);
    if (!instance || !instance.sessionId) return null;
    return getBackend(instance.backend).buildResumeCommand(instance.sessionId);
  });

  // The conclusion of the instance's latest turn, so its terminal can show it from
  // the first line (shared/replyStart.ts). Null when the instance, its session or
  // its transcript is unknown, the turn that ended isn't the session on screen, or
  // the turn said nothing.
  ipcMain.handle("read-reply-conclusion", async (_event, id: string): Promise<string | null> => {
    const source = processManager.replySource(id);
    if (!source) return null;
    const read = await getBackend(source.backend).readBuilderTurn(source.sessionId);
    return read ? replyConclusion(read.turn) : null;
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

  // Open a target in VS Code. When `projectRoot` is provided AND differs from
  // the target, we first open/focus the project folder, then `--goto` the file
  // inside it — otherwise `code <file>` alone dumps the file into whatever VS
  // Code window happens to be frontmost, without the project context. `code
  // <folder>` opens or focuses that folder's window; a following `code --goto`
  // routes the file into the window that owns it. When there's no projectRoot
  // (e.g. "Go to Code Base" passing a folder), the single `code <target>` path
  // is used, unchanged.
  ipcMain.handle(
    "open-in-vscode",
    async (_event, target: string, projectRoot?: string) => {
      const env = {
        ...process.env,
        PATH: [
          "/opt/homebrew/bin",
          "/usr/local/bin",
          process.env.PATH || "",
        ].join(":"),
      };

      // Run one `code` invocation, resolving ok/error from its spawn result.
      const runCode = (args: string[]) =>
        new Promise<{ ok: boolean; error?: string }>((resolve) => {
          const child = spawn("code", args, {
            detached: true,
            stdio: "ignore",
            env,
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

      // No project context, or target IS the project root → single open.
      if (!projectRoot || projectRoot === target) {
        return runCode([target]);
      }

      // Ensure the project window exists/focused, then reveal the file in it.
      const folderResult = await runCode([projectRoot]);
      if (!folderResult.ok) return folderResult;
      return runCode(["--goto", target]);
    }
  );

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

  // The number on the Dock icon: unread alerts across every contact, chat-app
  // style. Zero clears it. It replaced a "critical" bounce that kept the icon
  // jumping until the app came forward.
  ipcMain.on("set-dock-badge", (_event, count: unknown) => {
    if (typeof count !== "number" || !Number.isInteger(count) || count < 0) return;
    app.setBadgeCount(count);
  });

  // The builder acknowledged an instance that had unread alerts (markRead in
  // useNotifications.ts): it stops being Finished on the phone too.
  ipcMain.on("instance-acknowledged", (_event, id: unknown) => {
    if (typeof id === "string") acknowledgeInstance(id);
  });

  ipcMain.on("pty-input", (_event, id: string, data: string) => {
    processManager.writeToInstance(id, data);
  });

  // A key that moves an OpenCode terminal's view; only the commands named in
  // OPENCODE_VIEW_KEYS, never bytes of the renderer's own.
  ipcMain.on("view-key", (_event, id: string, command: unknown) => {
    if (typeof command !== "string" || !Object.hasOwn(OPENCODE_VIEW_KEYS, command)) return;
    processManager.sendViewKey(id, command as OpencodeViewCommand);
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

  // App version for the header badge. Read straight from the app's
  // package.json (which sits at ../../package.json relative to dist/main),
  // because app.getVersion() falls back to Electron's own version when the app
  // isn't launched with a packaged context (e.g. `electron dist/main/index.js`
  // in dev). Falls back to app.getVersion() only if the file can't be read.
  ipcMain.handle("get-app-version", () => {
    try {
      const pkgPath = join(__dirname, "..", "..", "package.json");
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      if (typeof pkg.version === "string") return pkg.version;
    } catch {
      // fall through
    }
    return app.getVersion();
  });

  // Whether this is a dev run (`electron .`) rather than a packaged build. The two
  // use different userData directories and can run side by side, which is exactly
  // when it matters to know which window is which before closing one.
  ipcMain.handle("is-dev-build", () => !app.isPackaged);

  ipcMain.handle("settings-get", () => {
    return loadSettings();
  });

  ipcMain.handle("settings-set-theme", (_event, theme: ThemeName) => {
    const current = loadSettings();
    const next = { ...current, theme };
    saveSettings(next);
    return next;
  });

  // ---------------------------------------------------------------------
  // File drop: files dropped from Finder are copied into the selected
  // contact's project. Nothing here ever writes to a session.
  // ---------------------------------------------------------------------

  ipcMain.handle("file-drop-get-folder", (_event, instanceId: string) =>
    dropFolderOf(dropProjectDir(instanceId))
  );

  // setDropFolder refuses anything but an absolute path.
  ipcMain.handle("file-drop-set-folder", (_event, instanceId: string, folder: string) => {
    const projectDir = dropProjectDir(instanceId);
    setDropFolder(projectDir, folder);
    return dropFolderOf(projectDir);
  });

  // What the renderer checks the drop's limits against, and its dialog lists. A path
  // that is gone counts as an empty file rather than failing the whole call; its copy
  // reports it.
  ipcMain.handle(
    "file-drop-describe",
    (_event, paths: string[]): Promise<DroppedItem[]> => {
      if (!isStringArray(paths)) throw new TypeError("paths must be an array of strings");
      return Promise.all(
        paths.map(async (p) => ({ name: basename(p), ...(await describePath(p)) }))
      );
    }
  );

  // A drop from Finder leaves Finder the active app (macOS doesn't switch on a
  // drop), so the Enter meant for the dialog or the picker that follows would go to
  // Finder. Stealing is fine here: the builder just dropped files on this window.
  // Not once the renderer has given the drop up (`until`, epoch ms): a call that
  // reaches here that late would take the keys with no dialog to show.
  ipcMain.handle("file-drop-focus-window", (event, until: unknown) => {
    if (!dropStillWaiting(until, Date.now())) return;
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    if (process.platform === "darwin") app.focus({ steal: true });
    win.focus();
  });

  // On the window the drop landed on rather than the focused one, unlike
  // select-directory: with no focused window the picker would never open and read
  // as a cancel.
  ipcMain.handle(
    "file-drop-pick-folder",
    async (event, message: string, startFolder: string): Promise<string | null> => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win) return null;
      const result = await dialog.showOpenDialog(win, {
        properties: ["openDirectory", "createDirectory"],
        message: typeof message === "string" ? message : undefined,
        defaultPath:
          typeof startFolder === "string" && startFolder !== "" ? startFolder : undefined,
      });
      if (result.canceled || result.filePaths.length === 0) return null;
      return result.filePaths[0];
    }
  );

  // Every path goes to the trace as JSON, so the builder's Finder test can read
  // the real dropped paths, spaces and all: `grep file-drop` in the log. A drop past
  // the limits copies nothing, whatever the renderer checked (copyIntoFolder).
  ipcMain.handle(
    "file-drop-copy",
    async (
      _event,
      instanceId: string,
      sources: string[],
      targetDir: string
    ): Promise<DropCopyOutcome[]> => {
      const projectDir = dropProjectDir(instanceId);
      if (!isStringArray(sources) || typeof targetDir !== "string") {
        throw new TypeError("sources must be an array of strings and the target a string");
      }
      debugTrace(
        `[file-drop] copy ${JSON.stringify(sources)} -> ${JSON.stringify(targetDir)} (project ${JSON.stringify(projectDir)}) at ${new Date().toISOString()}`
      );
      const home = homedir();
      const outcomes: DropCopyOutcome[] = [];
      for (const result of await copyIntoFolder(sources, targetDir)) {
        if (!result.ok) {
          debugTrace(`[file-drop]   failed ${JSON.stringify(result.source)}: ${result.reason}`);
          outcomes.push(result);
          continue;
        }
        debugTrace(
          `[file-drop]   copied ${JSON.stringify(result.source)} -> ${JSON.stringify(result.destination)}${result.renamed ? " (renamed)" : ""}`
        );
        // A copy is a file, or a link copied as itself: never shown as a folder.
        outcomes.push({ ...result, display: displayPath(result.destination, projectDir, home, false) });
      }
      return outcomes;
    }
  );

  // ---------------------------------------------------------------------
  // Phone link
  // ---------------------------------------------------------------------

  // Also refreshes the Tailscale checks behind the answer (at most every 5 s); a change
  // arrives as a "remote-status" push.
  ipcMain.handle("remote-get-status", () => remoteServer.requestStatus());

  ipcMain.handle("remote-set-enabled", (_event, enabled: boolean) =>
    setRemoteEnabled(enabled)
  );

  // Mint a pairing token and render the offer as a QR data URL. The renderer
  // only ever sees the image plus the URL text, never the raw token by itself,
  // so a screenshot of the UI is the only thing that leaks it — same exposure as
  // showing the QR at all. Returns null unless the server listens and HTTPS is
  // ready (nothing to point a phone at). `replacing`: the row of the code "New code"
  // replaces, revoked once the new one is made unless a phone has used it ("Done"
  // keeps a code: the Home Screen app's paste hand-off may still use it).
  ipcMain.handle("remote-create-pairing", async (_event, replacing?: unknown): Promise<RemotePairing | null> => {
    const pairing = remoteServer.createPairingOffer();
    if (!pairing) return null;
    if (typeof replacing === "string") remoteServer.revokeUnusedDevice(replacing);
    const { offer, deviceId } = pairing;
    const code = Buffer.from(JSON.stringify(offer), "utf8").toString("base64url");
    // The phone opens the served web client at the offer's origin, with the payload
    // in the fragment (`#pair=`, as remote-protocol.ts specifies). A fragment never
    // reaches a server, which matters because the token is in it.
    const webUrl = `${offer.origin}/#pair=${code}`;
    try {
      const qrDataUrl = await QRCode.toDataURL(webUrl, {
        margin: 1,
        width: 240,
      });
      return { deviceId, webUrl, qrDataUrl };
    } catch {
      return { deviceId, webUrl, qrDataUrl: null };
    }
  });

  ipcMain.handle("remote-revoke-device", (_event, deviceId: string) => {
    remoteServer.revokeDevice(deviceId);
    return remoteServer.getStatus();
  });

  // The Phone section's "Set up HTTPS" button, the only caller: runs
  // `tailscale serve --bg --https=443 http://127.0.0.1:<port>` when nothing serves
  // port 443 yet, and changes nothing otherwise (remote/tailscale.ts).
  ipcMain.handle("remote-setup-https", () => remoteServer.setUpHttps());

  // The Phone section's "Open Tailscale", for a Tailscale that is stopped or quit.
  ipcMain.handle("remote-open-tailscale", () => openTailscaleApp());

  // The Phone section's "Send test" for one paired phone.
  ipcMain.handle("remote-test-push", (_event, deviceId: string) => remoteServer.sendTestPush(deviceId));

  // ---------------------------------------------------------------------
  // Secretary. The settings replies are SecretarySettings or a test result:
  // the speech key goes in through set-server and never comes back out.
  // ---------------------------------------------------------------------

  ipcMain.handle("secretary:get-settings", () => loadSecretarySettings());

  // Saved first: if the save throws, the call rejects and the secretary keeps
  // the mode it had. Turning it on prepares the live events; off drops them all.
  ipcMain.handle("secretary:set-mode", (_event, enabled: boolean) => {
    const next = setSecretaryMode(enabled === true);
    secretary.setMode(next.secretaryMode);
    return next;
  });

  // Live updates arrive on "secretary-brief"; this is for a renderer that just
  // mounted or reloaded.
  ipcMain.handle("secretary:get-briefs", () => secretary.briefs());

  // The wav, fetched on demand so it doesn't ride every update. Arrives in the
  // renderer as a Uint8Array; null for a seq that is no longer the brief.
  ipcMain.handle("secretary:get-audio", (_event, instanceId: string, seq: number) =>
    typeof instanceId === "string" && typeof seq === "number"
      ? secretary.audioFor(instanceId, seq)
      : null
  );

  // A reply on a Needs-you card (T-509). Resolves once the secretary has acted or
  // answered; its exchanges reach the renderer on "secretary-brief" as they go.
  ipcMain.handle(
    "secretary:reply",
    (_event, instanceId: unknown, seq: unknown, text: unknown) =>
      typeof instanceId === "string" && typeof seq === "number" && typeof text === "string"
        ? secretary.reply(instanceId, seq, text)
        : undefined
  );

  ipcMain.handle(
    "secretary:set-server",
    (_event, url: string, key: SpeechKeyChange) => setSpeechServer(url, key)
  );

  ipcMain.handle("secretary:test-server", () => testServer(loadSpeechServer()));

  // Compose box: save the current clipboard image to a temp PNG and return its
  // absolute path plus a data: URL of the same bytes (for the chip thumbnail —
  // the renderer has no fs access to re-read it). The renderer has no
  // fs/clipboard-image access, so this must live in the main process. Returns
  // null (no throw) when the clipboard holds no image, or when writing the temp
  // file fails — the caller treats either as a graceful no-op. The filename
  // carries a per-process counter on top of the timestamp so rapid pastes
  // within the same millisecond never collide. The data URL is built from the
  // same in-memory PNG buffer — no second disk read.
  ipcMain.handle(
    "save-clipboard-image",
    async (): Promise<{ path: string; dataUrl: string } | null> => {
      const png = await readClipboardPng().catch(() => null);
      if (!png) return null;
      const file = join(
        tmpdir(),
        `multicode-paste-${Date.now()}-${tempImageCounter++}.png`
      );
      try {
        writeFileSync(file, png);
      } catch {
        return null;
      }
      return {
        path: file,
        dataUrl: `data:image/png;base64,${png.toString("base64")}`,
      };
    }
  );

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
