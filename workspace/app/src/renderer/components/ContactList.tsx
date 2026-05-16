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

  // Sort: running first, then by most recent startedAt
  const sorted = [...instances].sort((a, b) => {
    if (a.status === "running" && b.status !== "running") return -1;
    if (a.status !== "running" && b.status === "running") return 1;
    return b.startedAt - a.startedAt;
  });

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
        {sorted.length === 0 ? (
          <div className="sidebar-placeholder">No instances</div>
        ) : (
          sorted.map((inst) => (
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
