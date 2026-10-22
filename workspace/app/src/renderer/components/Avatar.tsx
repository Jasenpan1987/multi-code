import type { BackendName } from "../../shared/types";

// Each backend's own mascot, drawn from its maker's art rather than shipped as
// images, so the parts can move: Claude Code's Clawd (the VS Code extension's
// clawd.svg, 11 × 4 pixels, each twice as tall as wide) and OpenCode's mark (its VS
// Code extension's button-light.svg on a 64-unit grid, cropped to the O). No tile
// behind either. The states are CSS on `.avatar`: grey while stopped, still while
// idle, moving while it works, shaking while it has unread alerts.

function Clawd() {
  return (
    <svg
      className="mascot"
      viewBox="0 0 11 8"
      width="33"
      height="24"
      fill="#d97757"
      shapeRendering="crispEdges"
      aria-hidden="true"
    >
      <rect className="clawd-arm" x="0" y="2" width="1" height="2" />
      <rect className="clawd-arm clawd-alt" x="10" y="2" width="1" height="2" />
      <rect x="1" y="0" width="9" height="6" />
      {/* Every other leg steps together: the first of each side, then the second. */}
      <rect className="clawd-leg" x="1" y="6" width="1" height="2" />
      <rect className="clawd-leg clawd-alt" x="3" y="6" width="1" height="2" />
      <rect className="clawd-leg" x="7" y="6" width="1" height="2" />
      <rect className="clawd-leg clawd-alt" x="9" y="6" width="1" height="2" />
      <rect x="2" y="2" width="1" height="1" fill="#1a1a1a" />
      <rect x="8" y="2" width="1" height="1" fill="#1a1a1a" />
    </svg>
  );
}

function OpenCodeMark() {
  return (
    <svg
      className="mascot"
      viewBox="2 1.5 4 5"
      width="24"
      height="30"
      shapeRendering="crispEdges"
      aria-hidden="true"
    >
      <path
        fillRule="evenodd"
        d="M2 1.5H6V6.5H2ZM3 2.5V5.5H5V2.5Z"
        fill="#17181c"
      />
      <rect className="opencode-block" x="3" y="3.5" width="2" height="2" fill="#9a9aa0" />
    </svg>
  );
}

interface AvatarProps {
  backend: BackendName;
  online: boolean;
  // A turn is running (Instance.working).
  working?: boolean;
  // Unread alerts: a finished turn or a dialog nobody has looked at.
  alert?: boolean;
}

export function Avatar({ backend, online, working, alert }: AvatarProps) {
  const classes = [
    "avatar",
    !online && "offline",
    online && working && "working",
    alert && "alert",
  ];
  return (
    <div className={classes.filter(Boolean).join(" ")}>
      {backend === "opencode" ? <OpenCodeMark /> : <Clawd />}
    </div>
  );
}
