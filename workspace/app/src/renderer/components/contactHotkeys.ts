// Cmd+1…9 shows one of the first nine projects in the contact list. The manager
// is left out, so Cmd+1 is the first project whether or not a manager exists.
// Holding Cmd alone puts each project's digit after its name (ContactList).

// How long Cmd is held alone before the digits show. Cmd+C and the like are
// usually done by then, so the list doesn't flash on every shortcut.
export const HINT_DELAY_MS = 250;

/**
 * The ids Cmd+1…9 select, first to ninth, in the order the list draws them.
 *
 * Filtering the stored order is enough: pinManagerFirst moves only the manager,
 * so the projects keep the same relative order on screen.
 */
export function hotkeyTargets<T extends { id: string; isManager?: boolean }>(
  instances: T[]
): string[] {
  return instances
    .filter((i) => !i.isManager)
    .slice(0, 9)
    .map((i) => i.id);
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

export interface HotkeyHandlers {
  // Read at each key press, so a reorder or a new contact applies at once.
  targets: () => string[];
  select: (id: string) => void;
  showHints: (shown: boolean) => void;
  // True while a modal dialog is open. Its keys are its own, and a switch would
  // put focus in the terminal behind it, where the next keys reach the CLI.
  paused: () => boolean;
}

/**
 * Listens on `target` (the window) for Cmd held alone and Cmd plus a digit, and
 * returns the function that stops it.
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
