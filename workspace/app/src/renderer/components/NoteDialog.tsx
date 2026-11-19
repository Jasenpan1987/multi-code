import { useEffect, useRef, useState } from "react";
import { NOTE_MAX_LENGTH } from "../../shared/types";

// Writes or edits the builder's note on one session (docs/specs/session-notes,
// Story 1). Enter is a new line; Cmd+Enter saves. Neither Cmd+Enter nor Esc acts
// while an input method is composing, so a pinyin word being picked is never cut
// short. While it is open the focus stays in it: Tab goes round its own fields,
// and focus that lands anywhere else (a click on the backdrop, a diff window
// closing and focusing the terminal) comes back to the text. Out of it, the next
// keys could go to the agent. It stays open,
// draft and all, until the save has worked. Mounted only while open, so each
// opening starts from the saved text.

interface NoteDialogProps {
  // The session's name, for the title.
  sessionName: string;
  // The note as saved, or "" for a new one.
  initialText: string;
  onClose: () => void;
  // Blank text removes the note (main's setNote). Resolves to whether it was
  // saved; on success the caller closes the dialog.
  onSave: (text: string) => Promise<boolean>;
}

// From this many characters on, the dialog shows how many are left.
const COUNT_FROM = NOTE_MAX_LENGTH - 300;

export function NoteDialog({ sessionName, initialText, onClose, onSave }: NoteDialogProps) {
  const [text, setText] = useState(initialText);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const caretPlaced = useRef(false);
  const hadNote = initialText !== "";
  const blank = text.trim() === "";
  // A blank new note has nothing to save; a blank edit removes the note.
  const canSave = hadNote || !blank;
  const changed = text !== initialText;

  useEffect(() => {
    const keepFocus = (e: FocusEvent) => {
      if (e.target instanceof Node && dialogRef.current?.contains(e.target)) return;
      textRef.current?.focus();
    };
    document.addEventListener("focusin", keepFocus);
    return () => document.removeEventListener("focusin", keepFocus);
  }, []);

  const save = async () => {
    if (!canSave || saving) return;
    setSaving(true);
    setFailed(false);
    const saved = await onSave(text);
    // On success the dialog is gone by now.
    if (!saved) {
      setSaving(false);
      setFailed(true);
    }
  };

  return (
    <div
      className="dialog-overlay"
      // A stray click outside doesn't throw away what was typed: it closes only
      // while nothing has changed.
      onClick={() => {
        if (!changed && !saving) onClose();
      }}
      // A click on the backdrop would take the focus to the page behind it.
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) e.preventDefault();
      }}
    >
      <div
        ref={dialogRef}
        className="dialog note-dialog"
        role="dialog"
        aria-label={`Note on ${sessionName}`}
        onClick={(e) => e.stopPropagation()}
        // On the whole dialog, so the keys work from its buttons too.
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void save();
          } else if (e.key === "Escape") {
            // Its Esc only: an open diff window listens for Esc on the document.
            e.preventDefault();
            e.stopPropagation();
            if (!saving) onClose();
          } else if (e.key === "Tab") {
            e.preventDefault();
            const fields = [
              ...e.currentTarget.querySelectorAll<HTMLElement>("textarea, button:not(:disabled)"),
            ];
            const at = fields.indexOf(document.activeElement as HTMLElement);
            const step = e.shiftKey ? -1 : 1;
            fields[(at + step + fields.length) % fields.length]?.focus();
          }
        }}
      >
        <h3 className="dialog-title">Note on “{sessionName}”</h3>
        <div className="dialog-field">
          <label htmlFor="note-dialog-text">
            For you, not the agent. It stays until you click Got it.
          </label>
          <textarea
            ref={textRef}
            id="note-dialog-text"
            className="dialog-input note-dialog-text"
            value={text}
            maxLength={NOTE_MAX_LENGTH}
            // What was sent is what is saved: no typing past it while it goes.
            readOnly={saving}
            rows={6}
            placeholder="What to do next here, what not to forget"
            spellCheck={false}
            autoFocus
            onFocus={(e) => {
              // At the end, ready to add a line, rather than over the old text.
              // Only on opening: later the caret stays where the builder put it.
              if (caretPlaced.current) return;
              caretPlaced.current = true;
              const end = e.currentTarget.value.length;
              e.currentTarget.setSelectionRange(end, end);
            }}
            onChange={(e) => setText(e.target.value)}
          />
          {failed && (
            <div className="note-dialog-error" role="alert">
              Could not save the note. Your text is still here; try again.
            </div>
          )}
          {text.length >= COUNT_FROM && (
            <div className="note-dialog-count">
              {(NOTE_MAX_LENGTH - text.length).toLocaleString()} characters left
            </div>
          )}
        </div>
        <div className="dialog-actions">
          <span className="note-dialog-hint">⌘↩ to save</span>
          <button className="dialog-btn cancel" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button
            className="dialog-btn primary"
            onClick={() => void save()}
            disabled={!canSave || saving}
          >
            {hadNote && blank ? "Remove note" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
