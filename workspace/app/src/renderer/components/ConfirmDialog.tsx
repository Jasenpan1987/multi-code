// Asks before a context-menu action runs (Duplicate, Remove), because a slip of
// the mouse in that menu used to act at once.
//
// For a dangerous action, Cancel has the focus, so Enter does nothing harmful.
// Esc and a click outside also cancel.

interface ConfirmDialogProps {
  title: string;
  message: string;
  confirmLabel: string;
  // Red confirm button, and Cancel takes the focus instead of it.
  danger?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  danger = false,
  onConfirm,
  onClose,
}: ConfirmDialogProps) {
  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div
        className="dialog confirm-dialog"
        role="alertdialog"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          } else if (e.key === "Tab") {
            // Round the two buttons only. Past the last one, Tab would reach the
            // page behind, the terminal included, and the next Enter with it.
            e.preventDefault();
            const buttons = [...e.currentTarget.querySelectorAll("button")];
            const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
            const step = e.shiftKey ? -1 : 1;
            buttons[(at + step + buttons.length) % buttons.length]?.focus();
          }
        }}
      >
        <h3 className="dialog-title">{title}</h3>
        <p className="confirm-message">{message}</p>
        <div className="dialog-actions">
          <button className="dialog-btn cancel" onClick={onClose} autoFocus={danger}>
            Cancel
          </button>
          <button
            className={`dialog-btn ${danger ? "danger" : "primary"}`}
            onClick={() => {
              onConfirm();
              onClose();
            }}
            autoFocus={!danger}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
