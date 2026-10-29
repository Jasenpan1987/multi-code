// What the terminal fallback (screens/TerminalScreen.tsx, mockup 4.1) sends and how
// it paints, kept apart from the screen so the bytes and the palette are tested
// without a DOM.

import type { ITheme } from "@xterm/xterm";

// The key row: what a phone keyboard can't type, as the bytes a terminal sends for
// it (arrows as CSI A-D, normal cursor mode). Each goes to the PTY as one `input`
// frame, as is.
export const KEYS: readonly { label: string; name: string; data: string; danger?: boolean }[] = [
  { label: "Esc", name: "Escape", data: "\x1b" },
  { label: "Tab", name: "Tab", data: "\t" },
  { label: "⇧Tab", name: "Shift+Tab", data: "\x1b[Z" },
  { label: "↑", name: "Up", data: "\x1b[A" },
  { label: "↓", name: "Down", data: "\x1b[B" },
  { label: "←", name: "Left", data: "\x1b[D" },
  { label: "→", name: "Right", data: "\x1b[C" },
  { label: "␣", name: "Space", data: " " },
  { label: "⏎", name: "Return", data: "\r" },
  { label: "^C", name: "Ctrl+C", data: "\x03", danger: true },
];

// The phone's palette has to be lighter than the desktop's, and the reason is
// specific rather than aesthetic.
//
// OpenCode paints its dialogs with 256-colour palette indices, not with the basic
// 16 ANSI colours. Measured off a real permission dialog, it uses:
//   - backgrounds 232 / 233 / 234 / 235 / 238, all near-black
//   - foreground 8 for secondary text such as option descriptions
//   - foreground 15 / 255 for primary text, 215 for the selected option
//
// With only `background` and `foreground` set, the other 254 slots stay at xterm's
// defaults. Dim grey on near-black is legible on a monitor and reads as an empty
// rectangle on a phone held at arm's length: the unselected options of a
// permission dialog (fg 8 on bg 234) were still painted, and effectively invisible.
//
// So the low end of the greyscale ramp is lifted here. It's a viewing-condition
// adjustment, not a re-theme: hues stay where OpenCode put them, only contrast
// against a phone screen changes.
const GREYSCALE_FIXUPS: Record<number, string> = {
  // 232-238: OpenCode's dialog and panel backgrounds, spread apart so nested
  // panels stay distinct instead of merging into one black mass.
  232: "#1b1c20",
  233: "#202226",
  234: "#26282e",
  235: "#2c2f36",
  236: "#33363e",
  237: "#3a3e46",
  238: "#42464f",
};

// xterm takes slots 16-255 as one array, so it is built from the standard
// 256-colour cube with only the entries above replaced.
function extendedAnsi(): string[] {
  const out: string[] = [];
  const levels = [0, 95, 135, 175, 215, 255];
  const hex = (n: number) => n.toString(16).padStart(2, "0");

  // 16-231: the 6×6×6 colour cube, at its standard values.
  for (let i = 0; i < 216; i++) {
    const r = levels[Math.floor(i / 36)];
    const g = levels[Math.floor(i / 6) % 6];
    const b = levels[i % 6];
    out.push(`#${hex(r)}${hex(g)}${hex(b)}`);
  }
  // 232-255: the greyscale ramp, standard values 8, 18, … 238, the darkest few
  // lifted.
  for (let i = 0; i < 24; i++) {
    const v = 8 + i * 10;
    out.push(GREYSCALE_FIXUPS[232 + i] ?? `#${hex(v)}${hex(v)}${hex(v)}`);
  }
  return out;
}

// Dark in both colour schemes, as mockup 4.1 draws it: the CLIs paint for a dark
// terminal.
export const TERMINAL_BACKGROUND = "#0c0c0c";

export const TERMINAL_THEME: ITheme = {
  background: TERMINAL_BACKGROUND,
  foreground: "#e8eaed",
  cursor: "#e8eaed",
  selectionBackground: "#2f4f6f",
  black: "#2a2d34",
  red: "#f4736c",
  green: "#5ec98a",
  yellow: "#e8b352",
  blue: "#6aa9f0",
  magenta: "#d488e0",
  cyan: "#54c0cc",
  white: "#d6d9de",
  // Slot 8. Not xterm's default #666: OpenCode uses it for option descriptions,
  // and #666 on a near-black panel is what vanished on the phone.
  brightBlack: "#9aa0aa",
  brightRed: "#ff8f88",
  brightGreen: "#79e0a3",
  brightYellow: "#ffcb6b",
  brightBlue: "#8cc0ff",
  brightMagenta: "#eaa0f5",
  brightCyan: "#74dbe6",
  brightWhite: "#ffffff",
  extendedAnsi: extendedAnsi(),
};
