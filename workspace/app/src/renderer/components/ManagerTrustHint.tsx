// One-time warning shown right after the manager is created, because the CLI's
// workspace-trust dialog defaults to the answer that kills it. See
// managerTrustHint.ts for the reproduction and the text.
//
// Reuses the existing `.dialog*` classes rather than introducing a second modal
// style.

import {
  TRUST_DIALOG_OPTIONS,
  TRUST_DIALOG_QUESTION,
  TRUST_HINT_PARAGRAPHS,
  TRUST_HINT_TITLE,
} from "./managerTrustText";

interface ManagerTrustHintProps {
  open: boolean;
  onClose: () => void;
}

export function ManagerTrustHint({ open, onClose }: ManagerTrustHintProps) {
  if (!open) return null;

  const [intro, pick, warning, reassurance] = TRUST_HINT_PARAGRAPHS;

  return (
    <div className="dialog-overlay">
      <div className="dialog">
        <div className="dialog-title">{TRUST_HINT_TITLE}</div>

        <p className="trust-hint-text">{intro}</p>

        {/* Rendered as the terminal shows it, so the user is matching a picture
            rather than a description. The arrow marks the highlighted default. */}
        <pre className="trust-hint-dialog">
          {TRUST_DIALOG_QUESTION}
          {"\n"}
          {TRUST_DIALOG_OPTIONS.map((option, i) => (
            <span key={option} data-default={i === 0 ? "true" : "false"}>
              {i === 0 ? "❯ " : "  "}
              {option}
              {"\n"}
            </span>
          ))}
        </pre>

        <p className="trust-hint-text">{pick}</p>
        <div className="dialog-warning">{warning}</div>
        <p className="trust-hint-text trust-hint-muted">{reassurance}</p>

        <div className="dialog-actions">
          <button className="dialog-btn primary" onClick={onClose} autoFocus>
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}
