import fs from "fs";
import path from "path";
import { app } from "electron";

import type { SecretarySettings, SpeechKeyChange } from "../shared/types";
import { normalizeServerUrl, serverOrigin } from "./secretary/speech";
import type { SpeechServer } from "./secretary/speech";

export type ThemeName = "light" | "dark" | "sepia";

export interface Settings {
  theme: ThemeName;
  // Whether the phone-link server listens on startup. Off by default: it opens
  // a port on the local network, so it should be an explicit opt-in.
  remoteEnabled: boolean;
  // Secretary Mode. Off by default; while off, no model or speech server is called.
  secretaryMode: boolean;
  // The speech server's base address; "" means none, and briefs are text only.
  // Its key is deliberately not a field here: see SPEECH_KEY_PATH.
  speechServerUrl: string;
  // Each project's default drop folder: the contact's directory as stored → an
  // absolute folder, which may be outside the project. Kept here, never in the
  // project. Two contacts on one project share their entry.
  dropFolders: Record<string, string>;
}

const DEFAULT_SETTINGS: Settings = {
  theme: "light",
  remoteEnabled: false,
  secretaryMode: false,
  speechServerUrl: "",
  dropFolders: {},
};

const SETTINGS_PATH = path.join(app.getPath("userData"), "settings.json");

// The speech server's bearer key, alone in its own 0600 file: never in
// settings.json, never logged, never sent to the renderer, which learns only
// whether one is set. Kept across runs, unlike the per-run spawn files.
const SPEECH_KEY_PATH = path.join(app.getPath("userData"), "speech-key");

function isThemeName(value: unknown): value is ThemeName {
  return value === "light" || value === "dark" || value === "sepia";
}

// Only entries whose folder is an absolute path; anything else in the file is
// dropped rather than handed to a picker or a copy. fromEntries, so a key such as
// "__proto__" stays an ordinary entry.
function dropFoldersOf(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === "string" && path.isAbsolute(entry[1])
    )
  );
}

export function loadSettings(): Settings {
  try {
    if (fs.existsSync(SETTINGS_PATH)) {
      const data = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8"));
      const theme: ThemeName = isThemeName(data?.theme)
        ? data.theme
        : DEFAULT_SETTINGS.theme;
      return {
        theme,
        remoteEnabled: data?.remoteEnabled === true,
        secretaryMode: data?.secretaryMode === true,
        speechServerUrl:
          typeof data?.speechServerUrl === "string" ? data.speechServerUrl : "",
        dropFolders: dropFoldersOf(data?.dropFolders),
      };
    }
  } catch {
    // fall through to defaults
  }
  // A fresh object, so a caller adding an entry can't change the defaults.
  return { ...DEFAULT_SETTINGS, dropFolders: {} };
}

export function saveSettings(settings: Settings) {
  const dir = path.dirname(SETTINGS_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
}

// ---------------------------------------------------------------------------
// File drop
// ---------------------------------------------------------------------------

// The project's default drop folder, or null before its first drop sets one.
export function loadDropFolder(projectDir: string): string | null {
  const { dropFolders } = loadSettings();
  return Object.hasOwn(dropFolders, projectDir) ? dropFolders[projectDir] : null;
}

// Merged into what is saved, so every other setting and every other project's
// folder stays as it was.
export function setDropFolder(projectDir: string, folder: string): void {
  if (typeof projectDir !== "string" || projectDir === "") {
    throw new TypeError("project directory must be a non-empty string");
  }
  if (typeof folder !== "string" || !path.isAbsolute(folder)) {
    throw new TypeError("drop folder must be an absolute path");
  }
  const current = loadSettings();
  saveSettings({
    ...current,
    dropFolders: { ...current.dropFolders, [projectDir]: folder },
  });
}

// ---------------------------------------------------------------------------
// Secretary
// ---------------------------------------------------------------------------

// What the speech client needs, read fresh on every call so a new address or key
// applies to the next brief without a restart.
export function loadSpeechServer(): SpeechServer {
  return { url: loadSettings().speechServerUrl, key: readSpeechKey() };
}

export function loadSecretarySettings(): SecretarySettings {
  const { secretaryMode, speechServerUrl } = loadSettings();
  return { secretaryMode, speechServerUrl, hasSpeechKey: readSpeechKey() !== "" };
}

export function setSecretaryMode(enabled: boolean): SecretarySettings {
  saveSettings({ ...loadSettings(), secretaryMode: enabled });
  return loadSecretarySettings();
}

// Throws on a malformed change or an unwritable key file, so the renderer's call
// rejects rather than reporting a key as saved when it isn't. No message here
// ever contains the key.
//
// A saved key belongs to the server it was saved for. Moving the address to
// another origin (or to none) without giving a key drops the saved one, so
// nothing that can reach this IPC, a compromised renderer included, can point
// the key at a server of its choosing and have Test or a brief hand it over.
export function setSpeechServer(
  url: string,
  key: SpeechKeyChange
): SecretarySettings {
  if (typeof url !== "string") throw new TypeError("speech server address must be a string");
  const next = normalizeServerUrl(url);
  const movesOrigin = serverOrigin(next) !== serverOrigin(loadSettings().speechServerUrl);
  let newKey: string | null = null;
  if (key?.kind === "set" && typeof key.key === "string") {
    const value = key.key.trim();
    // A bearer key is printable ASCII with no spaces (RFC 6750); anything else
    // would only fail later as a confusing header error.
    if (/[^\x21-\x7e]/.test(value)) {
      throw new Error("the key can only contain printable characters without spaces");
    }
    newKey = value || null;
  } else if (key?.kind !== "clear" && key?.kind !== "unchanged") {
    throw new TypeError("unknown speech key change");
  }
  // In this order so a failure at any step leaves no key paired with a server it
  // wasn't saved for: the old key goes before the address moves, and a new key is
  // written only once the address it belongs to is saved.
  if (key.kind === "clear" || movesOrigin) fs.rmSync(SPEECH_KEY_PATH, { force: true });
  saveSettings({ ...loadSettings(), speechServerUrl: next });
  if (newKey) writeSpeechKey(newKey);
  return loadSecretarySettings();
}

function readSpeechKey(): string {
  try {
    return fs.readFileSync(SPEECH_KEY_PATH, "utf8").trim();
  } catch {
    return "";
  }
}

// Written to a fresh file of our own and renamed into place, so the key is never
// in a file anyone else could have opened first: `wx` refuses a name that already
// exists, and the rename replaces whatever sits at the real path, a planted file
// or symlink included, without writing through it. chmod after the write because
// the create mode is subject to the umask.
function writeSpeechKey(value: string): void {
  fs.mkdirSync(path.dirname(SPEECH_KEY_PATH), { recursive: true });
  const temp = `${SPEECH_KEY_PATH}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temp, value, { mode: 0o600, flag: "wx" });
    fs.chmodSync(temp, 0o600);
    fs.renameSync(temp, SPEECH_KEY_PATH);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}
