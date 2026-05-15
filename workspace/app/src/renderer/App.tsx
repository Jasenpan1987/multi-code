import { useEffect, useState, useCallback } from "react";
import { ContactList } from "./components/ContactList";
import { NewInstanceDialog } from "./components/NewInstanceDialog";
import { TerminalView, cleanupTerminal } from "./components/TerminalView";
import { useNotifications } from "./hooks/useNotifications";
import { playMessageSound, playCoughSound } from "./audio/sounds";
import type { Instance } from "../shared/types";

export function App() {
  const [instances, setInstances] = useState<Instance[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [unreadIds, setUnreadIds] = useState<Set<string>>(new Set());

  const { notify, markRead } = useNotifications({ selectedId });

  // Load saved contacts on startup
  useEffect(() => {
    window.electronAPI.loadContacts().then((saved) => {
      if (saved.length > 0) {
        setInstances(saved);
      }
    });
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
    });
    return cleanup;
  }, []);

  // Listen for structured activity events (assistant response done, etc.)
  useEffect(() => {
    const cleanup = window.electronAPI.onInstanceActivity((id) => {
      // Always play sound when agent finishes work
      playMessageSound();

      // If not selected, also flash + badge
      if (id !== selectedId) {
        const inst = instances.find((i) => i.id === id);
        if (inst) notify(id, inst.name);
      }
    });
    return cleanup;
  }, [selectedId, instances, notify]);

  // Listen for instance exit
  useEffect(() => {
    const cleanup = window.electronAPI.onInstanceExit((id) => {
      setInstances((prev) =>
        prev.map((inst) =>
          inst.id === id ? { ...inst, status: "stopped" as const } : inst
        )
      );
    });
    return cleanup;
  }, []);

  const handleSelect = useCallback(
    (id: string) => {
      setSelectedId(id);
      markRead(id);
    },
    [markRead]
  );

  const handleNewInstance = useCallback(
    async (cwd: string, alias?: string) => {
      const instance = await window.electronAPI.createInstance(cwd, alias);
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
      window.electronAPI.removeInstance(id);
      setInstances((prev) => prev.filter((inst) => inst.id !== id));
      if (selectedId === id) {
        setSelectedId(null);
      }
    },
    [selectedId]
  );

  return (
    <div className="app-container">
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
        </div>
      </main>

      <NewInstanceDialog
        open={dialogOpen}
        duplicateWarning={false}
        onClose={() => setDialogOpen(false)}
        onSubmit={handleNewInstance}
      />
    </div>
  );
}
