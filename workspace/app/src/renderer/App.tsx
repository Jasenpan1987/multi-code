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
import { SecretaryCard } from "./components/SecretaryCard";
import {
  applyBriefUpdate,
  cardOnSelect,
  mergeBriefSnapshot,
  openCardBrief,
} from "./components/secretaryBrief";
import type { BriefMap, OpenCard } from "./components/secretaryBrief";
import { DiffWindow } from "./components/DiffWindow";
import { cleanupShellTerminal } from "./components/TerminalSection";
import { Toolbox } from "./components/Toolbox";
import { ThemeToggle } from "./components/ThemeToggle";
import { VersionBadge } from "./components/VersionBadge";
import { useNotifications } from "./hooks/useNotifications";
import { ThemeContext } from "./hooks/useTheme";
import { playMessageSound, playCoughSound, stopMessageSound } from "./audio/sounds";
import { acknowledgesShownInstance } from "./audio/attentionPolicy";
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
  // Any pane can fold to a thin strip, for when only one of them matters. The
  // terminal and the toolbox never fold together, since one of them has to fill
  // the window: one value for the pair, so folding one unfolds the other. Not
  // saved; a restart shows all three.
  const [sidebarFolded, setSidebarFolded] = useState(false);
  const [foldedPane, setFoldedPane] = useState<"content" | "toolbox" | null>(
    null
  );
  const [theme, setThemeState] = useState<ThemeName>("light");
  // A dev run and the installed app can be open at once, on separate data
  // directories. This is what marks which is which.
  const [isDev, setIsDev] = useState(false);
  const [composeOpen, setComposeOpen] = useState(false);
  // The file the diff window is showing, or null when it's closed. Not
  // per-instance: a diff belongs to a moment, so switching instances closes it
  // rather than remembering one per contact.
  const [diffTarget, setDiffTarget] = useState<{
    relPath: string;
    side: DiffSide;
    // Only for a rename; git needs both paths to detect one.
    oldPath?: string;
  } | null>(null);
  // Text pushed into the compose box from outside it — the diff window's
  // "Ask agent". The nonce is what makes the same reference insertable twice.
  const [composeSeed, setComposeSeed] = useState<{
    text: string;
    nonce: number;
  } | null>(null);

  // Voice secretary (epic voice-secretary). The mode and every live brief as main
  // pushes them, and the card open over the terminal, if any. See secretaryBrief.ts
  // for when a card opens and closes.
  const [secretaryMode, setSecretaryMode] = useState(false);
  const [briefs, setBriefs] = useState<BriefMap>({});
  const [card, setCard] = useState<OpenCard | null>(null);

  const { notify, markRead } = useNotifications();
  // Per-instance timestamp of the last audible alert, for the
  // burst-collapse cooldown. Only real alerts record here, so a
  // suppressed-while-watching event doesn't eat cooldown. Lifted out of the
  // effect below because the effect re-subscribes on every instances change
  // and a ref inside it would reset the cooldown each time.

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

  // Subscribed before the initial values are fetched, so a push in between isn't
  // lost; for an instance a push has already touched, the push wins over the
  // snapshot.
  useEffect(() => {
    let live = true;
    let modePushed = false;
    const touched = new Set<string>();
    const offBrief = window.electronAPI.onSecretaryBrief((id, state) => {
      touched.add(id);
      setBriefs((prev) => applyBriefUpdate(prev, id, state));
    });
    const offMode = window.electronAPI.onSecretaryMode((enabled) => {
      modePushed = true;
      setSecretaryMode(enabled);
    });
    void window.electronAPI.getSecretarySettings().then((settings) => {
      if (live && !modePushed) setSecretaryMode(settings.secretaryMode);
    });
    void window.electronAPI.getSecretaryBriefs().then((snapshot) => {
      if (live) setBriefs((prev) => mergeBriefSnapshot(prev, snapshot, touched));
    });
    return () => {
      live = false;
      offBrief();
      offMode();
    };
  }, []);

  // The card belongs to one brief of the shown contact. Switching contacts, the
  // mode going off, the brief dropped (answered in the terminal) or replaced by a
  // newer event's: each closes it, and closing it stops its audio.
  const cardBrief = openCardBrief(card, { modeOn: secretaryMode, selectedId, briefs });
  useEffect(() => {
    if (card && !cardBrief) setCard(null);
  }, [card, cardBrief]);

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

  // Every attention event, "waiting" (finished) or "prompt" (needs you), for any
  // instance: chime, red dot, Dock bounce. Nothing is suppressed for the instance
  // being watched, and nothing clears on a timer: the alert stays until the
  // builder acknowledges it (below). See audio/attentionPolicy.ts.
  //
  // bounceDock is app.dock.bounce("critical"), which macOS ignores while the app
  // is frontmost and otherwise keeps up until the app is brought forward.
  useEffect(() => {
    const cleanup = window.electronAPI.onInstanceActivity((id) => {
      playMessageSound(id);
      window.electronAPI.bounceDock();
      const inst = instances.find((i) => i.id === id);
      if (inst) notify(id, inst.name);
    });
    return cleanup;
  }, [instances, notify]);

  // Acknowledging the shown instance: any key press, or a click in its page.
  // Stops its chime and clears its red dot. Window focus alone clears nothing.
  //
  // Capture phase, because xterm handles keys on its own hidden textarea and some
  // components stop propagation, so a bubble-phase listener would miss input.
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;
  useEffect(() => {
    const acknowledge = (e: Event) => {
      const id = selectedIdRef.current;
      if (!id || !acknowledgesShownInstance(e.target)) return;
      stopMessageSound(id);
      markRead(id);
    };
    window.addEventListener("keydown", acknowledge, true);
    window.addEventListener("pointerdown", acknowledge, true);
    return () => {
      window.removeEventListener("keydown", acknowledge, true);
      window.removeEventListener("pointerdown", acknowledge, true);
    };
  }, [markRead]);

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

  useEffect(() => {
    window.electronAPI.isDevBuild().then(setIsDev);
  }, []);

  // An instance whose hooks stopped (or started) reaching Multi-Code.
  useEffect(() => {
    return window.electronAPI.onInstanceAlertsDegraded((id, degraded) => {
      setInstances((prev) =>
        prev.map((inst) =>
          inst.id === id ? { ...inst, alertsDegraded: degraded || undefined } : inst
        )
      );
    });
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
      // The box opens over the terminal, so a folded terminal comes back.
      setFoldedPane((p) => (p === "content" ? null : p));
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
  const handleViewDiff = useCallback(
    (relPath: string, side: DiffSide, oldPath?: string) => {
      setDiffTarget({ relPath, side, oldPath });
    },
    []
  );

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
    setFoldedPane((p) => (p === "content" ? null : p));
  }, []);

  // Selecting a contact acknowledges that contact, never the one being left. With
  // Secretary Mode on, a contact that showed a red dot at the moment of the click
  // and has a brief also opens its card, which plays the brief. Read from refs,
  // as rendered, before markRead clears the dot.
  const secretaryRef = useRef({ modeOn: secretaryMode, unreadIds, briefs });
  secretaryRef.current = { modeOn: secretaryMode, unreadIds, briefs };
  const handleSelect = useCallback(
    (id: string) => {
      const { modeOn, unreadIds: unread, briefs: live } = secretaryRef.current;
      const opened = cardOnSelect(id, modeOn, unread, live);
      setSelectedId(id);
      stopMessageSound(id);
      markRead(id);
      if (opened) setCard(opened);
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
  // The toolbox only exists for a selected session, so without one nothing is
  // folded and the terminal area fills the window.
  const folded = selectedInstance ? foldedPane : null;

  // Folding or unfolding a pane resizes the others, and terminals only refit
  // when told to.
  useEffect(() => {
    window.dispatchEvent(new Event("layout-resize"));
  }, [sidebarFolded, folded]);

  return (
    <ThemeContext.Provider value={{ theme, setTheme }}>
    <div
      className="app-container"
      data-backend={activeBackend}
      data-dev={isDev ? "true" : undefined}
    >
      <VersionBadge dev={isDev} />
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
        folded={sidebarFolded}
        onToggleFolded={() => setSidebarFolded((f) => !f)}
      />
      {/* Hidden rather than unmounted: its terminals keep their scrollback. */}
      <main className="content" hidden={folded === "content"}>
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
        {selectedInstance?.status === "running" && selectedInstance.alertsDegraded && (
          // PRD Story 6: say so rather than go quiet. No fallback guesses at the
          // state instead; see docs/specs/attention-alerts/prd.md.
          selectedInstance.backend === "opencode" ? (
            <div
              className="alerts-degraded-bar"
              title={
                "Multi-Code hears when a session finishes or needs you through a plugin it " +
                "loads into opencode at launch, and it hasn't reported from this one. Likely " +
                "causes: an OPENCODE_CONFIG_CONTENT in Multi-Code's environment that isn't " +
                "plain JSON, opencode run with --pure, or a config error that stopped plugins " +
                "loading."
              }
            >
              Multi-Code&apos;s plugin isn&apos;t running in this session, so Multi-Code can&apos;t
              tell you when it finishes or needs you. Check on it yourself.
            </div>
          ) : (
            <div
              className="alerts-degraded-bar"
              title={
                "Multi-Code hears when a session finishes or needs you through hooks it passes " +
                "to claude at launch, and none have arrived from this one. Likely causes: " +
                '"disableAllHooks": true in your Claude settings, or a managed policy that ' +
                "allows only managed hooks."
              }
            >
              Hooks aren&apos;t running in this session, so Multi-Code can&apos;t tell you when it
              finishes or needs you. Check on it yourself.
            </div>
          )
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
          {selectedInstance && card && cardBrief ? (
            <SecretaryCard
              key={`${card.instanceId}#${card.seq}`}
              instanceId={card.instanceId}
              name={selectedInstance.name}
              brief={cardBrief}
              onClose={() => setCard(null)}
            />
          ) : null}
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
      {folded === "content" && (
        <button
          type="button"
          className="fold-strip"
          onClick={() => setFoldedPane(null)}
          title="Show the terminal"
          aria-label="Show the terminal"
        >
          ›
        </button>
      )}

      {(() => {
        if (!selectedInstance) return null;
        const isOffline = selectedInstance.status === "stopped";
        return (
          <>
            {folded === null && (
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
                  // The sidebar is narrower when folded, which leaves the toolbox
                  // more room to grow into.
                  const sidebarWidth =
                    document.querySelector(".sidebar")?.getBoundingClientRect()
                      .width ?? 0;
                  const onMove = (ev: MouseEvent) => {
                    const delta = startX - ev.clientX;
                    const next = Math.max(
                      280,
                      Math.min(
                        window.innerWidth - 280 - sidebarWidth,
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
              >
                {/* Each tab sits on the edge of the pane it folds and points the
                    way that pane goes. */}
                <button
                  type="button"
                  className="fold-tab"
                  data-edge="content"
                  // Not the start of a drag.
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={() => setFoldedPane("content")}
                  title="Hide the terminal, the toolbox takes its room"
                  aria-label="Hide the terminal"
                >
                  ‹
                </button>
                <button
                  type="button"
                  className="fold-tab"
                  data-edge="toolbox"
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={() => setFoldedPane("toolbox")}
                  title="Hide the toolbox"
                  aria-label="Hide the toolbox"
                >
                  ›
                </button>
              </div>
            )}
            {folded === "toolbox" && (
              <button
                type="button"
                className="fold-strip"
                data-pane="toolbox"
                onClick={() => setFoldedPane(null)}
                title="Show the toolbox"
                aria-label="Show the toolbox"
              >
                ‹
              </button>
            )}
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
              // With the terminal folded, the toolbox fills the window.
              width={folded === "content" ? null : toolboxWidth}
              hidden={folded === "toolbox"}
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
          oldPath={diffTarget.oldPath}
          running={selectedInstance.status === "running"}
          onClose={closeDiff}
          onAskAgent={handleAskAgent}
        />
      )}
    </div>
    </ThemeContext.Provider>
  );
}
