import { useEffect, useState } from "react";
import type { BackendName } from "../../shared/types";

const LAST_BACKEND_KEY = "multicode.lastBackend";

function readLastBackend(): BackendName {
  const stored = window.localStorage.getItem(LAST_BACKEND_KEY);
  return stored === "opencode" ? "opencode" : "claude";
}

interface NewInstanceDialogProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (cwd: string, alias?: string, backend?: BackendName) => void;
}

export function NewInstanceDialog({
  open,
  onClose,
  onSubmit,
}: NewInstanceDialogProps) {
  const [path, setPath] = useState("");
  const [alias, setAlias] = useState("");
  const [backend, setBackend] = useState<BackendName>("claude");
  const [error, setError] = useState("");
  const [showDuplicateWarning, setShowDuplicateWarning] = useState(false);
  const [opencodeMissing, setOpencodeMissing] = useState(false);

  useEffect(() => {
    if (open) setBackend(readLastBackend());
  }, [open]);

  // Check opencode availability when dialog is open and opencode is selected
  useEffect(() => {
    if (!open) return;
    if (backend !== "opencode") {
      setOpencodeMissing(false);
      return;
    }
    let cancelled = false;
    window.electronAPI.isBackendAvailable("opencode").then((ok) => {
      if (!cancelled) setOpencodeMissing(!ok);
    });
    return () => {
      cancelled = true;
    };
  }, [open, backend]);

  // Re-check duplicate when path or backend changes
  useEffect(() => {
    if (!open || !path.trim()) {
      setShowDuplicateWarning(false);
      return;
    }
    let cancelled = false;
    window.electronAPI
      .hasRunningInstanceAt(path.trim(), backend)
      .then((dup) => {
        if (!cancelled) setShowDuplicateWarning(dup);
      });
    return () => {
      cancelled = true;
    };
  }, [open, path, backend]);

  if (!open) return null;

  const handleBrowse = async () => {
    const dir = await window.electronAPI.selectDirectory();
    if (dir) {
      setPath(dir);
      setError("");
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
    window.localStorage.setItem(LAST_BACKEND_KEY, backend);
    onSubmit(path.trim(), alias.trim() || undefined, backend);
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
          <label>Backend</label>
          <div className="backend-options">
            <label className="backend-option">
              <input
                type="radio"
                name="backend"
                value="claude"
                checked={backend === "claude"}
                onChange={() => setBackend("claude")}
              />
              Claude Code
            </label>
            <label className="backend-option">
              <input
                type="radio"
                name="backend"
                value="opencode"
                checked={backend === "opencode"}
                onChange={() => setBackend("opencode")}
              />
              OpenCode
            </label>
          </div>
          {opencodeMissing && (
            <div className="dialog-warning">
              <code>opencode</code> not found on PATH. The instance will fail
              to start. Install OpenCode CLI first, or pick Claude Code.
            </div>
          )}
        </div>

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
            An instance with this backend is already running in this directory.
            Please provide an alias.
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
