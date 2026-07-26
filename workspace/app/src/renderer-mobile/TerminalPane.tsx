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
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

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
      theme: {
        background: "#101010",
        foreground: "#e6e6e6",
      },
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
