// "Put 2 files in multi-code?" (file-drop PRD Story 3): a drop on a project with a
// default folder asks before anything is copied. Display and keys only; App runs
// the pickers and the copy.

import type { DroppedItem } from "../../shared/types";
import { dropTitle, shownNames } from "./dropFlow";

interface FileDropDialogProps {
  // The contact's display name.
  project: string;
  // The default folder as main formats it: `docs/sources/inbox/`, `~/Downloads/`.
  folder: string;
  items: DroppedItem[];
  // One of its pickers is open. The dialog stays up behind it, so a drop meanwhile
  // is still ignored (useFileDrop), but takes no clicks or keys.
  picking: boolean;
  onPutHere: () => void;
  onSomewhereElse: () => void;
  onChangeDefault: () => void;
  // Esc or a click outside: nothing is copied.
  onClose: () => void;
}

export function FileDropDialog({
  project,
  folder,
  items,
  picking,
  onPutHere,
  onSomewhereElse,
  onChangeDefault,
  onClose,
}: FileDropDialogProps) {
  const { names, more } = shownNames(items);

  return (
    <div className="dialog-overlay" onClick={picking ? undefined : onClose}>
      <div
        className="dialog file-drop-dialog"
        // Focusable, so a click on its text keeps the keys here rather than on
        // the page, where Enter and Esc would reach nothing.
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            if (!picking) onClose();
          } else if (e.key === "Enter" && !(e.target instanceof HTMLButtonElement)) {
            // On a button, Enter presses that button; anywhere else, Put here.
            e.preventDefault();
            if (!picking) onPutHere();
          } else if (e.key === "Tab") {
            // Round the dialog's buttons only. Past the last one, Tab would reach
            // the page behind, the terminal included, and the next Enter with it.
            e.preventDefault();
            const buttons = [
              ...e.currentTarget.querySelectorAll<HTMLButtonElement>("button:enabled"),
            ];
            if (buttons.length === 0) return;
            const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
            const step = e.shiftKey ? -1 : 1;
            buttons[at === -1 ? 0 : (at + step + buttons.length) % buttons.length].focus();
          }
        }}
      >
        <h3 className="dialog-title">{dropTitle(items, project)}</h3>

        <div className="file-drop-folder" title={folder}>
          → {folder}
        </div>
        <ul className="file-drop-names">
          {names.map((name, i) => (
            <li key={i} title={name}>
              {name}
            </li>
          ))}
          {more > 0 && <li className="file-drop-more">+{more} more</li>}
        </ul>

        <button
          type="button"
          className="file-drop-change"
          onClick={onChangeDefault}
          disabled={picking}
        >
          Change default path…
        </button>

        <div className="dialog-actions">
          <button
            type="button"
            className="dialog-btn cancel"
            onClick={onSomewhereElse}
            disabled={picking}
          >
            Somewhere else…
          </button>
          <button
            type="button"
            className="dialog-btn primary"
            onClick={onPutHere}
            disabled={picking}
            autoFocus
          >
            Put here
          </button>
        </div>
        <div className="file-drop-hint">Enter = Put here · Esc = cancel</div>
      </div>
    </div>
  );
}
