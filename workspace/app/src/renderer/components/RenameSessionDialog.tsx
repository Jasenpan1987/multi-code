import { useState } from "react";

interface RenameSessionDialogProps {
  open: boolean;
  // Backend label ("Claude Code" / "OpenCode") shown in the dialog so it's
  // clear which agent's session is being renamed.
  backendLabel: string;
  onClose: () => void;
  onSubmit: (name: string) => void;
}

export function RenameSessionDialog({
  open,
  backendLabel,
  onClose,
  onSubmit,
}: RenameSessionDialogProps) {
  const [name, setName] = useState("");

  if (!open) return null;

  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    onSubmit(trimmed);
    setName("");
  };

  const close = () => {
    setName("");
    onClose();
  };

  return (
    <div className="dialog-overlay" onClick={close}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h3 className="dialog-title">Rename Session</h3>

        <div className="dialog-field">
          <label>New name for the {backendLabel} session</label>
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
            placeholder="e.g. auth-refactor"
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
            disabled={!name.trim()}
          >
            Rename
          </button>
        </div>
      </div>
    </div>
  );
}
