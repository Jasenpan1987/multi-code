import { useEffect, useRef } from "react";

interface ContextMenuProps {
  x: number;
  y: number;
  items: { label: string; onClick: () => void; disabled?: boolean }[];
  onClose: () => void;
}

export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [onClose]);

  return (
    <div ref={menuRef} className="context-menu" style={{ top: y, left: x }}>
      {items.map((item) => (
        <div
          key={item.label}
          className={`context-menu-item ${item.disabled ? "disabled" : ""}`}
          onClick={() => {
            if (!item.disabled) {
              item.onClick();
              onClose();
            }
          }}
        >
          {item.label}
        </div>
      ))}
    </div>
  );
}
