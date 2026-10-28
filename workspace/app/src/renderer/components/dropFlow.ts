// What a drop on a project does between its release (useFileDrop) and the copy
// (file-drop PRD Stories 1 to 3 and 6): the words its picker and dialog show, and
// what every drop comes to. Nothing here reads the document, so it is tested apart
// from FileDropDialog and App.

import { pastDropLimit } from "../../shared/dropLimits";
import type { PastDropLimit } from "../../shared/dropLimits";
import type { DropCopyOutcome, DropFolder, DroppedItem } from "../../shared/types";

// A drop past a limit (Story 6): nothing was copied. `count` is how many paths were
// dropped; `folder` is the default folder to put them in by hand, as main shows it,
// or null for the project folder.
export interface PastLimitReport {
  kind: "past-limit";
  limit: PastDropLimit;
  count: number;
  folder: string | null;
}

// What a drop came to, for the message after it (DropMessage). Each one replaces the
// same drop's one before.
export type DropReport =
  // The copy is running.
  | { kind: "copying" }
  // One outcome per dropped path, in the drop's order.
  | { kind: "copied"; outcomes: DropCopyOutcome[] }
  // An item had no file on disk (an image dragged out of a browser): nothing was
  // copied.
  | { kind: "only-finder" }
  | PastLimitReport
  // A call to main failed; nothing more was done. The error's own message.
  | { kind: "error"; message: string };

// The dialog lists this many names, then "+N more"; the message after the copy,
// this many outcomes.
export const MAX_SHOWN_NAMES = 5;

// getPathForFile gives "" for an item with no file on disk. A drop with none at
// all (files promised by an app, not handed over) is the same case.
export function allOnDisk(paths: string[]): boolean {
  return paths.length > 0 && paths.every((p) => p !== "");
}

/** "Put 1 file in multi-code?", "Put 2 files in multi-code?" A drop is files only. */
export function dropTitle(items: DroppedItem[], project: string): string {
  return `Put ${items.length} file${items.length === 1 ? "" : "s"} in ${project}?`;
}

/**
 * The names the dialog lists, in the drop's order, and how many more there are past
 * those.
 */
export function shownNames(
  items: DroppedItem[],
  max = MAX_SHOWN_NAMES
): { names: string[]; more: number } {
  return {
    names: items.slice(0, max).map((i) => i.name),
    more: Math.max(0, items.length - max),
  };
}

export type DropStep =
  // Past a limit: no picker and no dialog, only the message.
  | { kind: "refuse"; report: PastLimitReport }
  // The picker, at once and with no dialog first, starting in the project. What is
  // picked becomes the default.
  | { kind: "pick"; message: string; start: string }
  // The dialog, offering the default folder; `display` as main formats it.
  | { kind: "confirm"; folder: string; display: string };

/**
 * What a drop on a project opens: nothing when it is past a limit (Story 6), else,
 * from its default folder, the picker when it has none yet (Story 2) or the default
 * is gone, else the dialog (Story 3). `count` is how many paths were dropped and
 * `items` what describeDropped said of them, or [] when `count` alone is too many.
 */
export function dropStep(
  folder: DropFolder,
  project: { name: string; cwd: string },
  count: number,
  items: DroppedItem[]
): DropStep {
  const limit = pastDropLimit(count, items);
  if (limit) {
    return {
      kind: "refuse",
      report: { kind: "past-limit", limit, count, folder: pastLimitFolder(folder) },
    };
  }
  if (folder.path === null) {
    return {
      kind: "pick",
      message: `No default folder for ${project.name} yet. Choose where dropped files go.`,
      start: project.cwd,
    };
  }
  const display = folder.display ?? folder.path;
  if (!folder.exists) {
    return {
      kind: "pick",
      message: `The default folder ${display} no longer exists. Choose where dropped files go.`,
      start: project.cwd,
    };
  }
  return { kind: "confirm", folder: folder.path, display };
}

// Where a drop past a limit is to be put by hand: the default folder as the dialog
// would show it, or null (the project folder) when there is none, it is gone, or it
// is the project itself (`./`).
function pastLimitFolder(folder: DropFolder): string | null {
  if (folder.path === null || !folder.exists) return null;
  const display = folder.display ?? folder.path;
  return display === "./" ? null : display;
}

// The dialog's two pickers. Both start in the default folder.
export function somewhereElseMessage(folderDisplay: string): string {
  return `Choose where these files go. The default folder stays ${folderDisplay}.`;
}

export function changeDefaultMessage(project: string): string {
  return `Choose the new default folder for ${project}. These files go there too.`;
}

// How long a drop may wait on main before its dialog, its picker or its past-limit
// message shows (the window brought forward, the default folder looked up, the
// dropped items described). The keyboard is held all that time. A sleeping disk
// wakes well within it; a network volume that has gone away can keep a lookup
// waiting for minutes.
export const DROP_LOOKUP_DEADLINE_MS = 10_000;

export class DeadlineError extends Error {
  constructor(ms: number) {
    super(`gave up after ${ms} ms`);
    this.name = "DeadlineError";
  }
}

