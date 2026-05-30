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

    // macOS terminal emulators (Terminal.app, iTerm2) translate Cmd+Delete
    // to \x15 (Ctrl+U) before forwarding to the PTY. xterm.js does not do
    // this by default, so we replicate the translation here. Both Claude
    // Code and OpenCode honor \x15 to clear the input line.
    terminal.attachCustomKeyEventHandler((e) => {
      if (
        e.type === "keydown" &&
        e.metaKey &&
        (e.key === "Backspace" || e.key === "Delete")
      ) {
        window.electronAPI.writeToInstance(instanceId, "\x15");
        return false;
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

    const { fitAddon } = entry;

    // Fit when becoming active (delay to ensure container is sized)
    requestAnimationFrame(() => {
      fitAddon.fit();
    });

    const handleResize = () => fitAddon.fit();
    window.addEventListener("resize", handleResize);
    window.addEventListener("layout-resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
      window.removeEventListener("layout-resize", handleResize);
    };
  }, [instanceId, active]);

  return (
    <div
      ref={containerRef}
      className="terminal-container"
      style={{ display: active ? "block" : "none", width: "100%", height: "100%" }}
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
