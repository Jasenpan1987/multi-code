// The alert rules, chat-app style (docs/specs/attention-alerts/prd.md, Story 4):
// every attention event chimes, puts a red dot on its contact and bounces the
// Dock, whichever instance is shown and whether or not the window has focus. The
// alert clears only when the builder acknowledges it.
//
// This replaced suppress-while-watching, an urgent override and a 5s cooldown,
// borrowed from Orca. Together they silenced real finishes while the builder was
// looking at the session, and a false alert could swallow the real one after it.
//
// What is left to decide is which input counts as acknowledging the shown
// instance: a key press, or a click anywhere in its page (terminal, compose box,
// toolbox). Not a click in the contact list, which selects (and so acknowledges)
// the contact clicked rather than the one being left, and not input to a dialog
// layered over the page, which is about something else.

const NOT_THE_PAGE = ".sidebar, .dialog-overlay";

// The bit of an event target this needs. An Element in the app; anything with
// `closest` in tests, which run without a DOM.
interface ClosestCapable {
  closest(selector: string): unknown;
}

export function acknowledgesShownInstance(target: unknown): boolean {
  if (typeof target !== "object" || target === null) return true;
  const closest = (target as Partial<ClosestCapable>).closest;
  // A text node or the window itself: not inside the sidebar or a dialog.
  if (typeof closest !== "function") return true;
  return closest.call(target, NOT_THE_PAGE) === null;
}
