// The agent's text as Markdown (PRD Story 3: headings, lists, code, tables), with
// GitHub's tables and task lists. Memoised on the text: a transcript refresh
// replaces every entry object, but an entry's text rarely changes, and parsing is
// the expensive part.

import { memo, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import "./markdown.css";

const PLUGINS = [remarkGfm];

// Only a web or mail link leaves the app, in Safari: anything else an agent writes
// as a link (a file path, an anchor) would navigate the app itself away.
const external = (href: string | undefined) => !!href && /^(https?:|mailto:)/i.test(href);

const COMPONENTS: Components = {
  a: ({ href, children }) =>
    external(href) ? (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    ) : (
      <span className="md-link">{children}</span>
    ),
  // The page's CSP loads no image from elsewhere, and a path on the Mac isn't
  // reachable: say what the image was.
  img: ({ alt }) => <span className="md-img">[{alt || "image"}]</span>,
  // Wide tables scroll sideways on their own instead of widening the chat.
  table: ({ children }) => (
    <div className="md-table">
      <table>{children}</table>
    </div>
  ),
};

export const Markdown = memo(function Markdown({ text, className }: { text: string; className?: string }): ReactNode {
  return (
    <div className={className ? `md ${className}` : "md"}>
      <ReactMarkdown remarkPlugins={PLUGINS} components={COMPONENTS}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
