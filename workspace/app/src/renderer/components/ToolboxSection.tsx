import type { ReactNode } from "react";

interface ToolboxSectionProps {
  id: string;
  title: string;
  expanded: boolean;
  onToggle: (id: string) => void;
  children?: ReactNode;
}

export function ToolboxSection({
  id,
  title,
  expanded,
  onToggle,
  children,
}: ToolboxSectionProps) {
  return (
    <div className={`toolbox-section${expanded ? " expanded" : ""}`}>
      <button
        type="button"
        className="toolbox-section-header"
        onClick={() => onToggle(id)}
      >
        <span className="toolbox-section-chevron">{expanded ? "▾" : "▸"}</span>
        <span className="toolbox-section-title">{title}</span>
      </button>
      {expanded && <div className="toolbox-section-body">{children}</div>}
    </div>
  );
}
