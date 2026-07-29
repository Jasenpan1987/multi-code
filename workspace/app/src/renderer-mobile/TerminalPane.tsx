// Read-mostly terminal mirror for the phone.
//
// Writes arrive through a ref callback rather than props: PTY output can be
// thousands of chunks a second, and routing that through React state would
// re-render the tree per chunk. The pane hands App a write function and App
// calls it directly.
//
// The terminal is intentionally not focusable for typing — the answer box above
// it handles input, because an on-screen keyboard driving a raw TUI is a bad
// experience. It exists so you can always see exactly what the desktop sees.

import { useEffect, useRef } from "react";
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

// The phone's palette has to be lighter than the desktop's, and the reason is
// specific rather than aesthetic.
//
// OpenCode paints its dialogs with 256-color palette indices, not with the basic
// 16 ANSI colors. Measured off a real permission dialog, it uses:
//   - backgrounds 232 / 233 / 234 / 235 / 238 — all near-black
//   - foreground 8 for secondary text such as option descriptions
//   - foreground 15 / 255 for primary text, 215 for the selected option
//
// This pane previously set only `background` and `foreground`, leaving the other
// 254 slots at xterm's defaults. Dim grey on near-black is legible on a monitor
// and reads as an empty rectangle on a phone held at arm's length — which is
// exactly the "black screen" the terminal view appeared to show. The unselected
// options in a permission dialog (`fg 8` on `bg 234`) were the worst case: still
// painted, effectively invisible.
//
// So the low end of the greyscale ramp is lifted here. It's a viewing-condition
// adjustment, not a re-theme: hues stay where OpenCode put them, only contrast
// against a phone screen changes.
const GREYSCALE_FIXUPS: Record<number, string> = {
  // 232-238: OpenCode's dialog/panel backgrounds. Spread apart so nested panels
  // stay visually distinct instead of merging into one black mass.
  232: "#1b1c20",
  233: "#202226",
  234: "#26282e",
  235: "#2c2f36",
  236: "#33363e",
  237: "#3a3e46",
  238: "#42464f",
};

// xterm exposes slots 16-255 as one array, so build it from the standard 256-color
// cube and override only the entries above.
function buildExtendedAnsi(): string[] {
  const out: string[] = [];
  const levels = [0, 95, 135, 175, 215, 255];
  const hex = (n: number) => n.toString(16).padStart(2, "0");

  // 16-231: the 6x6x6 color cube, at its standard values.
  for (let i = 0; i < 216; i++) {
    const r = levels[Math.floor(i / 36)];
    const g = levels[Math.floor(i / 6) % 6];
    const b = levels[i % 6];
    out.push(`#${hex(r)}${hex(g)}${hex(b)}`);
  }
  // 232-255: the greyscale ramp. Standard values are 8,18,...,238; the darkest
  // few are replaced with the lifted versions above.
  for (let i = 0; i < 24; i++) {
    const slot = 232 + i;
    const fixup = GREYSCALE_FIXUPS[slot];
    if (fixup) {
      out.push(fixup);
      continue;
    }
    const v = 8 + i * 10;
    out.push(`#${hex(v)}${hex(v)}${hex(v)}`);
  }
  return out;
}

const PHONE_TERMINAL_THEME: ITheme = {
  background: "#16171b",
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
  // Slot 8. Not xterm's default #666: this is the one OpenCode uses for option
  // descriptions, and #666 on a near-black panel is what vanished on the phone.
  brightBlack: "#9aa0aa",
  brightRed: "#ff8f88",
  brightGreen: "#79e0a3",
  brightYellow: "#ffcb6b",
  brightBlue: "#8cc0ff",
  brightMagenta: "#eaa0f5",
  brightCyan: "#74dbe6",
  brightWhite: "#ffffff",
  extendedAnsi: buildExtendedAnsi(),
};

interface TerminalPaneProps {
  visible: boolean;
  registerWrite: (fn: (data: string, reset?: boolean) => void) => void;
}

export function TerminalPane({ visible, registerWrite }: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  // Buffers output that arrives before the terminal is opened (the pane starts
  // collapsed, but the desktop starts streaming as soon as we subscribe).
  const pendingRef = useRef<string[]>([]);

  useEffect(() => {
    const write = (data: string, reset = false) => {
      const term = termRef.current;
      if (!term) {
        if (reset) pendingRef.current = [];
        pendingRef.current.push(data);
        // Keep the pre-open buffer bounded; a snapshot replay plus a burst of
        // output is all we need to reconstruct the screen.
        if (pendingRef.current.length > 512) {
          pendingRef.current.splice(0, pendingRef.current.length - 512);
        }
        return;
      }
      if (reset) term.reset();
      term.write(data);
    };
    registerWrite(write);
  }, [registerWrite]);

  useEffect(() => {
    if (!visible || !containerRef.current || termRef.current) return;

    const term = new Terminal({
      cursorBlink: false,
      disableStdin: true,
      fontSize: 11,
      fontFamily: "Menlo, Monaco, 'Courier New', monospace",
      convertEol: false,
      theme: PHONE_TERMINAL_THEME,
      // A phone is narrow; scrollback is what makes it usable at all.
      scrollback: 4000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    try {
      fit.fit();
    } catch {
      // container may not be laid out yet
    }

    termRef.current = term;
    fitRef.current = fit;

    for (const chunk of pendingRef.current) term.write(chunk);
    pendingRef.current = [];

    return () => {
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    const refit = () => {
      try {
        fitRef.current?.fit();
      } catch {
        // ignore
      }
    };
    const timer = setTimeout(refit, 50);
    window.addEventListener("resize", refit);
    window.addEventListener("orientationchange", refit);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("resize", refit);
      window.removeEventListener("orientationchange", refit);
    };
  }, [visible]);

  return (
    <div
      className="m-terminal"
      style={{ display: visible ? "block" : "none" }}
      ref={containerRef}
    />
  );
}
