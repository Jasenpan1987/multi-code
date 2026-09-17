import type { DiffRow } from "../../shared/types";

export interface DiffRef {
  // What gets inserted into the compose box, e.g. `@src/a.ts:12-30`.
  ref: string;
  // True when the selection had no new-version lines of its own and the nearest
  // surrounding line was used instead. The UI says so rather than passing off a
  // number the user didn't pick.
  fellBack: boolean;
}

/**
 * The reference for a range of selected rows, `start` and `end` inclusive.
 *
 * Line numbers come from the **new** version, because that is the file the agent
 * will read. A deletion has no new-version number, so a selection made entirely
 * of deleted lines falls back to the nearest line that does have one.
 */
export function refForRange(
  rows: DiffRow[],
  start: number,
  end: number,
  relPath: string
): DiffRef {
  const lo = Math.max(0, Math.min(start, end));
  const hi = Math.min(rows.length - 1, Math.max(start, end));
  if (rows.length === 0 || lo > hi) {
    return { ref: `@${relPath}`, fellBack: false };
  }

  const inRange: number[] = [];
  for (let i = lo; i <= hi; i++) {
    const line = rows[i].newLine;
    if (line !== null) inRange.push(line);
  }

  if (inRange.length > 0) {
    const first = Math.min(...inRange);
    const last = Math.max(...inRange);
    return {
      ref: first === last ? `@${relPath}:${first}` : `@${relPath}:${first}-${last}`,
      fellBack: false,
    };
  }

  const nearest = nearestNewLine(rows, lo, hi);
  if (nearest === null) {
    // Nothing in the file has a new-version line — the whole file was deleted.
    return { ref: `@${relPath}`, fellBack: true };
  }
  return { ref: `@${relPath}:${nearest}`, fellBack: true };
}

/** Walk outwards from the range for the closest row that exists in the new file. */
function nearestNewLine(
  rows: DiffRow[],
  lo: number,
  hi: number
): number | null {
  let before = lo - 1;
  let after = hi + 1;
  while (before >= 0 || after < rows.length) {
    // Prefer the line above: a deletion is most often discussed in terms of what
    // now precedes the gap it left.
    if (before >= 0) {
      const line = rows[before].newLine;
      if (line !== null) return line;
      before--;
    }
    if (after < rows.length) {
      const line = rows[after].newLine;
      if (line !== null) return line;
      after++;
    }
  }
  return null;
}
