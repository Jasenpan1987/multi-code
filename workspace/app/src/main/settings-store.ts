import fs from "fs";
import path from "path";
import { app } from "electron";

import type { SecretarySettings, SpeechKeyChange } from "../shared/types";
import { normalizeServerUrl } from "./secretary/speech";
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
export function setSpeechServer(
  url: string,
  key: SpeechKeyChange
): SecretarySettings {
  if (typeof url !== "string") throw new TypeError("speech server address must be a string");
  if (key?.kind === "set" && typeof key.key === "string") {
    const value = key.key.trim();
    // A bearer key is printable ASCII with no spaces (RFC 6750); anything else
    // would only fail later as a confusing header error.
    if (/[^\x21-\x7e]/.test(value)) {
      throw new Error("the key can only contain printable characters without spaces");
    }
    if (value) writeSpeechKey(value);
  } else if (key?.kind === "clear") {
    fs.rmSync(SPEECH_KEY_PATH, { force: true });
  } else if (key?.kind !== "unchanged") {
    throw new TypeError("unknown speech key change");
  }
  saveSettings({ ...loadSettings(), speechServerUrl: normalizeServerUrl(url) });
  return loadSecretarySettings();
}

function readSpeechKey(): string {
  try {
    return fs.readFileSync(SPEECH_KEY_PATH, "utf8").trim();
  } catch {
    return "";
  }
}

// Unlink, write at 0600, then chmod: writeFileSync's mode applies only when it
// creates the file, and is subject to the umask even then.
function writeSpeechKey(value: string): void {
  fs.mkdirSync(path.dirname(SPEECH_KEY_PATH), { recursive: true });
  fs.rmSync(SPEECH_KEY_PATH, { force: true });
  fs.writeFileSync(SPEECH_KEY_PATH, value, { mode: 0o600 });
  fs.chmodSync(SPEECH_KEY_PATH, 0o600);
}
