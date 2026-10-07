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
}

const DEFAULT_SETTINGS: Settings = {
  theme: "light",
  remoteEnabled: false,
  secretaryMode: false,
  speechServerUrl: "",
};

const SETTINGS_PATH = path.join(app.getPath("userData"), "settings.json");

// The speech server's bearer key, alone in its own 0600 file: never in
// settings.json, never logged, never sent to the renderer, which learns only
// whether one is set. Kept across runs, unlike the per-run spawn files.
const SPEECH_KEY_PATH = path.join(app.getPath("userData"), "speech-key");

function isThemeName(value: unknown): value is ThemeName {
  return value === "light" || value === "dark" || value === "sepia";
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
      };
    }
  } catch {
    // fall through to defaults
  }
  return { ...DEFAULT_SETTINGS };
}

export function saveSettings(settings: Settings) {
  const dir = path.dirname(SETTINGS_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
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
