import { useEffect, useState } from "react";
import mermaid from "mermaid";

// Initialize mermaid exactly once for the whole renderer. `startOnLoad: false`
// keeps it from scanning the DOM on its own — we drive every render explicitly
// via mermaid.render().
let initialized = false;
function ensureInitialized() {
  if (initialized) return;
  mermaid.initialize({ startOnLoad: false });
  initialized = true;
}

// Monotonic id so each rendered diagram gets a DOM id mermaid can key its
// internal <style> off without colliding with another block on the page.
let seq = 0;

interface MermaidBlockProps {
  code: string;
}

// Render a ```mermaid``` block to an SVG. On any render failure (bad syntax,
// runtime error) fall back to showing the raw source as a plain code block —
// a broken diagram must never take down the surrounding document.
export function MermaidBlock({ code }: MermaidBlockProps) {
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    ensureInitialized();
    let cancelled = false;
    setSvg(null);
    setFailed(false);
    seq += 1;
    const id = `mermaid-${seq}`;
    mermaid
      .render(id, code)
      .then(({ svg }) => {
        // Guard against a stale render landing after the code changed (e.g. the
        // user opened a different .md) — otherwise an old diagram would flash in.
        if (!cancelled) setSvg(svg);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [code]);

  if (failed) {
    return (
      <div className="mermaid-block mermaid-block-failed">
        <span className="markdown-section-placeholder">
          ⚠ Diagram failed to render — showing source:
        </span>
        <pre>
          <code>{code}</code>
        </pre>
      </div>
    );
  }

  if (svg === null) {
    return (
      <div className="mermaid-block">
        <span className="markdown-section-placeholder">Rendering diagram…</span>
      </div>
    );
  }

  // svg is produced by mermaid from the document's own source (already treated
  // as untrusted content in this read-only viewer); render it inline.
  return (
    <div
      className="mermaid-block"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
