import { describe, expect, it } from "vitest";
import { finderSize, MAX_DROP_BYTES, MAX_DROP_FILES, pastDropLimit } from "./dropLimits";
import type { DropItemSize } from "./dropLimits";

const file = (size = 1): DropItemSize => ({ isDirectory: false, size });
const folder = (): DropItemSize => ({ isDirectory: true, size: 96 });
const files = (n: number, size = 1) => Array.from({ length: n }, () => file(size));

describe("pastDropLimit", () => {
  it("takes 10 files and refuses 11", () => {
    expect(MAX_DROP_FILES).toBe(10);
    expect(pastDropLimit(10, files(10))).toBeNull();
    expect(pastDropLimit(11, files(11))).toEqual({ kind: "too-many" });
  });

  it("refuses too many by the count alone, with nothing described", () => {
    expect(pastDropLimit(12, [])).toEqual({ kind: "too-many" });
  });

  it("takes exactly 1 GB in all and refuses 1 byte more", () => {
    expect(MAX_DROP_BYTES).toBe(1_000_000_000);
    expect(pastDropLimit(1, [file(1_000_000_000)])).toBeNull();
    expect(pastDropLimit(2, [file(600_000_000), file(400_000_000)])).toBeNull();
    expect(pastDropLimit(2, [file(600_000_000), file(400_000_001)])).toEqual({
      kind: "too-large",
      bytes: 1_000_000_001,
    });
  });

  it("refuses a folder anywhere in the drop, alone or with files", () => {
    expect(pastDropLimit(1, [folder()])).toEqual({ kind: "folder" });
    expect(pastDropLimit(3, [file(), file(), folder()])).toEqual({ kind: "folder" });
    expect(pastDropLimit(2, [folder(), file()])).toEqual({ kind: "folder" });
  });

  it("names the count before a folder, and a folder before the size", () => {
    expect(pastDropLimit(11, [folder(), ...files(10, MAX_DROP_BYTES)])).toEqual({
      kind: "too-many",
    });
    expect(pastDropLimit(2, [folder(), file(MAX_DROP_BYTES + 1)])).toEqual({ kind: "folder" });
  });
});

describe("finderSize", () => {
  // Each pair as NSByteCountFormatter's file style gave it on macOS (2026-10-28).
  it.each([
    [1, "1 byte"],
    [999, "999 bytes"],
    [1000, "1 KB"],
    [1500, "2 KB"],
    [999_499, "999 KB"],
    [999_500, "1 MB"],
    [1_050_000, "1.1 MB"],
    [12_345_678, "12.3 MB"],
    [999_949_999, "999.9 MB"],
    [999_950_000, "1 GB"],
    [1_000_000_000, "1 GB"],
    [1_004_999_999, "1 GB"],
    [1_005_000_000, "1.01 GB"],
    [1_100_000_000, "1.1 GB"],
    [1_412_345_678, "1.41 GB"],
    [1_994_999_999, "1.99 GB"],
    [1_995_000_000, "2 GB"],
    [12_345_678_901, "12.35 GB"],
    [999_994_999_999, "999.99 GB"],
    [999_995_000_000, "1 TB"],
    [1_234_567_890_123, "1.23 TB"],
  ])("shows %d bytes as %s", (bytes, shown) => {
    expect(finderSize(bytes)).toBe(shown);
  });
});
