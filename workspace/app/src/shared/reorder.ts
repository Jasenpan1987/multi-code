// Where a dragged item lands in a list.
//
// In `shared/` because both sides need the same answer: the renderer to draw the
// insertion line, the main process to apply it. Duplicating the arithmetic would let
// the preview and the result disagree.

/**
 * Move `dragId` so it sits immediately before or after `targetId`.
 *
 * Returns the input array unchanged when the move is a no-op or the arguments don't
 * make sense, so a caller can compare by identity and skip persisting nothing.
 */
export function moveInOrder(
  ids: string[],
  dragId: string,
  targetId: string,
  placeBefore: boolean
): string[] {
  if (dragId === targetId) return ids;
  const from = ids.indexOf(dragId);
  const targetAt = ids.indexOf(targetId);
  if (from === -1 || targetAt === -1) return ids;

  const without = ids.filter((id) => id !== dragId);
  // Recomputed after the removal: the target's index shifts down by one whenever the
  // dragged row came from above it, and using the pre-removal index there drops the
  // row one slot short.
  const at = without.indexOf(targetId);
  const insertAt = placeBefore ? at : at + 1;

  const next = [...without];
  next.splice(insertAt, 0, dragId);

  // Dropping just below the row above you, or just above the row below you, means
  // "stay put" — returning a new array there would persist and re-render for nothing.
  return next.every((id, i) => id === ids[i]) ? ids : next;
}
