import { useState } from "react";

interface NewInstanceDialogProps {
  open: boolean;
  duplicateWarning: boolean;
  onClose: () => void;
  onSubmit: (cwd: string, alias?: string) => void;
}

export function NewInstanceDialog({
  open,
  duplicateWarning,
  onClose,
  onSubmit,
}: NewInstanceDialogProps) {
  const [path, setPath] = useState("");
  const [alias, setAlias] = useState("");
  const [error, setError] = useState("");
  const [showDuplicateWarning, setShowDuplicateWarning] =
    useState(duplicateWarning);

  if (!open) return null;

  const handleBrowse = async () => {
    const dir = await window.electronAPI.selectDirectory();
    if (dir) {
      setPath(dir);
      setError("");
      // Check if duplicate
      const hasDuplicate = await window.electronAPI.hasRunningInstanceAt(dir);
      setShowDuplicateWarning(hasDuplicate);
    }
  };

  const handleSubmit = () => {
    if (!path.trim()) {
      setError("Please select a project directory");
      return;
    }
    if (showDuplicateWarning && !alias.trim()) {
      setError("Alias is required when a duplicate instance exists");
      return;
    }
    onSubmit(path.trim(), alias.trim() || undefined);
    setPath("");
    setAlias("");
    setError("");
    setShowDuplicateWarning(false);
  };

  const handleClose = () => {
    setPath("");
    setAlias("");
    setError("");
    setShowDuplicateWarning(false);
    onClose();
  };

  return (
    <div className="dialog-overlay" onClick={handleClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h3 className="dialog-title">New Instance</h3>

        <div className="dialog-field">
          <label>Project Directory</label>
          <div className="path-input-row">
            <input
              type="text"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="/path/to/project"
              className="dialog-input"
            />
            <button className="browse-btn" onClick={handleBrowse}>
              Browse
            </button>
          </div>
        </div>

        {showDuplicateWarning && (
          <div className="dialog-warning">
            An instance is already running in this directory. Please provide an
            alias.
          </div>
        )}

        <div className="dialog-field">
          <label>
            Alias {showDuplicateWarning ? "(required)" : "(optional)"}
          </label>
          <input
            type="text"
            value={alias}
            onChange={(e) => setAlias(e.target.value)}
            placeholder="e.g. frontend, api-fix"
            className="dialog-input"
          />
        </div>

        {error && <div className="dialog-error">{error}</div>}

        <div className="dialog-actions">
          <button className="dialog-btn cancel" onClick={handleClose}>
            Cancel
          </button>
          <button className="dialog-btn primary" onClick={handleSubmit}>
            Create
          </button>
        </div>
      </div>
    </div>
  );
}
