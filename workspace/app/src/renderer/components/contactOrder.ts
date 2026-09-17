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

/**
 * Stored order, with the manager pinned to the top.
 *
 * The manager isn't a project — it is the thing that drives them — so it holds
 * first place regardless of where a drag-reordered list put it. Projects keep
 * their relative order, and the input array is returned unchanged when there is
 * nothing to move, so callers can compare by identity.
 */
export function pinManagerFirst<T extends { isManager?: boolean }>(
  instances: T[]
): T[] {
  const at = instances.findIndex((i) => i.isManager);
  if (at <= 0) return instances;
  return [instances[at], ...instances.filter((_, i) => i !== at)];
}
