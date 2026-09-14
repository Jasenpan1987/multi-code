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

// The manager is always this colour rather than one hashed from its name: there is
// only ever one, and it should be recognisable at a glance instead of blending in
// with whatever colour its name happened to land on. Matches the QQ chrome blue.
const MANAGER_COLOR = "#2d5a8a";

interface AvatarProps {
  name: string;
  online: boolean;
  blink?: boolean;
  backend: BackendName;
  isManager?: boolean;
}

export function Avatar({ name, online, blink, backend, isManager }: AvatarProps) {
  const initials = getInitials(name);
  const bgColor = !online ? "#999" : isManager ? MANAGER_COLOR : getColor(name);
  const shape = backend === "opencode" ? "square" : "circle";

  return (
    <div
      className={`avatar avatar-${shape} ${isManager ? "avatar-manager" : ""} ${blink ? "blink" : ""}`}
      style={{ backgroundColor: bgColor }}
    >
      <span className="avatar-initials">{initials}</span>
    </div>
  );
}
