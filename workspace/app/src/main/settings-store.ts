import fs from "fs";
import path from "path";
import { app } from "electron";

export type ThemeName = "light" | "dark" | "sepia";

export interface Settings {
  theme: ThemeName;
}

const DEFAULT_SETTINGS: Settings = { theme: "light" };

const SETTINGS_PATH = path.join(app.getPath("userData"), "settings.json");

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
      return { theme };
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
