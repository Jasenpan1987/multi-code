import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { THEMES, getCurrentTheme } from "../themes";
import { useTheme } from "../hooks/useTheme";

interface TerminalViewProps {
  instanceId: string;
  active: boolean;
}

const terminals = new Map<string, { terminal: Terminal; fitAddon: FitAddon }>();

export function getTerminal(instanceId: string): Terminal | undefined {
  return terminals.get(instanceId)?.terminal;
}

export function applyMainThemeToAll() {
  const palette = THEMES[getCurrentTheme()].mainTerminal;
  for (const { terminal } of terminals.values()) {
    terminal.options.theme = palette;
  }
}

export function TerminalView({ instanceId, active }: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const initializedRef = useRef(false);
  const { theme } = useTheme();

  useEffect(() => {
    if (!containerRef.current || initializedRef.current) return;
    initializedRef.current = true;

    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "Menlo, Monaco, 'Courier New', monospace",
      minimumContrastRatio: 7,
      theme: THEMES[getCurrentTheme()].mainTerminal,
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(new WebLinksAddon());

    terminals.set(instanceId, { terminal, fitAddon });

    // macOS terminal emulators (Terminal.app, iTerm2) translate a few Cmd+
    // shortcuts to readline-equivalent control bytes before forwarding to the
    // PTY. xterm.js does not do this by default, so we replicate the
    // translation here. Both Claude Code and OpenCode honor these.
    terminal.attachCustomKeyEventHandler((e) => {
      if (e.type === "keydown" && e.metaKey) {
        // Cmd+Backspace / Cmd+Delete -> Ctrl+U (clear input line).
        if (e.key === "Backspace" || e.key === "Delete") {
          window.electronAPI.writeToInstance(instanceId, "\x15");
          return false;
        }
        // Cmd+Left -> Ctrl+A (jump to line start).
        if (e.key === "ArrowLeft") {
          window.electronAPI.writeToInstance(instanceId, "\x01");
          return false;
        }
        // Cmd+Right -> Ctrl+E (jump to line end).
        if (e.key === "ArrowRight") {
          window.electronAPI.writeToInstance(instanceId, "\x05");
          return false;
        }
        // Cmd+L summons the compose box. Swallow it (return false) so xterm
        // never forwards an `l` or escape sequence to the PTY, then ask the
        // app to open the box for this instance. Chosen over Ctrl+L to avoid
        // the terminal's clear-screen binding.
        if (e.key.toLowerCase() === "l") {
          window.dispatchEvent(
            new CustomEvent("compose-open", { detail: { id: instanceId } })
          );
          return false;
        }
      }
      return true;
    });

    terminal.open(containerRef.current);
    fitAddon.fit();

    // Notify main process of initial size
    window.electronAPI.resizeInstance(instanceId, terminal.cols, terminal.rows);

    // Send terminal input to main process
    terminal.onData((data) => {
      window.electronAPI.writeToInstance(instanceId, data);
    });

    // Handle resize
    terminal.onResize(({ cols, rows }) => {
      window.electronAPI.resizeInstance(instanceId, cols, rows);
    });

    // Listen for PTY output destined for this terminal
    const handlePtyData = (event: Event) => {
      const { id, data } = (event as CustomEvent).detail;
      if (id === instanceId) {
        terminal.write(data);
      }
    };
    window.addEventListener("pty-data", handlePtyData);

    return () => {
      window.removeEventListener("pty-data", handlePtyData);
    };
  }, [instanceId]);

  // Re-apply theme to this instance's terminal when the app theme changes.
  useEffect(() => {
    const entry = terminals.get(instanceId);
    if (!entry) return;
    entry.terminal.options.theme = THEMES[theme].mainTerminal;
  }, [theme, instanceId]);

  // Handle fit on visibility change and window resize
  useEffect(() => {
    if (!active) return;

    const entry = terminals.get(instanceId);
    if (!entry) return;

    const { terminal, fitAddon } = entry;

    // Fit when becoming active (delay to ensure container is sized).
    // Always scroll to the bottom afterwards: when the user scrolled up
    // (or the viewport got out of sync after a resize / hide-show cycle)
    // the prompt row can end up below the visible area until the next
    // PTY redraw — most easily reproduced by scrolling to the bottom and
    // then losing the prompt. scrollToBottom forces the viewport back
    // onto the last buffer line.
    const refit = () => {
      try {
        fitAddon.fit();
      } catch {
        // ignore — container may not be ready yet
      }
      terminal.scrollToBottom();
    };
    requestAnimationFrame(refit);

    window.addEventListener("resize", refit);
    window.addEventListener("layout-resize", refit);
    return () => {
      window.removeEventListener("resize", refit);
      window.removeEventListener("layout-resize", refit);
    };
  }, [instanceId, active]);

  // When the user clicks back into the terminal, force the viewport to
  // the bottom in case it got stuck mid-buffer (rare xterm.js race that
  // hides the prompt until the next redraw).
  const handleClick = () => {
    const entry = terminals.get(instanceId);
    if (entry) entry.terminal.scrollToBottom();
  };

  return (
    <div
      ref={containerRef}
      className="terminal-container"
      style={{ display: active ? "block" : "none", width: "100%", height: "100%" }}
      onClick={handleClick}
    />
  );
}

export function cleanupTerminal(instanceId: string) {
  const entry = terminals.get(instanceId);
  if (entry) {
    entry.terminal.dispose();
    terminals.delete(instanceId);
  }
}
