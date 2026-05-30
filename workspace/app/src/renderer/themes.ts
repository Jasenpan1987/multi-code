import type { ITheme } from "@xterm/xterm";
import type { ThemeName } from "../shared/types";

// Two xterm palettes per theme: the main agent terminal (TerminalView) and
// the toolbox shell terminal (TerminalSection). Outer chrome (titlebar,
// sidebar, content header) keeps the QQ blue accent in every theme.

export interface ThemePalette {
  // Inner backgrounds used by CSS via [data-theme="..."] selectors.
  // Kept here as a single source of truth so the CSS `<meta>` mapping
  // stays in sync with the xterm theme below.
  contentBackground: string;
  toolboxBodyBackground: string;
  // xterm themes
  mainTerminal: ITheme;
  shellTerminal: ITheme;
}

const lightMain: ITheme = {
  background: "#f0f4fa",
  foreground: "#1a1a1a",
  cursor: "#333333",
  selectionBackground: "#b3d4fc",
  black: "#1a1a1a",
  red: "#c62828",
  green: "#1e7a3a",
  yellow: "#a65b00",
  blue: "#2d5a8a",
  magenta: "#8e3a8e",
  cyan: "#0e6b75",
  white: "#3a3a3a",
  brightBlack: "#5a5a5a",
  brightRed: "#d32f2f",
  brightGreen: "#2e8b4a",
  brightYellow: "#b8730e",
  brightBlue: "#3a6aa3",
  brightMagenta: "#a04aa0",
  brightCyan: "#1f8a96",
  brightWhite: "#1a1a1a",
};

const lightShell: ITheme = {
  background: "#000000",
  foreground: "#ffffff",
  cursor: "#ffffff",
  selectionBackground: "#4a4a4a",
};

// Dark: VS Code-ish charcoal for inner panels, while outer titlebar/sidebar
// keep the QQ blue. Both terminals share the same dark palette.
const darkMain: ITheme = {
  background: "#1e1e1e",
  foreground: "#d4d4d4",
  cursor: "#d4d4d4",
  selectionBackground: "#264f78",
  black: "#000000",
  red: "#cd3131",
  green: "#0dbc79",
  yellow: "#e5e510",
  blue: "#2472c8",
  magenta: "#bc3fbc",
  cyan: "#11a8cd",
  white: "#e5e5e5",
  brightBlack: "#666666",
  brightRed: "#f14c4c",
  brightGreen: "#23d18b",
  brightYellow: "#f5f543",
  brightBlue: "#3b8eea",
  brightMagenta: "#d670d6",
  brightCyan: "#29b8db",
  brightWhite: "#ffffff",
};

const darkShell: ITheme = {
  background: "#1e1e1e",
  foreground: "#d4d4d4",
  cursor: "#d4d4d4",
  selectionBackground: "#264f78",
};

// Sepia / eye-care: warm off-white background (Solarized Light-ish).
const sepiaMain: ITheme = {
  background: "#f4ecd8",
  foreground: "#3a2f1d",
  cursor: "#5a4a30",
  selectionBackground: "#e0d4b8",
  black: "#3a2f1d",
  red: "#a8341c",
  green: "#5b7a2c",
  yellow: "#9a6e15",
  blue: "#2d5a8a",
  magenta: "#8a3a6a",
  cyan: "#1f6c70",
  white: "#5a4a30",
  brightBlack: "#6a5a40",
  brightRed: "#c14a30",
  brightGreen: "#6f9038",
  brightYellow: "#b8861f",
  brightBlue: "#3a6aa3",
  brightMagenta: "#a04a80",
  brightCyan: "#2e8088",
  brightWhite: "#3a2f1d",
};

const sepiaShell: ITheme = {
  background: "#2c2418",
  foreground: "#ebd9b4",
  cursor: "#ebd9b4",
  selectionBackground: "#5a4a30",
};

export const THEMES: Record<ThemeName, ThemePalette> = {
  light: {
    contentBackground: "#f0f4fa",
    toolboxBodyBackground: "#f0f4fa",
    mainTerminal: lightMain,
    shellTerminal: lightShell,
  },
  dark: {
    contentBackground: "#1e1e1e",
    toolboxBodyBackground: "#252526",
    mainTerminal: darkMain,
    shellTerminal: darkShell,
  },
  sepia: {
    contentBackground: "#f4ecd8",
    toolboxBodyBackground: "#efe4ca",
    mainTerminal: sepiaMain,
    shellTerminal: sepiaShell,
  },
};

export function getCurrentTheme(): ThemeName {
  const attr = document.documentElement.getAttribute("data-theme");
  if (attr === "dark" || attr === "sepia") return attr;
  return "light";
}
