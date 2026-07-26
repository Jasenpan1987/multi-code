import { beforeEach, describe, expect, it } from "vitest";
import { outputBuffer } from "./output-buffer";

describe("outputBuffer", () => {
  beforeEach(() => {
    outputBuffer.clear("a");
    outputBuffer.clear("b");
  });

  it("returns an empty snapshot for an unknown instance", () => {
    expect(outputBuffer.snapshot("nope")).toBe("");
  });

  it("concatenates chunks in order", () => {
    outputBuffer.append("a", "hello ");
    outputBuffer.append("a", "world");
    expect(outputBuffer.snapshot("a")).toBe("hello world");
  });

  it("keeps instances separate", () => {
    outputBuffer.append("a", "first");
    outputBuffer.append("b", "second");
    expect(outputBuffer.snapshot("a")).toBe("first");
    expect(outputBuffer.snapshot("b")).toBe("second");
  });

  it("drops oldest chunks once past the cap, keeping the tail", () => {
    // 4 chunks of 100 KB each: the cap is 256 KB, so the oldest must go and the
    // most recent output — what the user actually needs to see — must survive.
    const chunk = "x".repeat(100 * 1024);
    outputBuffer.append("a", chunk + "1");
    outputBuffer.append("a", chunk + "2");
    outputBuffer.append("a", chunk + "3");
    outputBuffer.append("a", "tail-marker");

    const snapshot = outputBuffer.snapshot("a");
    expect(snapshot.endsWith("tail-marker")).toBe(true);
    expect(snapshot.length).toBeLessThanOrEqual(256 * 1024 + "tail-marker".length);
  });

  it("never drops the only chunk, even when it alone exceeds the cap", () => {
    // A single huge write has to stay: dropping it would leave the phone with a
    // blank screen and no way to recover until the next repaint.
    const huge = "y".repeat(300 * 1024);
    outputBuffer.append("a", huge);
    expect(outputBuffer.snapshot("a")).toBe(huge);
  });

  it("clear removes the buffer", () => {
    outputBuffer.append("a", "data");
    outputBuffer.clear("a");
    expect(outputBuffer.snapshot("a")).toBe("");
  });
});
