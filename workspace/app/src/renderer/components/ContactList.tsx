import { useEffect, useRef, useState } from "react";
import { ContextMenu } from "./ContextMenu";
import { Avatar } from "./Avatar";
import { RenameSessionDialog } from "./RenameSessionDialog";
import { getTerminal } from "./TerminalView";
import { contextFillHue, formatContextPercent, formatTokens } from "./formatTokens";
import { dropsBefore, pinManagerFirst } from "./contactOrder";
import { hotkeyTargets, listenForContactHotkeys } from "./contactHotkeys";
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

// Two digits at most, so the badge stays a small circle.
function formatUnread(count: number): string {
  return count > 99 ? "99+" : String(count);
}

interface ContactListProps {
  instances: Instance[];
  selectedId: string | null;
  // Unread alerts per contact; absent means none.
  unreadCounts: ReadonlyMap<string, number>;
  onSelect: (id: string) => void;
  onNew: () => void;
  onNewManager: () => void;
  onStart: (id: string) => void;
  onRestart: (id: string) => void;
  onRemove: (id: string) => void;
  // A new contact on the same project, in a fresh session.
  onDuplicate: (id: string) => void;
  // The name this list shows; blank goes back to the folder name.
  onRename: (id: string, name: string) => void;
  // One drag, as an intent: put `dragId` before or after `targetId`.
  onMove: (dragId: string, targetId: string, placeBefore: boolean) => void;
  // Folded to a thin strip that unfolds it again; see the fold rules in App.
  folded: boolean;
  onToggleFolded: () => void;
}

