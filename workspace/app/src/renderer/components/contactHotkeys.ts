// Cmd+1…9 shows one of the first nine contacts in the contact list. Holding Cmd
// alone puts each contact's digit after its name (ContactList).
//
// Option+Shift+Down and Up show the next and the previous contact with unread
// alerts, Slack's and Discord's keys for the next unread channel. Back from
// somewhere else at the sound, the builder needn't look for the red dot.

// How long Cmd is held alone before the digits show. Cmd+C and the like are
// usually done by then, so the list doesn't flash on every shortcut.
export const HINT_DELAY_MS = 250;

/**
 * The ids Cmd+1…9 select, first to ninth, in the order the list draws them: the
 * stored order.
 */
export function hotkeyTargets<T extends { id: string }>(instances: T[]): string[] {
  return instances.slice(0, 9).map((i) => i.id);
}

// The part of a KeyboardEvent this reads, so tests need no DOM.
interface KeyChord {
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/**
 * 1 to 9 for Cmd plus a digit key, else null.
 *
 * Read from `code`, the physical key, not `key`: on a layout whose digit row
 * types symbols without Shift (French AZERTY), `key` is "&" for the 1 key.
 */
export function hotkeyDigit(e: KeyChord): number | null {
  if (!e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return null;
  const match = /^Digit([1-9])$/.exec(e.code);
  return match ? Number(match[1]) : null;
}

/** 1 for Option+Shift+Down, -1 for Option+Shift+Up, else null. */
export function unreadStep(e: KeyChord): 1 | -1 | null {
  if (!e.altKey || !e.shiftKey || e.metaKey || e.ctrlKey) return null;
  if (e.code === "ArrowDown") return 1;
  if (e.code === "ArrowUp") return -1;
  return null;
}

/**
 * The contact Option+Shift+Down (step 1) or Up (step -1) shows: the nearest one
 * below or above `current` in `order` with unread alerts, going round the end of
 * the list. Null when no other contact has any. With nothing shown, Down starts
 * from the top and Up from the bottom.
 */
export function nextUnread(
  order: string[],
  unread: ReadonlyMap<string, number>,
  current: string | null,
  step: 1 | -1
): string | null {
  const n = order.length;
  const at = current === null ? -1 : order.indexOf(current);
  const from = at >= 0 ? at : step === 1 ? -1 : n;
  for (let i = 1; i <= n; i++) {
    const id = order[(((from + step * i) % n) + n) % n];
    if (id !== current && (unread.get(id) ?? 0) > 0) return id;
  }
  return null;
}

// In a text field (the compose box, the Markdown View's path), Option+Shift+Up
// and Down select to the start or end of a paragraph, and keep that meaning.
// xterm's own textarea is not one: neither CLI does anything with them.
function inTextField(target: unknown): boolean {
  if (typeof target !== "object" || target === null) return false;
  const closest = (target as { closest?: unknown }).closest;
  if (typeof closest !== "function") return false;
  return (
    closest.call(target, "input, textarea") !== null &&
    closest.call(target, ".xterm") === null
  );
}

export interface HotkeyHandlers {
  // Read at each key press, so a reorder or a new contact applies at once.
  targets: () => string[];
  // The contact Option+Shift+Down (1) or Up (-1) shows, or null; see nextUnread.
  // Read at each key press too.
  unreadTarget: (step: 1 | -1) => string | null;
  select: (id: string) => void;
  showHints: (shown: boolean) => void;
  // True while a modal dialog is open. Its keys are its own, and a switch would
  // put focus in the terminal behind it, where the next keys reach the CLI.
  paused: () => boolean;
}

/**
 * Listens on `target` (the window) for Cmd held alone, Cmd plus a digit, and
 * Option+Shift+Up/Down, and returns the function that stops it.
 *
 * Capture phase, so this runs before xterm's own handler, and stopping the event
 * there keeps the digit out of the terminal.
 */
export function listenForContactHotkeys(
  target: EventTarget,
  handlers: HotkeyHandlers
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hide = () => {
    clearTimeout(timer);
    timer = undefined;
    handlers.showHints(false);
  };
  const onKeyDown = (event: Event) => {
    const e = event as KeyboardEvent;
    if (handlers.paused()) return;
    if (e.key === "Meta") {
      timer ??= setTimeout(() => handlers.showHints(true), HINT_DELAY_MS);
      return;
    }
    const step = unreadStep(e);
    if (step !== null && !inTextField(e.target)) {
      e.preventDefault();
      e.stopPropagation();
      const id = handlers.unreadTarget(step);
      if (id) handlers.select(id);
      return;
    }
    const digit = hotkeyDigit(e);
    if (digit === null) {
      // Cmd is part of some other shortcut, or not held at all.
      hide();
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    // Held Cmd keeps the digits up, so a second digit can follow.
    const id = handlers.targets()[digit - 1];
    if (id) handlers.select(id);
  };
  const onKeyUp = (event: Event) => {
    if ((event as KeyboardEvent).key === "Meta") hide();
  };
  // An object, not `true`: Node's EventTarget, which the tests run on, ignores a
  // bare boolean when removing, and the listener would outlive its stop.
  const capture = { capture: true };
  target.addEventListener("keydown", onKeyDown, capture);
  target.addEventListener("keyup", onKeyUp, capture);
  // Cmd+Tab and the like release Cmd in another app, so no keyup comes here.
  target.addEventListener("blur", hide);
  return () => {
    clearTimeout(timer);
    target.removeEventListener("keydown", onKeyDown, capture);
    target.removeEventListener("keyup", onKeyUp, capture);
    target.removeEventListener("blur", hide);
  };
}