/**
 * What `work` comes to, unless `ms` pass first: then a DeadlineError, and `work`'s
 * signal is aborted so it can stop before its next step. A call to main can't be
 * called off, and what it comes to after the deadline is dropped, so `work` must
 * only look things up: what it finds is acted on by whoever awaited this, and only
 * in time.
 */
export function withDeadline<T>(
  work: (signal: AbortSignal) => Promise<T>,
  ms: number
): Promise<T> {
  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      reject(new DeadlineError(ms));
    }, ms);
    work(controller.signal).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

// What a drop was waiting on when it ran out of time: main bringing the window
// forward, the default folder, or the dropped items.
export type DropLookup = "focus" | "folder" | "items";

const TOO_SLOW: Record<DropLookup, string> = {
  focus: "bringing Multi-Code to the front",
  folder: "reading the default folder",
  items: "reading the dropped files",
};

export function lookupTooSlowMessage(
  waitingOn: DropLookup,
  ms = DROP_LOOKUP_DEADLINE_MS
): string {
  return `Nothing copied: ${TOO_SLOW[waitingOn]} took over ${Math.round(ms / 1000)} seconds`;
}

// Capture, so these run before the terminal's and the compose box's own listeners.
// As an object: Node's EventTarget, which the tests use, removes nothing for a bare
// `true`.
const CAPTURE = { capture: true };

// What the builder's input arrives as: keys, a paste (Edit → Paste, the context
// menu, webContents.paste()), the text an input method or dictation composes, text
// dropped on a field.
const HELD_INPUT = [
  "keydown",
  "keypress",
  "paste",
  "beforeinput",
  "input",
  "compositionstart",
  "compositionupdate",
  "compositionend",
  "drop",
];

/**
 * The builder's input reaches nothing but what `allow` lets through until the
 * returned release is called. A drop holds it from its release until its dialog or
 * picker has it: the folder lookup can be slow (a network volume), and an Enter or
 * a paste meanwhile must reach no terminal or compose box. Keys, pastes, input
 * method text and dropped text are stopped where they start, and the focus is kept
 * off everything else, so a click on the terminal, or xterm taking the focus back,
 * gives none of them a target. Only input: what a terminal sends by itself, its
 * replies to the CLI's queries, still goes to its session.
 */
export function holdInput(
  target: EventTarget,
  allow: (to: EventTarget | null) => boolean
): () => void {
  const stop = (e: Event) => {
    if (allow(e.target)) return;
    // Files dropped are useFileDrop's, which ignores them while a drop is going on.
    if (e.type === "drop" && (e as DragEvent).dataTransfer?.types.includes("Files")) return;
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  const keepFocusOff = (e: Event) => {
    if (allow(e.target)) return;
    const to = e.target as HTMLElement | null;
    if (typeof to?.blur === "function") to.blur();
  };
  for (const type of HELD_INPUT) target.addEventListener(type, stop, CAPTURE);
  target.addEventListener("focusin", keepFocusOff, CAPTURE);
  return () => {
    for (const type of HELD_INPUT) target.removeEventListener(type, stop, CAPTURE);
    target.removeEventListener("focusin", keepFocusOff, CAPTURE);
  };
}

// How long a key held from before has to start repeating. macOS's slowest "Delay
// until repeat" is under two seconds; with no repeat by then, nothing was held.
export const HELD_KEY_WINDOW_MS = 3000;

/**
 * After a dialog or picker that a key closed, a key still held from it repeats into
 * whatever has the focus next: the session's terminal, where an Enter can answer a
 * question the builder never saw. A repeat of a key not pressed since is such a
 * key. Its repeats are swallowed until that key is released or pressed again,
 * whatever other keys do meanwhile (Shift let go of a held Shift+Enter). Keys
 * pressed since go through, repeats and all. Keys are told apart by `code`, the
 * physical key, which a modifier doesn't change as it does `key`.
 */
export function swallowHeldKeyRepeats(target: EventTarget): void {
  const pressedSince = new Set<string>();
  const held = new Set<string>();
  const keyOf = (e: Event) => {
    const k = e as KeyboardEvent;
    return k.code || k.key;
  };
  const release = (key: string) => {
    if (held.delete(key) && held.size === 0) stop();
  };
  const onDown = (e: Event) => {
    const key = keyOf(e);
    if (!(e as KeyboardEvent).repeat) {
      pressedSince.add(key);
      release(key);
      return;
    }
    if (pressedSince.has(key)) return;
    held.add(key);
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  const onUp = (e: Event) => release(keyOf(e));
  const stop = () => {
    clearTimeout(timer);
    target.removeEventListener("keydown", onDown, CAPTURE);
    target.removeEventListener("keyup", onUp, CAPTURE);
  };
  // Nothing held: no repeat came in time.
  const timer = setTimeout(() => {
    if (held.size === 0) stop();
  }, HELD_KEY_WINDOW_MS);
  target.addEventListener("keydown", onDown, CAPTURE);
  target.addEventListener("keyup", onUp, CAPTURE);
}
