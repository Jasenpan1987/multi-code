import { describe, expect, it } from "vitest";
import { formatContextPercent, formatTokens } from "./formatTokens";

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

// The percentage is only ever shown when the denominator is real. Everything below
// that returns "" is a case where the UI must fall back to the bare token count.
describe("formatContextPercent", () => {
  it("expresses usage as a percentage of the window", () => {
    expect(formatContextPercent(500_000, 1_000_000)).toBe("50%");
    expect(formatContextPercent(180_000, 200_000)).toBe("90%");
    expect(formatContextPercent(0, 200_000)).toBe("0%");
  });

  it("rounds to whole percent", () => {
    expect(formatContextPercent(624_000, 1_000_000)).toBe("62%");
    expect(formatContextPercent(626_000, 1_000_000)).toBe("63%");
  });

  // The same count means very different things on the two windows this user runs.
  // Getting the denominator wrong is the failure the feature is guarded against.
  it("gives different answers for the two real window sizes", () => {
    expect(formatContextPercent(271_243, 1_000_000)).toBe("27%");
    expect(formatContextPercent(271_243, 200_000)).toBe("136%");
  });

  it("returns nothing when the window is unknown", () => {
    expect(formatContextPercent(500_000, undefined)).toBe("");
    expect(formatContextPercent(500_000, 0)).toBe("");
    expect(formatContextPercent(500_000, NaN)).toBe("");
    expect(formatContextPercent(500_000, -1)).toBe("");
  });

  it("returns nothing for a nonsensical count", () => {
    expect(formatContextPercent(NaN, 1_000_000)).toBe("");
    expect(formatContextPercent(-5, 1_000_000)).toBe("");
  });

  // Over 100% is a real state, not a bug: a session can exceed its window before
  // the CLI compacts it, and hiding that is exactly what the user needs to see.
  it("reports over-full rather than clamping", () => {
    expect(formatContextPercent(226_000, 100_000)).toBe("226%");
  });
});
