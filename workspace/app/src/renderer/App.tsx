import { useEffect, useState, useCallback } from "react";
import { ContactList } from "./components/ContactList";
import { NewInstanceDialog } from "./components/NewInstanceDialog";
import {
  TerminalView,
  cleanupTerminal,
  getTerminal,
} from "./components/TerminalView";
import { ComposeBox } from "./components/ComposeBox";
import { cleanupShellTerminal } from "./components/TerminalSection";
import { Toolbox } from "./components/Toolbox";
import { ThemeToggle } from "./components/ThemeToggle";
import { useNotifications } from "./hooks/useNotifications";
import { ThemeContext } from "./hooks/useTheme";
import { playMessageSound, playCoughSound } from "./audio/sounds";
import type { Instance, BackendName, ThemeName } from "../shared/types";

const DEFAULT_EXPANDED_SECTION = "git";

export function App() {
  const [instances, setInstances] = useState<Instance[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [unreadIds, setUnreadIds] = useState<Set<string>>(new Set());
  const [expandedByInstance, setExpandedByInstance] = useState<
    Map<string, string>
  >(new Map());
  const [hasOutput, setHasOutput] = useState<Set<string>>(new Set());
  const [toolboxWidth, setToolboxWidth] = useState(480);
  const [theme, setThemeState] = useState<ThemeName>("light");
  const [composeOpen, setComposeOpen] = useState(false);

  const { notify, markRead } = useNotifications();

  // Load saved contacts on startup
  useEffect(() => {
    window.electronAPI.loadContacts().then((saved) => {
      if (saved.length > 0) {
        setInstances(saved);
      }
    });
  }, []);

  // Load saved theme on startup and apply to <html>
  useEffect(() => {
    window.electronAPI.getSettings().then((settings) => {
      setThemeState(settings.theme);
      document.documentElement.dataset.theme = settings.theme;
    });
  }, []);

  const setTheme = useCallback((next: ThemeName) => {
    setThemeState(next);
    document.documentElement.dataset.theme = next;
    void window.electronAPI.setTheme(next);
  }, []);

  // Listen for unread updates
  useEffect(() => {
    const handler = (e: Event) => {
      const { unread } = (e as CustomEvent).detail;
      setUnreadIds(new Set(unread));
    };
    window.addEventListener("unread-update", handler);
    return () => window.removeEventListener("unread-update", handler);
  }, []);

  // Dispatch PTY output to terminal views (no notification logic here)
  useEffect(() => {
    const cleanup = window.electronAPI.onPtyOutput((id, data) => {
      const event = new CustomEvent("pty-data", { detail: { id, data } });
      window.dispatchEvent(event);
      setHasOutput((prev) => {
        if (prev.has(id)) return prev;
        const next = new Set(prev);
        next.add(id);
        return next;
      });
    });
    return cleanup;
  }, []);

  // Listen for structured activity events. Fires both when a turn finishes
  // ("waiting") and when the agent is waiting on a yes/no prompt ("prompt").
  // Both get the same beep + flash, so we don't branch on the type here.
  useEffect(() => {
    const cleanup = window.electronAPI.onInstanceActivity((id) => {
      // Always play sound when the agent needs attention.
      playMessageSound();
      // Bounce the Dock — macOS only bounces if app is not in front,
      // which is exactly the QQ-style behavior we want.
      window.electronAPI.bounceDock();

      const inst = instances.find((i) => i.id === id);
      if (!inst) return;

      // Flash for every instance — including the selected one (QQ-style).
      notify(id, inst.name);

      // If it's the currently selected one, the user is already looking at it,
      // so auto-clear the unread state shortly after.
      if (id === selectedId) {
        setTimeout(() => markRead(id), 1500);
      }
    });
    return cleanup;
  }, [selectedId, instances, notify, markRead]);

  // Listen for instance exit
  useEffect(() => {
    const cleanup = window.electronAPI.onInstanceExit((id) => {
      setInstances((prev) =>
        prev.map((inst) =>
          inst.id === id ? { ...inst, status: "stopped" as const } : inst
        )
      );
      setHasOutput((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    });
    return cleanup;
  }, []);

  // Listen for session-id matched (used by Resume Elsewhere button)
  useEffect(() => {
    const cleanup = window.electronAPI.onInstanceSessionId((id, sessionId) => {
      setInstances((prev) =>
        prev.map((inst) => (inst.id === id ? { ...inst, sessionId } : inst))
      );
    });
    return cleanup;
  }, []);

  // Compose box: Cmd+L (dispatched from TerminalView's key handler) summons the
  // box for a running claude instance. Gated here so the hotkey is a no-op for
  // OpenCode / stopped instances (claude-only MVP). The box is per the selected
  // instance and mounted with key={selectedId}, so it always targets selectedId.
  useEffect(() => {
    const handler = (e: Event) => {
      const { id } = (e as CustomEvent).detail;
      const inst = instances.find((i) => i.id === id);
      if (!inst || inst.backend !== "claude" || inst.status !== "running") {
        return;
      }
      setComposeOpen(true);
    };
    window.addEventListener("compose-open", handler);
    return () => window.removeEventListener("compose-open", handler);
  }, [instances]);

  // Discard the draft when the selected instance changes: the box is keyed by
  // selectedId so it unmounts (cleaning up its temp images) and closing it here
  // ensures returning to the original instance shows an empty box (Story 5).
  useEffect(() => {
    setComposeOpen(false);
  }, [selectedId]);

  const closeCompose = useCallback(() => {
    setComposeOpen(false);
    if (selectedId) getTerminal(selectedId)?.focus();
  }, [selectedId]);

  const handleSelect = useCallback(
    (id: string) => {
      setSelectedId(id);
      markRead(id);
    },
    [markRead]
  );

  const handleNewInstance = useCallback(
    async (cwd: string, alias?: string, backend?: BackendName) => {
      const instance = await window.electronAPI.createInstance(
        cwd,
        alias,
        backend
      );
      setInstances((prev) => [...prev, instance]);
      setSelectedId(instance.id);
      setDialogOpen(false);
      playCoughSound();
    },
    []
  );

  const handleStart = useCallback(async (id: string) => {
    const instance = await window.electronAPI.startInstance(id);
    if (instance) {
      setInstances((prev) =>
        prev.map((inst) => (inst.id === id ? instance : inst))
      );
      setSelectedId(id);
      playCoughSound();
    }
  }, []);

  const handleRestart = useCallback(async (id: string) => {
    cleanupTerminal(id);
    const newInstance = await window.electronAPI.restartInstance(id);
    if (newInstance) {
      setInstances((prev) =>
        prev.map((inst) => (inst.id === id ? newInstance : inst))
      );
      setSelectedId(newInstance.id);
    }
  }, []);

  const handleRemove = useCallback(
    (id: string) => {
      cleanupTerminal(id);
      cleanupShellTerminal(id);
      window.electronAPI.removeInstance(id);
      setInstances((prev) => prev.filter((inst) => inst.id !== id));
      setExpandedByInstance((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Map(prev);
        next.delete(id);
        return next;
      });
      if (selectedId === id) {
        setSelectedId(null);
      }
    },
    [selectedId]
  );

  const handleExpandSection = useCallback(
    (sectionId: string) => {
      if (!selectedId) return;
      setExpandedByInstance((prev) => {
        const next = new Map(prev);
        next.set(selectedId, sectionId);
        return next;
      });
    },
    [selectedId]
  );

  return (
    <ThemeContext.Provider value={{ theme, setTheme }}>
    <div className="app-container">
      <ThemeToggle />
      <ContactList
        instances={instances}
        selectedId={selectedId}
        unreadIds={unreadIds}
        onSelect={handleSelect}
        onNew={() => setDialogOpen(true)}
        onStart={handleStart}
        onRestart={handleRestart}
        onRemove={handleRemove}
      />
      <main className="content">
        {selectedId && (
          <div className="content-header">
            <span className="content-header-name">
              {instances.find((i) => i.id === selectedId)?.name || ""}
            </span>
            <span className="content-header-status">
              {instances.find((i) => i.id === selectedId)?.status === "running"
                ? "Online"
                : "Offline"}
            </span>
          </div>
        )}
        <div className="content-terminal">
          {instances.filter((i) => i.status === "running").length > 0 ? (
            instances
              .filter((i) => i.status === "running")
              .map((inst) => (
                <TerminalView
                  key={inst.id}
                  instanceId={inst.id}
                  active={inst.id === selectedId}
                />
              ))
          ) : (
            <div className="content-placeholder">
              Click &quot;+ New&quot; to create a Claude Code instance
            </div>
          )}
          {(() => {
            const sel = selectedId
              ? instances.find((i) => i.id === selectedId)
              : null;
            if (!sel) return null;
            if (sel.status === "stopped") {
              return (
                <div className="content-offline-overlay">
                  <div className="content-offline-text">Offline</div>
                </div>
              );
            }
            if (sel.status === "running" && !hasOutput.has(sel.id)) {
              return (
                <div className="content-starting-overlay">
                  <div className="content-spinner" />
                  <div className="content-starting-text">
                    Starting Claude Code…
                  </div>
                </div>
              );
            }
            return null;
          })()}
          {(() => {
            const sel = selectedId
              ? instances.find((i) => i.id === selectedId)
              : null;
            if (
              !composeOpen ||
              !sel ||
              sel.backend !== "claude" ||
              sel.status !== "running"
            ) {
              return null;
            }
            return (
              <ComposeBox
                key={sel.id}
                instanceId={sel.id}
                onClose={closeCompose}
              />
            );
          })()}
        </div>
      </main>

      {(() => {
        const selectedInstance = selectedId
          ? instances.find((i) => i.id === selectedId)
          : null;
        if (!selectedInstance) return null;
        const isOffline = selectedInstance.status === "stopped";
        return (
          <>
            <div
              className="resizer"
              onMouseDown={(e) => {
                e.preventDefault();
                const startX = e.clientX;
                const startWidth = toolboxWidth;
                let raf = 0;
                const dispatchLayoutResize = () => {
                  if (raf) return;
                  raf = requestAnimationFrame(() => {
                    raf = 0;
                    window.dispatchEvent(new Event("layout-resize"));
                  });
                };
                const onMove = (ev: MouseEvent) => {
                  const delta = startX - ev.clientX;
                  const next = Math.max(
                    280,
                    Math.min(
                      window.innerWidth - 280 - 180,
                      startWidth + delta
                    )
                  );
                  setToolboxWidth(next);
                  dispatchLayoutResize();
                };
                const onUp = () => {
                  document.removeEventListener("mousemove", onMove);
                  document.removeEventListener("mouseup", onUp);
                  document.body.style.cursor = "";
                  document.body.style.userSelect = "";
                  if (raf) cancelAnimationFrame(raf);
                  // Final fit after resize finishes
                  window.dispatchEvent(new Event("layout-resize"));
                };
                document.addEventListener("mousemove", onMove);
                document.addEventListener("mouseup", onUp);
                document.body.style.cursor = "col-resize";
                document.body.style.userSelect = "none";
              }}
            />
            <Toolbox
              instance={selectedInstance}
              expandedSection={
                isOffline
                  ? ""
                  : (expandedByInstance.get(selectedInstance.id) ??
                    DEFAULT_EXPANDED_SECTION)
              }
              onExpandSection={isOffline ? () => {} : handleExpandSection}
              width={toolboxWidth}
            />
          </>
        );
      })()}

      <NewInstanceDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onSubmit={handleNewInstance}
      />
    </div>
    </ThemeContext.Provider>
  );
}
