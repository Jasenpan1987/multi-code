import { useEffect, useState } from "react";

// Small version label in the top-right of the window (next to the theme
// toggle), so you can tell at a glance which build is running. Sourced from
// the main process's app.getVersion().
export function VersionBadge() {
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    window.electronAPI.getAppVersion().then(setVersion);
  }, []);

  if (!version) return null;

  return (
    <span className="version-badge" title={`Multi-Code v${version}`}>
      v{version}
    </span>
  );
}
