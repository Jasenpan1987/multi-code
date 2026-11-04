import { describe, it, expect } from "vitest";
import { resolveImageSrc } from "./markdownImages";

const MD = "/Users/me/project/docs/readme.md";

describe("resolveImageSrc", () => {
  it("leaves remote and data URLs untouched", () => {
    expect(resolveImageSrc("https://example.com/a.png", MD)).toBe(
      "https://example.com/a.png"
    );
    expect(resolveImageSrc("http://example.com/a.png", MD)).toBe(
      "http://example.com/a.png"
    );
    expect(resolveImageSrc("data:image/png;base64,AAAA", MD)).toBe(
      "data:image/png;base64,AAAA"
    );
  });

  it("rewrites a relative local src to mdimg:// carrying the file's dir", () => {
    const out = resolveImageSrc("./img/diagram.png", MD);
    expect(out).not.toBeNull();
    const url = new URL(out as string);
    expect(url.protocol).toBe("mdimg:");
    expect(url.searchParams.get("base")).toBe("/Users/me/project/docs");
    expect(url.searchParams.get("src")).toBe("./img/diagram.png");
  });

  it("rewrites an absolute local src too (main side sandboxes it)", () => {
    const out = resolveImageSrc("/etc/x.png", MD);
    const url = new URL(out as string);
    expect(url.searchParams.get("base")).toBe("/Users/me/project/docs");
    expect(url.searchParams.get("src")).toBe("/etc/x.png");
  });

  it("returns null for empty or protocol-relative srcs", () => {
    expect(resolveImageSrc("", MD)).toBeNull();
    expect(resolveImageSrc(undefined, MD)).toBeNull();
    expect(resolveImageSrc("//cdn.example.com/a.png", MD)).toBeNull();
  });

  it("encodes special characters in the src param", () => {
    const out = resolveImageSrc("./a b&c.png", MD);
    const url = new URL(out as string);
    // Round-trips through URLSearchParams — decoded value is the original.
    expect(url.searchParams.get("src")).toBe("./a b&c.png");
  });
});
