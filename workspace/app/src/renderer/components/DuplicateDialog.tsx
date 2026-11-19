import { useEffect, useRef, useState } from "react";
import type { BackendAvailability, Instance } from "../../shared/types";
import { duplicateOptions, otherBackend } from "./duplicateOptions";
import type { DuplicateChoice } from "./duplicateOptions";

// Right-click → Duplicate… (docs/specs/duplicate-options): fork the session, a new
// session with the same tool, a new session with the other tool, or Cancel. Asks
// main once on opening whether there is a conversation to fork and whether the
// other tool can run. Fork has the focus when it can be picked, so Enter forks.
// Tab stays among the dialog's buttons and Esc is its own, as in the note dialog:
// past them the keys would reach the terminal behind, or a diff window. Focus that
// lands outside the dialog while it is open (a click on the backdrop, a diff window
// closing and focusing the terminal) comes back to it.

interface DuplicateDialogProps {
  source: Instance;
  onPick: (choice: DuplicateChoice) => void;
  onClose: () => void;
}

export function DuplicateDialog({ source, onPick, onClose }: DuplicateDialogProps) {
  const [canFork, setCanFork] = useState<boolean | null>(null);
  const [other, setOther] = useState<BackendAvailability | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const forkRef = useRef<HTMLButtonElement>(null);
  const newRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  // Asked again whenever the contact moves to another session (`/clear`,
  // `/resume`), and an answer about the session it left is dropped.
  useEffect(() => {
    let live = true;
    // Fork is about to be disabled while it is asked again: its focus goes to Cancel,
    // not to the page (where Esc and Tab would miss the dialog) and not to another
    // choice that an Enter meant for Fork would then make.
    if (document.activeElement === forkRef.current) cancelRef.current?.focus();
    setCanFork(null);
    void window.electronAPI
      .canFork(source.id)
      .catch(() => false)
      .then((ok) => {
        if (live) setCanFork(ok);
      });
    return () => {
      live = false;
    };
  }, [source.id, source.sessionId]);

  useEffect(() => {
    let live = true;
    void window.electronAPI
      .backendAvailability(otherBackend(source.backend))
      .catch((): BackendAvailability => ({ ok: false, reason: "missing" }))
      .then((availability) => {
        if (live) setOther(availability);
      });
    return () => {
      live = false;
    };
  }, [source.backend]);

  // New session has the focus first, since it can always be picked; Fork takes it
  // once main says there is something to fork, unless the builder has moved on.
  useEffect(() => {
    if (canFork && document.activeElement === newRef.current) forkRef.current?.focus();
  }, [canFork]);

  useEffect(() => {
    const keepFocus = (e: FocusEvent) => {
      if (e.target instanceof Node && dialogRef.current?.contains(e.target)) return;
      (forkRef.current?.disabled === false ? forkRef.current : newRef.current)?.focus();
    };
    document.addEventListener("focusin", keepFocus);
    return () => document.removeEventListener("focusin", keepFocus);
  }, []);

  const options = duplicateOptions(source.backend, canFork, other);

  return (
    <div
      className="dialog-overlay above-diff"
      onClick={onClose}
      // A click on the backdrop would take the focus to the page behind it.
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) e.preventDefault();
      }}
    >
      <div
        ref={dialogRef}
        className="dialog duplicate-dialog"
        role="dialog"
        aria-label={`Duplicate ${source.name}`}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onClose();
          } else if (e.key === "Tab") {
            e.preventDefault();
            const buttons = [
              ...e.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"),
            ];
            const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
            const step = e.shiftKey ? -1 : 1;
            buttons[(at + step + buttons.length) % buttons.length]?.focus();
          }
        }}
      >
        <h3 className="dialog-title">Duplicate “{source.name}”</h3>
        <div className="duplicate-options">
          {options.map((option) => (
            <button
              key={option.choice}
              ref={option.choice === "fork" ? forkRef : option.choice === "new" ? newRef : undefined}
              type="button"
              className="duplicate-option"
              data-choice={option.choice}
              disabled={option.disabled}
              autoFocus={option.choice === "new"}
              onClick={() => onPick(option.choice)}
            >
              <span className="duplicate-option-label">{option.label}</span>
              <span className="duplicate-option-detail">{option.detail}</span>
            </button>
          ))}
        </div>
        <div className="dialog-actions">
          <button ref={cancelRef} className="dialog-btn cancel" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
