// What one Finder drop may hold (file-drop PRD Story 6): files only, at most 10 of
// them, at most 1 GB in all. Past any of these the whole drop is refused, so a big
// or unusual one goes through Finder instead. The renderer checks before its dialog
// or picker, and main's copy again on its own.

export const MAX_DROP_FILES = 10;
// As Finder counts: 1 GB is 1,000,000,000 bytes.
export const MAX_DROP_BYTES = 1_000_000_000;

// A dropped path as the check needs it: lstat's, so a link counts as itself.
export interface DropItemSize {
  isDirectory: boolean;
  size: number;
}

export type PastDropLimit =
  | { kind: "too-many" }
  | { kind: "folder" }
  // `bytes` is the drop's total.
  | { kind: "too-large"; bytes: number };

/**
 * Which limit a drop of `count` paths is past, or null for one within them all. The
 * count comes first and needs no `items`, so a caller can skip describing a drop
 * that is too many anyway (pass []). A folder comes before the size: lstat's size of
 * one is not what it holds.
 */
export function pastDropLimit(count: number, items: DropItemSize[]): PastDropLimit | null {
  if (count > MAX_DROP_FILES) return { kind: "too-many" };
  if (items.some((i) => i.isDirectory)) return { kind: "folder" };
  const bytes = items.reduce((total, i) => total + i.size, 0);
  return bytes > MAX_DROP_BYTES ? { kind: "too-large", bytes } : null;
}

// Finder's units are decimal, each with its own decimals: 12 KB, 12.3 MB, 1.41 GB.
const UNITS = [
  ["KB", 0],
  ["MB", 1],
  ["GB", 2],
  ["TB", 2],
] as const;

/**
 * A size as Finder shows it (NSByteCountFormatter's file style, checked on macOS
 * 2026-10-28): rounded in the largest unit it reaches, trailing zeros dropped, so
 * 999,999,999 bytes is "1 GB" and 1,412,345,678 is "1.41 GB".
 */
export function finderSize(bytes: number): string {
  if (bytes < 1000) return bytes === 1 ? "1 byte" : `${bytes} bytes`;
  for (let at = 0; ; at++) {
    const [unit, digits] = UNITS[at];
    // From the bytes in one division, so a half rounds up as Finder's does:
    // 1,005,000,000 is 100.5 hundredths of a GB, and a GB made by dividing by 1000
    // three times lands a hair under 1.005.
    const rounded = Math.round(bytes / 10 ** (3 * (at + 1) - digits)) / 10 ** digits;
    // 999.95 MB rounds to 1000 MB, which Finder calls 1 GB.
    if (rounded < 1000 || at === UNITS.length - 1) return `${rounded} ${unit}`;
  }
}
