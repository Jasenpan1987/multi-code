import { useState } from "react";
import { ContextMenu } from "./ContextMenu";
import { Avatar } from "./Avatar";
import { formatContextPercent, formatTokens } from "./formatTokens";
import type { ContextUsage, Instance } from "../../shared/types";

// The row shows an abbreviated count, plus a percentage **only when the window size
// is actually known**; the exact figures, the model and the age go in the tooltip.
// Neither CLI records the window in its transcript, so it is resolved from the user's
// own config and is often unavailable — a session with no denominator shows the bare
// count rather than a guessed percentage.
function contextTitle(usage: ContextUsage): string {
  const parts = [`${usage.inputTokens.toLocaleString()} tokens in context`];
  if (usage.contextWindow) {
    parts.push(`of ${usage.contextWindow.toLocaleString()}`);
  }
  if (usage.model) parts.push(usage.model);
  if (usage.updatedAt > 0) {
    parts.push(`as of ${new Date(usage.updatedAt).toLocaleTimeString()}`);
  }
  return parts.join(" · ");
}

// The percentage *replaces* the count rather than joining it, and only because of
// space: showing both ("275k · 27%") pushed the project name down to two characters
// at the current sidebar width, which defeats the point of a contact list. The exact
// count and the window are in the tooltip either way.
//
// Sessions whose window can't be resolved keep the bare count — that is the whole
// distinction this feature rests on.
function contextLabel(usage: ContextUsage): string {
  const percent = formatContextPercent(usage.inputTokens, usage.contextWindow);
  return percent || formatTokens(usage.inputTokens);
}

// Absent when the window isn't known, so nothing is tinted on a guess.
function fillBand(usage: ContextUsage): string | undefined {
  if (!usage.contextWindow) return undefined;
  const ratio = usage.inputTokens / usage.contextWindow;
  if (ratio >= 0.9) return "high";
  if (ratio >= 0.7) return "medium";
  return "low";
}

interface ContactListProps {
  instances: Instance[];
  selectedId: string | null;
  unreadIds: Set<string>;
  onSelect: (id: string) => void;
  onNew: () => void;
  onNewManager: () => void;
  onStart: (id: string) => void;
  onRestart: (id: string) => void;
  onRemove: (id: string) => void;
}

export function ContactList({
  instances,
  selectedId,
  unreadIds,
  onSelect,
  onNew,
  onNewManager,
  onStart,
  onRestart,
  onRemove,
}: ContactListProps) {
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    instanceId: string;
  } | null>(null);

  // Keep positions fixed: render in creation order (the order contacts are
  // stored / appended). Status changes (start/stop) update fields in place and
  // never reorder, so a project going online won't jump to the top. Online vs
  // offline is conveyed by the avatar, not by position.
  //
  // The one exception is the manager, pinned to the top. It is the contact the user
  // talks to about all the others, so it shouldn't sit at whatever position it
  // happened to be created in. Array.sort is stable, so everything else keeps its
  // creation order.
  const ordered = [...instances].sort(
    (a, b) => Number(!!b.isManager) - Number(!!a.isManager)
  );
  const hasManager = instances.some((i) => i.isManager);

  const handleContextMenu = (e: React.MouseEvent, instanceId: string) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, instanceId });
  };

  const contextInstance = contextMenu
    ? instances.find((i) => i.id === contextMenu.instanceId)
    : null;

  return (
    <aside className="sidebar">
      <div className="contact-list">
        {ordered.length === 0 ? (
          <div className="sidebar-placeholder">No instances</div>
        ) : (
          ordered.map((inst) => (
            <div
              key={inst.id}
              className={`contact-item ${selectedId === inst.id ? "selected" : ""} ${inst.status === "stopped" ? "stopped" : ""} ${unreadIds.has(inst.id) ? "unread" : ""} ${inst.isManager ? "manager" : ""}`}
              onClick={() => onSelect(inst.id)}
              onContextMenu={(e) => handleContextMenu(e, inst.id)}
            >
              <Avatar
                name={inst.name}
                online={inst.status === "running"}
                blink={unreadIds.has(inst.id)}
                backend={inst.backend}
                isManager={inst.isManager}
              />
              <span className="contact-name">{inst.name}</span>
              {inst.contextUsage && (
                <span
                  className="contact-context"
                  title={contextTitle(inst.contextUsage)}
                  // Only present when the window size is known, so the row can be
                  // tinted by fullness without pretending to know it otherwise.
                  data-fill={fillBand(inst.contextUsage)}
                >
                  {contextLabel(inst.contextUsage)}
                </span>
              )}
              {unreadIds.has(inst.id) && <span className="unread-badge" />}
              {inst.status === "stopped" && (
                <button
                  className="start-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    onStart(inst.id);
                  }}
                  title="Start"
                >
                  ▶
                </button>
              )}
            </div>
          ))
        )}
      </div>
      <div className="sidebar-actions">
        <button className="new-instance-btn-bottom" onClick={onNew}>
          + New
        </button>
        {/* Only offered while there isn't one: the manager is a singleton, and a
            button that always fails is worse than one that goes away. */}
        {!hasManager && (
          <button
            className="new-manager-btn"
            onClick={onNewManager}
            title="Create the manager — one agent you talk to that can see and drive all the others"
          >
            + Manager
          </button>
        )}
      </div>

      {contextMenu && contextInstance && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(null)}
          items={[
            {
              label: "Restart",
              onClick: () => onRestart(contextMenu.instanceId),
              disabled: contextInstance.status === "running",
            },
            {
              label: "Remove",
              onClick: () => onRemove(contextMenu.instanceId),
            },
          ]}
        />
      )}
    </aside>
  );
}
