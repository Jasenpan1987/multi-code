import { describe, it, expect, vi } from "vitest";
import { buildComposePayload, sendComposed } from "./composeSend";

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

describe("buildComposePayload", () => {
  it("returns plain text when there are no image refs", () => {
    expect(buildComposePayload("hello world")).toBe("hello world");
  });

  it("appends image refs as @<path> tokens after the text", () => {
    expect(buildComposePayload("look at this", ["/tmp/a.png"])).toBe(
      "look at this @/tmp/a.png"
    );
  });

  it("joins multiple image refs with spaces", () => {
    expect(
      buildComposePayload("two", ["/tmp/a.png", "/tmp/b.png"])
    ).toBe("two @/tmp/a.png @/tmp/b.png");
  });

  it("emits only the refs when there is no text (image-only draft)", () => {
    expect(buildComposePayload("", ["/tmp/a.png"])).toBe("@/tmp/a.png");
  });
});

describe("sendComposed", () => {
  it("emits exactly two writes: bracketed payload then a separate \\r", () => {
    const write = vi.fn();
    const text = "line1\nline2\nline3";
    sendComposed("inst-1", text, [], write);

    expect(write).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenNthCalledWith(
      1,
      "inst-1",
      `${PASTE_START}${text}${PASTE_END}`
    );
    expect(write).toHaveBeenNthCalledWith(2, "inst-1", "\r");
  });

  it("never puts \\r inside the bracketed-paste markers", () => {
    const write = vi.fn();
    sendComposed("inst-1", "line1\nline2\nline3", [], write);

    const firstPayload = write.mock.calls[0][1] as string;
    expect(firstPayload).not.toContain("\r");
    // Newlines inside the payload are preserved as \n.
    expect(firstPayload).toContain("\n");
  });

  it("splices image refs into the payload on send", () => {
    const write = vi.fn();
    sendComposed("inst-1", "what color", ["/tmp/probe.png"], write);

    expect(write).toHaveBeenNthCalledWith(
      1,
      "inst-1",
      `${PASTE_START}what color @/tmp/probe.png${PASTE_END}`
    );
    expect(write).toHaveBeenNthCalledWith(2, "inst-1", "\r");
  });
});
