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

interface AvatarProps {
  name: string;
  online: boolean;
  blink?: boolean;
}

export function Avatar({ name, online, blink }: AvatarProps) {
  const initials = getInitials(name);
  const bgColor = online ? getColor(name) : "#999";

  return (
    <div
      className={`avatar ${blink ? "blink" : ""}`}
      style={{ backgroundColor: bgColor }}
    >
      <span className="avatar-initials">{initials}</span>
    </div>
  );
}
