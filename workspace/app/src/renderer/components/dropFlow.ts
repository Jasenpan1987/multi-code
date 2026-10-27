// What a drop on a project does between its release (useFileDrop) and the copy
// (file-drop PRD Stories 1 to 3): the words its picker and dialog show, and what
// every drop comes to. Nothing here reads the document, so it is tested apart from
// FileDropDialog and App.

import type { DropCopyOutcome, DropFolder, DroppedItem } from "../../shared/types";

// What a drop came to, for the message after it (T-705). Each one replaces the one
// before.
export type DropReport =
  // The copy is running.
  | { kind: "copying" }
  // One outcome per dropped path, in the drop's order.
  | { kind: "copied"; outcomes: DropCopyOutcome[] }
  // An item had no file on disk (an image dragged out of a browser): nothing was
  // copied.
  | { kind: "only-finder" }
  // A call to main failed; nothing more was done. The error's own message.
  | { kind: "error"; message: string };

// The dialog lists this many names, then "+N more".
export const MAX_SHOWN_NAMES = 5;

// getPathForFile gives "" for an item with no file on disk. A drop with none at
// all (files promised by an app, not handed over) is the same case.
export function allOnDisk(paths: string[]): boolean {
  return paths.length > 0 && paths.every((p) => p !== "");
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/** "Put 2 files in multi-code?", "Put 1 file and 1 folder in multi-code?" */
export function dropTitle(items: DroppedItem[], project: string): string {
  const folders = items.filter((i) => i.isDirectory).length;
  const files = items.length - folders;
  const parts: string[] = [];
  if (files > 0 || folders === 0) parts.push(count(files, "file"));
  if (folders > 0) parts.push(count(folders, "folder"));
  return `Put ${parts.join(" and ")} in ${project}?`;
}

/**
 * The names the dialog lists, in the drop's order, a folder's with a trailing `/`
 * as everywhere else a drop shows one; and how many more there are past those.
 */
export function shownNames(
  items: DroppedItem[],
  max = MAX_SHOWN_NAMES
): { names: string[]; more: number } {
  return {
    names: items.slice(0, max).map((i) => (i.isDirectory ? `${i.name}/` : i.name)),
    more: Math.max(0, items.length - max),
  };
}

export type DropStep =
  // The picker, at once and with no dialog first, starting in the project. What is
  // picked becomes the default.
  | { kind: "pick"; message: string; start: string }
  // The dialog, offering the default folder; `display` as main formats it.
  | { kind: "confirm"; folder: string; display: string };

/**
 * What a drop on a project opens, from its default folder: the picker when it has
 * none yet (Story 2) or the default is gone, else the dialog (Story 3).
 */
export function dropStep(
  folder: DropFolder,
  project: { name: string; cwd: string }
): DropStep {
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

// The dialog's two pickers. Both start in the default folder.
export function somewhereElseMessage(folderDisplay: string): string {
  return `Choose where these files go. The default folder stays ${folderDisplay}.`;
}

export function changeDefaultMessage(project: string): string {
  return `Choose the new default folder for ${project}. These files go there too.`;
}

/**
 * After a dialog or picker that a key closed, a key still held from it repeats into
 * whatever has the focus next: the session's terminal, where an Enter can answer a
 * question the builder never saw. Repeats are swallowed until the key is released,
 * or until a fresh press shows it was.
 */
export function swallowHeldKeyRepeats(target: EventTarget): void {
  const onDown = (e: Event) => {
    if ((e as KeyboardEvent).repeat) {
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    stop();
  };
  // Capture, so the terminal never sees a swallowed repeat. As an object: Node's
  // EventTarget, which the tests use, removes nothing for a bare `true`.
  const capture = { capture: true };
  const stop = () => {
    target.removeEventListener("keydown", onDown, capture);
    target.removeEventListener("keyup", stop, capture);
  };
  target.addEventListener("keydown", onDown, capture);
  target.addEventListener("keyup", stop, capture);
}
