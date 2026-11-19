import type { SessionNote } from "../../shared/types";
import { firstLine, formatNoteTime } from "./sessionNotes";

// The two places a note shows besides its row (docs/specs/session-notes): the bar
// above the selected session's terminal (Story 2), and the startup bar at the top
// of the window, once per start (Story 4).

interface NoteBarProps {
  note: SessionNote;
  onEdit: () => void;
  // Got it: clears the note.
  onDone: () => void;
}

export function NoteBar({ note, onEdit, onDone }: NoteBarProps) {
  return (
    <section className="note-bar" aria-label="Your note on this session">
      <div className="note-bar-head">
        <span className="note-bar-title">✎ Your note</span>
        <span className="note-bar-time">{formatNoteTime(note.writtenAt)}</span>
        <span className="note-bar-actions">
          <button type="button" className="note-bar-btn" onClick={onEdit}>
            Edit
          </button>
          <button
            type="button"
            className="note-bar-btn primary"
            onClick={onDone}
            title="Clear this note"
          >
            Got it
          </button>
        </span>
      </div>
      {/* Its own scroll past a few lines, so a long note leaves the terminal room. */}
      <div className="note-bar-text">{note.text}</div>
    </section>
  );
}

export interface StartupNote {
  id: string;
  name: string;
  note: SessionNote;
}

interface StartupNotesBarProps {
  notes: StartupNote[];
  onOpen: (id: string) => void;
  onClose: () => void;
}

export function StartupNotesBar({ notes, onOpen, onClose }: StartupNotesBarProps) {
  return (
    <section className="startup-notes-bar" aria-label="Notes you left">
      <div className="startup-notes-head">
        <span className="startup-notes-title">✎ Notes you left</span>
        <button
          type="button"
          className="startup-notes-close"
          onClick={onClose}
          title="Hide until the next start. The notes stay."
          aria-label="Hide the notes you left until the next start"
        >
          ×
        </button>
      </div>
      <ul className="startup-notes-list">
        {notes.map(({ id, name, note }) => (
          <li key={id}>
            <button type="button" className="startup-notes-item" onClick={() => onOpen(id)}>
              <span className="startup-notes-name">{name}</span>
              <span className="startup-notes-line">{firstLine(note.text)}</span>
              <span className="startup-notes-time">{formatNoteTime(note.writtenAt)}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
