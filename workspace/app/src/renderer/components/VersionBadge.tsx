import { useEffect, useState } from "react";

interface VersionBadgeProps {
  // Dev runs get an extra marker. Passed in rather than fetched here so App can
  // tint the titlebar with the same answer.
  dev: boolean;
}

// Small version label in the top-right of the window (next to the theme
// toggle), so you can tell at a glance which build is running. Sourced from
// the main process's app.getVersion().
export function VersionBadge({ dev }: VersionBadgeProps) {
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    window.electronAPI.getAppVersion().then(setVersion);
  }, []);

  if (!version) return null;

  return (
    <span
      className="version-badge"
      data-dev={dev ? "true" : undefined}
      title={
        dev
          ? `Multi-Code v${version} — dev build (localhost), separate data directory from the installed app`
          : `Multi-Code v${version}`
      }
    >
      {dev && <span className="version-badge-dev">DEV</span>}v{version}
    </span>
  );
}
