import { isValidElement, type ReactNode } from "react";

// A fenced code block reaches the `pre` component as a single <code> element
// child carrying `className="language-xxx"` and the raw source as its text
// children. If that block is a mermaid block, return its source (trailing
// newline trimmed); otherwise return null so the <pre> renders normally.
export function extractMermaid(children: ReactNode): string | null {
  if (!isValidElement(children)) return null;
  const props = children.props as {
    className?: string;
    children?: ReactNode;
  };
  if (!/\blanguage-mermaid\b/.test(props.className ?? "")) return null;
  return String(props.children ?? "").replace(/\n$/, "");
}
