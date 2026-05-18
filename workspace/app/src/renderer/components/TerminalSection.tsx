import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";

interface TerminalSectionProps {
  instanceId: string;
  active: boolean;
}

interface ShellEntry {
  terminal: Terminal;
  fitAddon: FitAddon;
  spawned: boolean;
  exited: boolean;
  opened: boolean;
}

const shells = new Map<string, ShellEntry>();

export function cleanupShellTerminal(instanceId: string) {
  const entry = shells.get(instanceId);
  if (entry) {
    entry.terminal.dispose();
    shells.delete(instanceId);
  }
}

function getOrCreateEntry(instanceId: string): ShellEntry {
  let entry = shells.get(instanceId);
  if (entry) return entry;

  const terminal = new Terminal({
    cursorBlink: true,
    fontSize: 13,
    fontFamily: "Menlo, Monaco, 'Courier New', monospace",
    theme: {
      background: "#000000",
      foreground: "#ffffff",
      cursor: "#ffffff",
      selectionBackground: "#4a4a4a",
    },
    allowProposedApi: true,
  });

  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.loadAddon(new WebLinksAddon());

  terminal.onData((data) => {
    window.electronAPI.writeToShell(instanceId, data);
  });

  terminal.onResize(({ cols, rows }) => {
    window.electronAPI.resizeShell(instanceId, cols, rows);
  });

  entry = {
    terminal,
    fitAddon,
    spawned: false,
    exited: false,
    opened: false,
  };
  shells.set(instanceId, entry);
  return entry;
}

export function TerminalSection({ instanceId, active }: TerminalSectionProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [exited, setExited] = useState(false);
  const [restartTick, setRestartTick] = useState(0);

  useEffect(() => {
    if (!active) return;
    if (!containerRef.current) return;

    const entry = getOrCreateEntry(instanceId);
    setExited(entry.exited);
    const container = containerRef.current;

    if (!entry.opened) {
      // First time: let xterm create its own DOM inside our container
      container.innerHTML = "";
      entry.terminal.open(container);
      entry.opened = true;
    } else if (entry.terminal.element && entry.terminal.element.parentElement !== container) {
      // Re-mount: xterm.js does not allow open() to be called twice on the same
      // Terminal instance. Move the existing DOM node into our new container.
      container.innerHTML = "";
      container.appendChild(entry.terminal.element);
    }

    // Spawn shell if first time (lazy)
    if (!entry.spawned && !entry.exited) {
      entry.spawned = true;
      window.electronAPI.spawnShell(instanceId);
    }

    // Fit + push size to PTY
    requestAnimationFrame(() => {
      try {
        entry.fitAddon.fit();
      } catch {
        // ignore — container may not be ready in some edge cases
      }
      window.electronAPI.resizeShell(
        instanceId,
        entry.terminal.cols,
        entry.terminal.rows
      );
    });

    const handleResize = () => entry.fitAddon.fit();
    window.addEventListener("resize", handleResize);
    window.addEventListener("layout-resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
      window.removeEventListener("layout-resize", handleResize);
    };
  }, [instanceId, active, restartTick]);

  // Subscribe to output / exit (one global subscription per mount)
  useEffect(() => {
    const cleanupOutput = window.electronAPI.onShellOutput((id, data) => {
      const entry = shells.get(id);
      if (entry) entry.terminal.write(data);
    });
    const cleanupExit = window.electronAPI.onShellExit((id) => {
      const entry = shells.get(id);
      if (entry) {
        entry.exited = true;
        entry.spawned = false;
      }
      if (id === instanceId) setExited(true);
    });
    return () => {
      cleanupOutput();
      cleanupExit();
    };
  }, [instanceId]);

  const handleRestart = () => {
    const entry = shells.get(instanceId);
    if (entry) {
      entry.terminal.clear();
      entry.exited = false;
    }
    setExited(false);
    setRestartTick((n) => n + 1);
  };

  if (!active) return null;

  return (
    <div className="terminal-section">
      <div
        ref={containerRef}
        className="terminal-section-xterm"
        style={{ display: exited ? "none" : "block" }}
      />
      {exited && (
        <div className="terminal-section-exited">
          <div>Terminal exited</div>
          <button
            type="button"
            className="quick-action-btn"
            onClick={handleRestart}
          >
            Restart
          </button>
        </div>
      )}
    </div>
  );
}