export function ContactList({
  instances,
  selectedId,
  unreadCounts,
  onSelect,
  onNew,
  onNewManager,
  onStart,
  onRestart,
  onRemove,
  onDuplicate,
  onRename,
  onMove,
  folded,
  onToggleFolded,
}: ContactListProps) {
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    instanceId: string;
  } | null>(null);
  const [renameId, setRenameId] = useState<string | null>(null);
  // Which row is being dragged, and where it would land. `drop` drives the insertion
  // line, so the user can see the result before letting go.
  const [dragId, setDragId] = useState<string | null>(null);
  const [drop, setDrop] = useState<{ id: string; before: boolean } | null>(null);
  // The bubble with the full name of the row under the pointer, when the sidebar
  // cuts that name short. Placed beside the row, in viewport coordinates.
  const [nameTip, setNameTip] = useState<{
    text: string;
    left: number;
    top: number;
  } | null>(null);

  // Cmd+1…9 and the digits shown while Cmd is held; see contactHotkeys.
  const [showHotkeys, setShowHotkeys] = useState(false);
  const hotkeyIds = hotkeyTargets(instances);
  // For the key listener, subscribed once.
  const hotkeyRef = useRef({ hotkeyIds, onSelect });
  hotkeyRef.current = { hotkeyIds, onSelect };

  // Before the folded return: the keys still switch with the list folded away.
  useEffect(
    () =>
      listenForContactHotkeys(window, {
        targets: () => hotkeyRef.current.hotkeyIds,
        select: (id) => {
          hotkeyRef.current.onSelect(id);
          // A click on a row takes focus out of the terminal, a key doesn't: the
          // hidden terminal of the contact being left would get what is typed
          // next. So the shown one takes focus, once React has drawn it.
          if (document.activeElement instanceof HTMLElement) {
            document.activeElement.blur();
          }
          requestAnimationFrame(() => getTerminal(id)?.focus());
        },
        showHints: setShowHotkeys,
        paused: () => document.querySelector(".dialog-overlay") !== null,
      }),
    []
  );

  const endDrag = () => {
    setDragId(null);
    setDrop(null);
  };

  if (folded) {
    // Still `.sidebar`, so a click here never acknowledges the shown session
    // (attentionPolicy). The dot says some session is waiting, without unfolding.
    return (
      <aside className="sidebar folded">
        <button
          type="button"
          className="fold-strip"
          onClick={onToggleFolded}
          title="Show the session list"
          aria-label="Show the session list"
        >
          ›
          {unreadCounts.size > 0 && <span className="fold-strip-dot" />}
        </button>
      </aside>
    );
  }

  const hasManager = instances.some((i) => i.isManager);

  // Stored order, except the manager is pinned to the top — see pinManagerFirst.
  // Status changes still never reorder anything: online vs offline is the avatar's
  // job, not position's.
  const ordered = pinManagerFirst(instances);

  const handleContextMenu = (e: React.MouseEvent, instanceId: string) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, instanceId });
  };

  const contextInstance = contextMenu
    ? instances.find((i) => i.id === contextMenu.instanceId)
    : null;
  const renameInstance = renameId
    ? instances.find((i) => i.id === renameId)
    : null;

  return (
    <aside className="sidebar">
      <button
        type="button"
        className="fold-tab"
        data-edge="sidebar"
        onClick={onToggleFolded}
        title="Hide the session list"
        aria-label="Hide the session list"
      >
        ‹
      </button>
      {/* A scrolled row leaves its bubble behind, so scrolling drops it. */}
      <div className="contact-list" onScroll={() => setNameTip(null)}>
        {ordered.length === 0 ? (
          <div className="sidebar-placeholder">No instances</div>
        ) : (
          ordered.map((inst) => (
            <div
              key={inst.id}
              className={`contact-item ${selectedId === inst.id ? "selected" : ""} ${inst.status === "stopped" ? "stopped" : ""} ${unreadCounts.has(inst.id) ? "unread" : ""} ${inst.isManager ? "manager" : ""}`}
              onClick={() => onSelect(inst.id)}
              onContextMenu={(e) => handleContextMenu(e, inst.id)}
              onMouseEnter={(e) => {
                const name =
                  e.currentTarget.querySelector<HTMLElement>(".contact-name");
                // Only a name the sidebar cuts short gets a bubble. Measured here,
                // because CSS can't tell whether the ellipsis is showing.
                if (!name || name.scrollWidth <= name.clientWidth) return;
                const row = e.currentTarget.getBoundingClientRect();
                setNameTip({
                  text: inst.name,
                  left: row.right,
                  top: row.top + row.height / 2,
                });
              }}
              onMouseLeave={() => setNameTip(null)}
              // The manager is pinned, so it can't be dragged out of first place.
              draggable={!inst.isManager}
              data-dragging={dragId === inst.id ? "true" : undefined}
              data-drop={
                drop?.id === inst.id ? (drop.before ? "before" : "after") : undefined
              }
              onDragStart={(e) => {
                setNameTip(null);
                setDragId(inst.id);
                e.dataTransfer.effectAllowed = "move";
                // Some data is required or Firefox-style browsers cancel the drag;
                // harmless in Electron and it makes the payload self-describing.
                e.dataTransfer.setData("text/plain", inst.id);
              }}
              onDragOver={(e) => {
                if (!dragId || dragId === inst.id) return;
                // Without preventDefault the drop event never fires at all.
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                // Nothing lands above the manager: dropping on its top half means
                // "first among the projects", i.e. straight after it.
                const before = inst.isManager
                  ? false
                  : dropsBefore(
                      e.clientY,
                      e.currentTarget.getBoundingClientRect()
                    );
                setDrop((prev) =>
                  prev?.id === inst.id && prev.before === before
                    ? prev
                    : { id: inst.id, before }
                );
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (!dragId || !drop) return endDrag();
                // Only the intent goes across. The main process applies it to the
                // order it actually has stored — see moveInstance.
                onMove(dragId, drop.id, drop.before);
                endDrag();
              }}
              onDragEnd={endDrag}
            >
              <Avatar
                backend={inst.backend}
                online={inst.status === "running"}
                working={inst.working}
                alert={unreadCounts.has(inst.id)}
              />
              <span className="contact-name">{inst.name}</span>
              {showHotkeys && hotkeyIds.includes(inst.id) && (
                <span className="contact-hotkey">
                  {hotkeyIds.indexOf(inst.id) + 1}
                </span>
              )}
              {inst.contextUsage && (
                <span
                  className="contact-context"
                  title={contextTitle(inst.contextUsage)}
                  // Only present when the window size is known, so the row can be
                  // tinted by fullness without pretending to know it otherwise.
                  data-fill={fillBand(inst.contextUsage)}
                  style={
                    {
                      "--fill-hue": contextFillHue(
                        inst.contextUsage.inputTokens,
                        inst.contextUsage.contextWindow
                      ),
                    } as React.CSSProperties
                  }
                >
                  {contextLabel(inst.contextUsage)}
                </span>
              )}
              {unreadCounts.has(inst.id) && (
                <span className="unread-badge">
                  {formatUnread(unreadCounts.get(inst.id) ?? 0)}
                </span>
              )}
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

      {nameTip && (
        <div
          className="name-tip"
          style={{ left: nameTip.left, top: nameTip.top }}
          aria-hidden="true"
        >
          {nameTip.text}
        </div>
      )}

      {contextMenu && contextInstance && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(null)}
          items={[
            {
              label: "Rename…",
              onClick: () => setRenameId(contextMenu.instanceId),
            },
            // The manager is a singleton, so it has no Duplicate.
            ...(contextInstance.isManager
              ? []
              : [
                  {
                    label: "Duplicate",
                    onClick: () => onDuplicate(contextMenu.instanceId),
                  },
                ]),
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

      {/* Mounted only while open, so each opening starts from the current name. */}
      {renameInstance && (
        <RenameSessionDialog
          open
          title="Rename"
          label="Name in the session list (blank uses the folder name)"
          initialName={renameInstance.alias ?? ""}
          placeholder={renameInstance.cwd.split("/").pop() || ""}
          allowBlank
          onClose={() => setRenameId(null)}
          onSubmit={(name) => {
            onRename(renameInstance.id, name);
            setRenameId(null);
          }}
        />
      )}
    </aside>
  );
}
