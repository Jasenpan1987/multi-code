import { useEffect, useState } from "react";
import type { Instance } from "../../shared/types";

interface MarkdownSectionProps {
  instance: Instance;
  active: boolean;
  openPath: string;
  onOpenPath: (path: string) => void;
}

export function MarkdownSection({
  active,
  openPath,
  onOpenPath,
}: MarkdownSectionProps) {
  const [draft, setDraft] = useState(openPath);

  // Keep the input in sync with the incoming path so switching instances shows
  // that instance's stored path.
  useEffect(() => {
    setDraft(openPath);
  }, [openPath]);

  if (!active) return null;

  const submit = () => onOpenPath(draft.trim());

  return (
    <div className="markdown-section">
      <div className="markdown-section-bar">
        <input
          type="text"
          className="markdown-path-input"
          placeholder="Paste a .md path, Enter to open"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
        />
        <button type="button" className="markdown-refresh-btn" onClick={submit}>
          Refresh
        </button>
      </div>
      {openPath && (
        <div className="markdown-body">
          <span className="markdown-section-placeholder">
            Rendering coming soon
          </span>
        </div>
      )}
    </div>
  );
}
