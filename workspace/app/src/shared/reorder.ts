// Where a dragged item lands in a list, and the order the contact list shows.
//
// In `shared/` because both sides need the same answer: the renderer to draw the
// insertion line, the main process to apply it. Duplicating the arithmetic would let
// the preview and the result disagree. The same goes for the shown order, which the
// desktop list and the phone's list both use.

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

/**
 * The order the contact list shows: running contacts first, then stopped ones,
 * each group in stored order.
 *
 * Only a view of `items`. The stored order (contacts.json, drags) never changes
 * when a session starts or stops, so a contact that stops and starts again goes
 * back to where it was among the running ones.
 */
export function aliveFirst<T extends { status: "running" | "stopped" }>(items: T[]): T[] {
  return [
    ...items.filter((i) => i.status === "running"),
    ...items.filter((i) => i.status !== "running"),
  ];
}
