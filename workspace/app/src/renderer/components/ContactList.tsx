import { useState } from "react";
import { ContextMenu } from "./ContextMenu";
import { Avatar } from "./Avatar";
import type { Instance } from "../../shared/types";

interface ContactListProps {
  instances: Instance[];
  selectedId: string | null;
  unreadIds: Set<string>;
  onSelect: (id: string) => void;
  onNew: () => void;
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
  const ordered = instances;

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
              className={`contact-item ${selectedId === inst.id ? "selected" : ""} ${inst.status === "stopped" ? "stopped" : ""} ${unreadIds.has(inst.id) ? "unread" : ""}`}
              onClick={() => onSelect(inst.id)}
              onContextMenu={(e) => handleContextMenu(e, inst.id)}
            >
              <Avatar
                name={inst.name}
                online={inst.status === "running"}
                blink={unreadIds.has(inst.id)}
                backend={inst.backend}
              />
              <span className="contact-name">{inst.name}</span>
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
      <button className="new-instance-btn-bottom" onClick={onNew}>
        + New
      </button>

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
