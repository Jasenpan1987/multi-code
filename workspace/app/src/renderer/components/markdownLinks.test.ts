import { describe, it, expect } from "vitest";
import { shouldOpenExternally } from "./markdownLinks";

describe("shouldOpenExternally", () => {
  it("opens http and https links", () => {
    expect(shouldOpenExternally("http://example.com")).toBe(true);
    expect(shouldOpenExternally("https://example.com/path")).toBe(true);
  });

  it("opens mailto links", () => {
    expect(shouldOpenExternally("mailto:someone@example.com")).toBe(true);
  });

  it("leaves relative paths inert", () => {
    expect(shouldOpenExternally("./other.md")).toBe(false);
    expect(shouldOpenExternally("../notes/todo.md")).toBe(false);
    expect(shouldOpenExternally("some/file.md")).toBe(false);
  });

  it("leaves bare anchors inert", () => {
    expect(shouldOpenExternally("#section")).toBe(false);
  });

  it("does not open exotic or dangerous schemes", () => {
    expect(shouldOpenExternally("file:///etc/passwd")).toBe(false);
    expect(shouldOpenExternally("javascript:alert(1)")).toBe(false);
    expect(shouldOpenExternally("vscode://foo")).toBe(false);
  });

  it("handles empty and undefined href", () => {
    expect(shouldOpenExternally(undefined)).toBe(false);
    expect(shouldOpenExternally("")).toBe(false);
  });
});
