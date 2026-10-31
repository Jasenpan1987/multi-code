// The DOM half of drag-to-reorder. The arithmetic lives in `shared/reorder.ts`,
// because the main process applies the same move and the two must not disagree.

/**
 * Whether a pointer at `clientY` over a row means "insert before this row".
 *
 * Splitting at the midpoint is what makes a drop land where the user is pointing
 * rather than always after the row they happen to be over.
 */
export function dropsBefore(
  clientY: number,
  rect: { top: number; height: number }
): boolean {
  return clientY < rect.top + rect.height / 2;
}
