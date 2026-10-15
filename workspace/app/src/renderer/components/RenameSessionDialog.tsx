import { useState } from "react";

interface RenameSessionDialogProps {
  open: boolean;
  title: string;
  // What is being renamed, e.g. "New name for the Claude Code session", so it's
  // clear which name changes: the agent's own session, or the contact's.
  label: string;
  // Prefilled and selected. The dialog keeps its own copy from mount on, so a
  // caller that prefills mounts it only while it is open.
  initialName?: string;
  placeholder?: string;
  // Lets a blank name through, for a caller where blank means "back to default".
  allowBlank?: boolean;
  onClose: () => void;
  onSubmit: (name: string) => void;
}

export function RenameSessionDialog({
  open,
  title,
  label,
  initialName = "",
  placeholder = "e.g. auth-refactor",
  allowBlank = false,
  onClose,
  onSubmit,
}: RenameSessionDialogProps) {
  const [name, setName] = useState(initialName);

  if (!open) return null;

  const canSubmit = allowBlank || name.trim() !== "";

  const submit = () => {
    if (!canSubmit) return;
    onSubmit(name.trim());
    setName("");
  };

  const close = () => {
    setName("");
    onClose();
  };

  return (
    <div className="dialog-overlay" onClick={close}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h3 className="dialog-title">{title}</h3>

        <div className="dialog-field">
          <label>{label}</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submit();
              } else if (e.key === "Escape") {
                e.preventDefault();
                close();
              }
            }}
            onFocus={(e) => e.currentTarget.select()}
            placeholder={placeholder}
            className="dialog-input"
            autoFocus
            spellCheck={false}
          />
        </div>

        <div className="dialog-actions">
          <button className="dialog-btn cancel" onClick={close}>
            Cancel
          </button>
          <button
            className="dialog-btn primary"
            onClick={submit}
            disabled={!canSubmit}
          >
            Rename
          </button>
        </div>
      </div>
    </div>
  );
}
