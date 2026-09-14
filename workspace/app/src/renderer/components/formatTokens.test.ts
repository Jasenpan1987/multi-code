import { describe, expect, it } from "vitest";
import { formatTokens } from "./formatTokens";

describe("formatTokens", () => {
  it("shows small counts exactly", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(1)).toBe("1");
    expect(formatTokens(999)).toBe("999");
  });

  it("keeps one decimal below 10k, where the tenth matters", () => {
    expect(formatTokens(1000)).toBe("1k");
    expect(formatTokens(1500)).toBe("1.5k");
    expect(formatTokens(9949)).toBe("9.9k");
  });

  it("drops a trailing .0", () => {
    expect(formatTokens(2000)).toBe("2k");
    expect(formatTokens(9000)).toBe("9k");
  });

  it("rounds to whole k from 10k up", () => {
    expect(formatTokens(10_000)).toBe("10k");
    expect(formatTokens(17_600)).toBe("18k");
    expect(formatTokens(452_559)).toBe("453k");
    expect(formatTokens(999_499)).toBe("999k");
  });

  it("switches to M at a million", () => {
    expect(formatTokens(1_000_000)).toBe("1M");
    expect(formatTokens(1_050_000)).toBe("1.05M");
    expect(formatTokens(1_234_567)).toBe("1.23M");
  });

  it("returns empty for values that aren't a usable count", () => {
    // The reader never produces these, but the field crosses an IPC boundary and
    // a NaN rendered as "NaNk" would be worse than an empty cell.
    expect(formatTokens(-1)).toBe("");
    expect(formatTokens(NaN)).toBe("");
    expect(formatTokens(Infinity)).toBe("");
  });
});
