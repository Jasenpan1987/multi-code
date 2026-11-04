import type { DiffRow } from "../../shared/types";

/**
 * One run of consecutive changed rows on one side of the diff, as drawn on the
 * overview ruler. `start` is a row index, `end` is exclusive.
 */
export interface OverviewMark {
  side: "old" | "new";
  start: number;
  end: number;
}

/**
 * The changed runs of a diff, one lane per side like the grid itself: removed
 * lines mark the old lane, added lines the new lane, a replacement both. Runs
 * rather than single rows, so a large file costs one mark per hunk, not per line.
 */
export function overviewMarks(rows: DiffRow[]): OverviewMark[] {
  const marks: OverviewMark[] = [];
  let oldStart = -1;
  let newStart = -1;
  for (let i = 0; i <= rows.length; i++) {
    const kind = rows[i]?.kind;
    const oldChanged = kind === "del" || kind === "replace";
    const newChanged = kind === "add" || kind === "replace";
    if (oldChanged && oldStart < 0) oldStart = i;
    if (!oldChanged && oldStart >= 0) {
      marks.push({ side: "old", start: oldStart, end: i });
      oldStart = -1;
    }
    if (newChanged && newStart < 0) newStart = i;
    if (!newChanged && newStart >= 0) {
      marks.push({ side: "new", start: newStart, end: i });
      newStart = -1;
    }
  }
  return marks;
}
