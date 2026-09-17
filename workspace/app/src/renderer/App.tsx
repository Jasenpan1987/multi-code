import { useEffect, useState, useCallback, useRef } from "react";
import { ContactList } from "./components/ContactList";
import { NewInstanceDialog } from "./components/NewInstanceDialog";
import { ManagerTrustHint } from "./components/ManagerTrustHint";
import {
  TerminalView,
  cleanupTerminal,
  getTerminal,
} from "./components/TerminalView";
import { ComposeBox } from "./components/ComposeBox";
import { DiffWindow } from "./components/DiffWindow";
import { cleanupShellTerminal } from "./components/TerminalSection";
import { Toolbox } from "./components/Toolbox";
import { ThemeToggle } from "./components/ThemeToggle";
import { VersionBadge } from "./components/VersionBadge";
import { useNotifications } from "./hooks/useNotifications";
import { ThemeContext } from "./hooks/useTheme";
import { playMessageSound, playCoughSound } from "./audio/sounds";
import { shouldPlayAttentionSound } from "./audio/attentionPolicy";
import type {
  Instance,
  BackendName,
  DiffSide,
  ThemeName,
} from "../shared/types";

const DEFAULT_EXPANDED_SECTION = "git";

export function App() {
  const [instances, setInstances] = useState<Instance[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [trustHintOpen, setTrustHintOpen] = useState(false);
  const [unreadIds, setUnreadIds] = useState<Set<string>>(new Set());
  const [expandedByInstance, setExpandedByInstance] = useState<
    Map<string, string>
  >(new Map());
  const [openPathByInstance, setOpenPathByInstance] = useState<
    Map<string, string>
  >(new Map());
  const [hasOutput, setHasOutput] = useState<Set<string>>(new Set());
  const [toolboxWidth, setToolboxWidth] = useState(480);
  const [theme, setThemeState] = useState<ThemeName>("light");
  const [composeOpen, setComposeOpen] = useState(false);
  // The file the diff window is showing, or null when it's closed. Not
  // per-instance: a diff belongs to a moment, so switching instances closes it
  // rather than remembering one per contact.
  const [diffTarget, setDiffTarget] = useState<{
    relPath: string;
    side: DiffSide;
  } | null>(null);
  // Text pushed into the compose box from outside it — the diff window's
  // "Ask agent". The nonce is what makes the same reference insertable twice.
  const [composeSeed, setComposeSeed] = useState<{
    text: string;
    nonce: number;
  } | null>(null);

  const { notify, markRead } = useNotifications();
  // Per-instance timestamp of the last audible alert, for the QQ-style
  // burst-collapse cooldown. Only real alerts record here, so a
  // suppressed-while-watching event doesn't eat cooldown. Lifted out of the
  // effect below because the effect re-subscribes on every instances change
  // and a ref inside it would reset the cooldown each time.
  const lastSoundAtRef = useRef(new Map<string, number>());

  // Load saved contacts on startup
  useEffect(() => {
    window.electronAPI.loadContacts().then((saved) => {
      if (saved.length > 0) {
        setInstances(saved);
      }
    });
  }, []);

  // Context usage is polled, not watched. It only moves when a turn completes,
  // and the main process throttles the underlying transcript read, so asking is
  // cheap. Two triggers: agent activity (a turn just ended, so the number just
  // changed) and a slow interval as a backstop for anything that ends without
  // firing an activity event.
  //
  // Only the usage field is merged in — the rest of each instance is owned by the
  // event handlers below, and replacing whole objects here would race with them.
  const refreshContextUsage = useCallback(() => {
    void window.electronAPI.listInstances().then((fresh) => {
      const byId = new Map(fresh.map((i) => [i.id, i]));
      setInstances((prev) =>
        prev.map((inst) => {
          const next = byId.get(inst.id);
          if (!next) return inst;
          if (
            next.contextUsage?.inputTokens === inst.contextUsage?.inputTokens &&
            next.contextUsage?.updatedAt === inst.contextUsage?.updatedAt
          ) {
            // Same object back so the list doesn't re-render on every poll.
            return inst;
          }
          return { ...inst, contextUsage: next.contextUsage };
        })
      );
    });
  }, []);

  useEffect(() => {
    refreshContextUsage();
    const timer = setInterval(refreshContextUsage, 30_000);
    return () => clearInterval(timer);
  }, [refreshContextUsage]);

  useEffect(() => {
    return window.electronAPI.onInstanceActivity(() => refreshContextUsage());
  }, [refreshContextUsage]);

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
  //
  // The beep and dock bounce are gated by the QQ-style attention policy:
  // silent while the user is already looking at this instance (window focused
  // and instance selected), and collapsed when "prompt" + "waiting" land in
  // one burst (5s per-instance cooldown). "prompt" is urgent — the agent is
  // blocked until the user acts — so it sounds even while the user is
  // watching, and its badge is not auto-cleared. The badge flash still
  // happens either way, and a paired phone keeps receiving every activity.
  useEffect(() => {
    const cleanup = window.electronAPI.onInstanceActivity((id, type) => {
      const urgent = type === "prompt";
      const now = Date.now();
      const lastSoundAt = lastSoundAtRef.current.get(id) ?? 0;
      if (
        shouldPlayAttentionSound({
          isSelected: id === selectedId,
          windowFocused: document.hasFocus(),
          lastSoundAt,
          now,
          urgent,
        })
      ) {
        lastSoundAtRef.current.set(id, now);
        // Play sound when the agent needs attention (gated above).
        playMessageSound();
        // Bounce the Dock — macOS only bounces if app is not in front,
        // which is exactly the QQ-style behavior we want.
        window.electronAPI.bounceDock();
      }

      const inst = instances.find((i) => i.id === id);
      if (!inst) return;

      // Flash for every instance — including the selected one (QQ-style).
      notify(id, inst.name);

      // If it's the currently selected one, the user is already looking at it,
      // so auto-clear the unread state shortly after — unless the agent is
      // blocked on a prompt, in which case the red dot stays until the user
      // actually reads/answers it.
      if (id === selectedId && !urgent) {
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

  // Listen for instances starting. The user clicking play already updates this
  // list from the IPC return value; this is for the starts the user didn't make —
  // the manager's `start_session` tool goes straight to the main process, and
  // without this the row kept saying OFFLINE while the session was running.
  useEffect(() => {
    const cleanup = window.electronAPI.onInstanceStarted((started) => {
      setInstances((prev) =>
        prev.map((inst) => (inst.id === started.id ? { ...inst, ...started } : inst))
      );
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
  // box for a running instance. Gated here so the hotkey is a no-op for stopped
  // instances. Both backends drive their TUI over the same bracketed-paste + \r
  // channel, so the box works for claude and opencode alike. The box is per the
  // selected instance and mounted with key={selectedId}, so it always targets
  // selectedId.
  useEffect(() => {
    const handler = (e: Event) => {
      const { id } = (e as CustomEvent).detail;
      const inst = instances.find((i) => i.id === id);
      if (!inst || inst.status !== "running") {
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
    setDiffTarget(null);
    // A stale reference must not reappear in another instance's box.
    setComposeSeed(null);
  }, [selectedId]);

  const closeCompose = useCallback(() => {
    setComposeOpen(false);
    if (selectedId) getTerminal(selectedId)?.focus();
  }, [selectedId]);

  // The Git section's "View" tag. One file at a time; opening another replaces it.
  const handleViewDiff = useCallback((relPath: string, side: DiffSide) => {
    setDiffTarget({ relPath, side });
  }, []);

  const closeDiff = useCallback(() => {
    setDiffTarget(null);
    if (selectedId) getTerminal(selectedId)?.focus();
  }, [selectedId]);

  // "Ask agent" in the diff window: put the reference in the compose box and open
  // it. The diff window stays open — it isn't modal, and the question is usually
  // about what's still on screen.
  const handleAskAgent = useCallback((ref: string) => {
    setComposeSeed({ text: `${ref} `, nonce: Date.now() });
    setComposeOpen(true);
  }, []);

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

  // No dialog: the manager has nothing to configure. Its directory belongs to
  // Multi-Code and it only runs on claude, so the button does the whole job.
  const handleNewManager = useCallback(async () => {
    try {
      const { instance, seededWorkspace } =
        await window.electronAPI.createManager();
      setInstances((prev) => [...prev, instance]);
      setSelectedId(instance.id);
      playCoughSound();
      // Only on the run that created the folder, which is the only run whose CLI
      // stops on the trust dialog. Its default answer shuts the manager down, so
      // this warning is the difference between a working manager and one that dies
      // the moment the user presses Enter.
      if (seededWorkspace) setTrustHintOpen(true);
    } catch (err) {
      // Main rejects when one already exists, which shouldn't be reachable since
      // the button hides then — but a silent no-op would be worse than a message.
      window.alert(
        err instanceof Error ? err.message : "Could not create the manager."
      );
    }
  }, []
  );

  // Drag-to-reorder. Only the intent is sent; the main process owns the order (it is
  // the contacts.json layout) and applies the move to what it has stored. Rendering
  // what comes back rather than updating optimistically keeps the two in step.
  const handleMove = useCallback(
    async (dragId: string, targetId: string, placeBefore: boolean) => {
      setInstances(
        await window.electronAPI.moveContact(dragId, targetId, placeBefore)
      );
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
      setOpenPathByInstance((prev) => {
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

  const handleOpenPath = useCallback(
    (path: string) => {
      if (!selectedId) return;
      setOpenPathByInstance((prev) => {
        const next = new Map(prev);
        next.set(selectedId, path);
        return next;
      });
    },
    [selectedId]
  );

  // Open a file in the Markdown View AND expand the View section, in one action.
  // Used by the Git section's per-file "View" affordance for .md entries and by
  // clicking a .md path in the terminal.
  const handlePreviewInView = useCallback(
    (path: string) => {
      if (!selectedId) return;
      setOpenPathByInstance((prev) => {
        const next = new Map(prev);
        next.set(selectedId, path);
        return next;
      });
      setExpandedByInstance((prev) => {
        const next = new Map(prev);
        next.set(selectedId, "view");
        return next;
      });
    },
    [selectedId]
  );

  // Clicking a .md path in the terminal (TerminalView's link provider) opens
  // that file in the Markdown View and expands the View section — same action
  // as the Git section's per-file "View" affordance. Only acts on the event's
  // own instance so a click never targets the wrong toolbox.
  useEffect(() => {
    const handler = (e: Event) => {
      const { id, path } = (e as CustomEvent).detail;
      if (id !== selectedId || typeof path !== "string" || !path) return;
      handlePreviewInView(path);
    };
    window.addEventListener("md-open", handler);
    return () => window.removeEventListener("md-open", handler);
  }, [selectedId, handlePreviewInView]);

  const selectedInstance = selectedId
    ? instances.find((i) => i.id === selectedId)
    : null;
  // Backend of the currently selected instance drives the outer-chrome skin
  // (blue for claude, green for opencode). Backend is per-instance, so this
  // rides selection rather than the global <html data-theme>. Falls back to
  // claude when nothing is selected so the empty state keeps the classic look.
  const activeBackend: BackendName = selectedInstance?.backend ?? "claude";

  return (
    <ThemeContext.Provider value={{ theme, setTheme }}>
    <div className="app-container" data-backend={activeBackend}>
      <VersionBadge />
      <ThemeToggle />
      <ContactList
        instances={instances}
        selectedId={selectedId}
        unreadIds={unreadIds}
        onSelect={handleSelect}
        onNew={() => setDialogOpen(true)}
        onNewManager={handleNewManager}
        onMove={handleMove}
        onStart={handleStart}
        onRestart={handleRestart}
        onRemove={handleRemove}
      />
      <main className="content">
        {selectedInstance && (
          <div className="content-header">
            <span className="content-header-name">
              {selectedInstance.name || ""}
            </span>
            <span
              className="content-header-backend"
              data-backend={selectedInstance.backend}
            >
              {selectedInstance.backend === "opencode"
                ? "OpenCode"
                : "Claude Code"}
            </span>
            <span className="content-header-status">
              {selectedInstance.status === "running" ? "Online" : "Offline"}
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
            if (!selectedInstance) return null;
            if (selectedInstance.status === "stopped") {
              return (
                <div className="content-offline-overlay">
                  <div className="content-offline-text">Offline</div>
                </div>
              );
            }
            if (
              selectedInstance.status === "running" &&
              !hasOutput.has(selectedInstance.id)
            ) {
              const label =
                selectedInstance.backend === "opencode"
                  ? "OpenCode"
                  : "Claude Code";
              return (
                <div className="content-starting-overlay">
                  <div className="content-spinner" />
                  <div className="content-starting-text">
                    Starting {label}…
                  </div>
                </div>
              );
            }
            return null;
          })()}
          {(() => {
            if (
              !composeOpen ||
              !selectedInstance ||
              selectedInstance.status !== "running"
            ) {
              return null;
            }
            return (
              <ComposeBox
                key={selectedInstance.id}
                instanceId={selectedInstance.id}
                onClose={closeCompose}
                seed={composeSeed}
              />
            );
          })()}
        </div>
      </main>

      {(() => {
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
              openPath={openPathByInstance.get(selectedInstance.id) ?? ""}
              onOpenPath={isOffline ? () => {} : handleOpenPath}
              onPreviewInView={isOffline ? () => {} : handlePreviewInView}
              onViewDiff={handleViewDiff}
              width={toolboxWidth}
            />
          </>
        );
      })()}

      <ManagerTrustHint
        open={trustHintOpen}
        onClose={() => setTrustHintOpen(false)}
      />

      <NewInstanceDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onSubmit={handleNewInstance}
      />

      {/* No key on purpose: pointing the window at another file re-fetches inside
          the same window, keeping wherever the user moved and sized it. */}
      {diffTarget && selectedInstance && (
        <DiffWindow
          instanceId={selectedInstance.id}
          cwd={selectedInstance.cwd}
          relPath={diffTarget.relPath}
          side={diffTarget.side}
          running={selectedInstance.status === "running"}
          onClose={closeDiff}
          onAskAgent={handleAskAgent}
        />
      )}
    </div>
    </ThemeContext.Provider>
  );
}
