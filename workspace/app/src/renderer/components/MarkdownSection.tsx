import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Instance, ReadFileResult } from "../../shared/types";
import { shouldOpenExternally } from "./markdownLinks";

interface MarkdownSectionProps {
  instance: Instance;
  active: boolean;
  openPath: string;
  onOpenPath: (path: string) => void;
}

// Route markdown links through the OS browser instead of navigating (or
// spawning a window in) the renderer. Only web/mail schemes are opened; other
// links (relative paths, anchors) are intercepted and left inert.
function handleLinkClick(
  e: React.MouseEvent<HTMLAnchorElement>,
  href: string | undefined
) {
  e.preventDefault();
  if (shouldOpenExternally(href)) window.electronAPI.openExternal(href as string);
}

export function MarkdownSection({
  instance,
  active,
  openPath,
  onOpenPath,
}: MarkdownSectionProps) {
  const [draft, setDraft] = useState(openPath);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [result, setResult] = useState<ReadFileResult | null>(null);
  const [loading, setLoading] = useState(false);

  // Keep the input in sync with the incoming path so switching instances shows
  // that instance's stored path.
  useEffect(() => {
    setDraft(openPath);
  }, [openPath]);

  // Read + render whenever the target (instance or path) changes, or Refresh is
  // clicked. Guard against a stale response overwriting a newer request.
  useEffect(() => {
    if (!openPath) {
      setResult(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    window.electronAPI.readFile(instance.id, openPath).then((r) => {
      if (cancelled) return;
      setResult(r);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [instance.id, openPath, refreshNonce]);

  if (!active) return null;

  const submit = () => onOpenPath(draft.trim());
  const refresh = () => {
    const trimmed = draft.trim();
    if (trimmed !== openPath) onOpenPath(trimmed);
    else setRefreshNonce((n) => n + 1);
  };

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
        <button type="button" className="markdown-refresh-btn" onClick={refresh}>
          Refresh
        </button>
      </div>
      {openPath && (
        <div className="markdown-body">
          {loading && (
            <span className="markdown-section-placeholder">Loading…</span>
          )}
          {!loading && result?.ok && (
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                // Drop react-markdown's internal `node` prop so it doesn't
                // leak onto the real DOM anchor; route clicks externally.
                a: ({ href, children, node: _node, ...props }) => (
                  <a
                    {...props}
                    href={href}
                    onClick={(e) => handleLinkClick(e, href)}
                  >
                    {children}
                  </a>
                ),
              }}
            >
              {result.content}
            </ReactMarkdown>
          )}
          {!loading && result && !result.ok && (
            <span className="markdown-section-placeholder">
              Could not open: {result.path}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
