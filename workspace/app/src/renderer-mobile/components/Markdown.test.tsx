// The agent's text is untrusted on a phone that holds a device token: no raw HTML,
// no script or data links, no remote images (components/Markdown.tsx).

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown } from "./Markdown";

const html = (text: string) => renderToStaticMarkup(<Markdown text={text} />);

describe("Markdown", () => {
  it("escapes raw HTML instead of rendering it", () => {
    const out = html('<img src=x onerror="alert(1)"><script>alert(2)</script>');
    expect(out).not.toContain("<img");
    expect(out).not.toContain("<script");
  });

  it("keeps only web and mail links as links, opened apart from the app", () => {
    const out = html("[a](javascript:alert(1)) [b](data:text/html,x) [c](/etc/passwd) [d](https://example.com)");
    expect(out).not.toMatch(/href="(javascript|data):/);
    expect(out).not.toContain('href="/etc/passwd"');
    expect(out).toContain('<a href="https://example.com" target="_blank" rel="noopener noreferrer">d</a>');
  });

  it("shows an image as its alt text, never loading it", () => {
    const out = html("![the chart](https://tracker.example/pixel.png)");
    expect(out).not.toContain("<img");
    expect(out).toContain("[the chart]");
  });
});
