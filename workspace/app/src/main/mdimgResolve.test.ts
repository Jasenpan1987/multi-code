import { describe, it, expect } from "vitest";
import { resolveMdimgRequest, isInside } from "./mdimgResolve";

// Build an mdimg:// URL the way the renderer does.
function url(base: string, src: string): string {
  const params = new URLSearchParams({ base, src });
  return `mdimg://img/?${params.toString()}`;
}

const BASE = "/Users/me/project/docs";

describe("resolveMdimgRequest", () => {
  it("resolves a relative src inside the base dir", () => {
    expect(resolveMdimgRequest(url(BASE, "./img/a.png"))).toBe(
      "/Users/me/project/docs/img/a.png"
    );
    expect(resolveMdimgRequest(url(BASE, "b.jpeg"))).toBe(
      "/Users/me/project/docs/b.jpeg"
    );
  });

  it("resolves a nested subdirectory image", () => {
    expect(resolveMdimgRequest(url(BASE, "a/b/c/deep.gif"))).toBe(
      "/Users/me/project/docs/a/b/c/deep.gif"
    );
  });

  it("refuses path traversal escaping the base dir", () => {
    expect(resolveMdimgRequest(url(BASE, "../../../../etc/passwd.png"))).toBeNull();
    expect(resolveMdimgRequest(url(BASE, "../secret.png"))).toBeNull();
    expect(resolveMdimgRequest(url(BASE, "./sub/../../out.png"))).toBeNull();
  });

  it("refuses an absolute src outside the base dir", () => {
    expect(resolveMdimgRequest(url(BASE, "/etc/passwd.png"))).toBeNull();
  });

  it("allows an absolute src that happens to be inside the base dir", () => {
    expect(
      resolveMdimgRequest(url(BASE, "/Users/me/project/docs/in.png"))
    ).toBe("/Users/me/project/docs/in.png");
  });

  it("refuses non-image extensions (incl. svg) inside the base dir", () => {
    expect(resolveMdimgRequest(url(BASE, "./notes.md"))).toBeNull();
    expect(resolveMdimgRequest(url(BASE, "./data.json"))).toBeNull();
    expect(resolveMdimgRequest(url(BASE, "./diagram.svg"))).toBeNull();
    expect(resolveMdimgRequest(url(BASE, "./noext"))).toBeNull();
  });

  it("refuses srcs carrying a URI scheme", () => {
    expect(resolveMdimgRequest(url(BASE, "https://evil.com/a.png"))).toBeNull();
    expect(resolveMdimgRequest(url(BASE, "file:///etc/x.png"))).toBeNull();
  });

  it("refuses when base or src is missing", () => {
    expect(resolveMdimgRequest("mdimg://img/?src=./a.png")).toBeNull();
    expect(resolveMdimgRequest(`mdimg://img/?base=${encodeURIComponent(BASE)}`)).toBeNull();
    expect(resolveMdimgRequest("mdimg://img/")).toBeNull();
  });

  it("is case-insensitive on the extension", () => {
    expect(resolveMdimgRequest(url(BASE, "./A.PNG"))).toBe(
      "/Users/me/project/docs/A.PNG"
    );
  });
});

describe("isInside", () => {
  it("treats a dir as inside itself", () => {
    expect(isInside("/a/b", "/a/b")).toBe(true);
  });

  it("treats nested paths as inside", () => {
    expect(isInside("/a/b", "/a/b/c/d.png")).toBe(true);
  });

  it("does not treat a sibling prefix as inside", () => {
    // /a/foobar must NOT count as inside /a/foo
    expect(isInside("/a/foo", "/a/foobar")).toBe(false);
  });

  it("does not treat a parent as inside", () => {
    expect(isInside("/a/b", "/a")).toBe(false);
  });
});
