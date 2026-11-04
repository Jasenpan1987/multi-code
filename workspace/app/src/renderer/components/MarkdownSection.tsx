import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import type { Instance, ReadFileResult } from "../../shared/types";
import { shouldOpenExternally } from "./markdownLinks";
import { readFileErrorMessage } from "./markdownErrors";
import { resolveImageSrc } from "./markdownImages";
import { MermaidBlock } from "./MermaidBlock";
import { extractMermaid } from "./mermaidExtract";

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
      <div className="markdown-body">
        {!openPath && (
          <span className="markdown-section-placeholder">
            Paste a .md path above and press Enter.
          </span>
        )}
        {openPath && loading && (
          <span className="markdown-section-placeholder">Loading…</span>
        )}
        {openPath && !loading && result?.ok && (
          <ReactMarkdown
            remarkPlugins={[remarkGfm, remarkMath]}
            rehypePlugins={[rehypeKatex]}
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
              // Local images load through the mdimg:// protocol (resolved
              // against the open file's directory in the main process); remote
              // images pass through untouched. An empty/unresolvable src drops
              // to just alt text.
              img: ({ src, alt, node: _node, ...props }) => {
                const resolved = resolveImageSrc(
                  typeof src === "string" ? src : undefined,
                  result.path
                );
                if (!resolved) return <span>{alt ?? ""}</span>;
                return <img {...props} src={resolved} alt={alt ?? ""} />;
              },
              // Route fenced ```mermaid``` blocks to the diagram renderer.
              // A fenced block is a <pre> wrapping a <code class="language-x">;
              // detect mermaid on that inner code and render the diagram in
              // place of the <pre> (a <div> can't live inside <pre>). Every
              // other <pre> passes through unchanged.
              pre: ({ children, node: _node, ...props }) => {
                const mermaid = extractMermaid(children);
                if (mermaid !== null) return <MermaidBlock code={mermaid} />;
                return <pre {...props}>{children}</pre>;
              },
            }}
          >
            {result.content}
          </ReactMarkdown>
        )}
        {openPath && !loading && result && !result.ok && (
          <span className="markdown-section-placeholder">
            {readFileErrorMessage(result.error, result.path)}
          </span>
        )}
      </div>
    </div>
  );
}
