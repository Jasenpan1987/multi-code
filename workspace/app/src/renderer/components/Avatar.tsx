const COLORS = [
  "#4a90d9",
  "#e57373",
  "#81c784",
  "#ffb74d",
  "#ba68c8",
  "#4dd0e1",
  "#a1887f",
  "#7986cb",
  "#f06292",
  "#aed581",
];

function getInitials(name: string): string {
  const parts = name.split(/[-_\s]+/);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return name.slice(0, 2).toUpperCase();
}

function getColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return COLORS[Math.abs(hash) % COLORS.length];
}

import type { BackendName } from "../../shared/types";

interface AvatarProps {
  name: string;
  online: boolean;
  blink?: boolean;
  backend: BackendName;
}

export function Avatar({ name, online, blink, backend }: AvatarProps) {
  const initials = getInitials(name);
  const bgColor = online ? getColor(name) : "#999";
  const shape = backend === "opencode" ? "square" : "circle";

  return (
    <div
      className={`avatar avatar-${shape} ${blink ? "blink" : ""}`}
      style={{ backgroundColor: bgColor }}
    >
      <span className="avatar-initials">{initials}</span>
    </div>
  );
}
