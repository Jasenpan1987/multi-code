import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { extractMermaid } from "./mermaidExtract";

// A fenced block reaches `pre` as a <code class="language-x"> element; build
// those elements the same way react-markdown would.
function codeEl(className: string | undefined, text: string) {
  return createElement("code", { className }, text);
}

describe("extractMermaid", () => {
  it("returns the source for a language-mermaid code element", () => {
    expect(extractMermaid(codeEl("language-mermaid", "graph TD\nA-->B\n"))).toBe(
      "graph TD\nA-->B"
    );
  });

  it("trims exactly one trailing newline", () => {
    expect(extractMermaid(codeEl("language-mermaid", "graph TD\n"))).toBe(
      "graph TD"
    );
  });

  it("returns null for a non-mermaid fenced block", () => {
    expect(extractMermaid(codeEl("language-js", "const x = 1;\n"))).toBeNull();
  });

  it("returns null for a code element with no language class", () => {
    expect(extractMermaid(codeEl(undefined, "plain"))).toBeNull();
  });

  it("returns null when children is plain text, not an element", () => {
    expect(extractMermaid("just a string")).toBeNull();
  });

  it("does not match a language that merely contains 'mermaid' as a substring", () => {
    expect(extractMermaid(codeEl("language-mermaidx", "nope"))).toBeNull();
  });
});
