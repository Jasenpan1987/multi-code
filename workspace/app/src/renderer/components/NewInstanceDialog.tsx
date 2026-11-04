import { useEffect, useRef, useState } from "react";
import {
  OPENCODE_UPGRADE_COMMAND,
  type BackendAvailability,
  type BackendName,
  type CloneProgress,
  type CloneResult,
  type TypedFolder,
} from "../../shared/types";
import { cloneUrlOf, folderNameProblem, repoNameOf } from "../../shared/gitUrl";

const LAST_BACKEND_KEY = "multicode.lastBackend";
const LAST_MODE_KEY = "multicode.lastNewMode";

// Open folder: a folder that exists (made, if need be, with the picker's New Folder).
// Clone from Git: a repo cloned into a folder the builder picks. Epic new-project.
type Mode = "open" | "clone";

function readLastBackend(): BackendName {
  const stored = window.localStorage.getItem(LAST_BACKEND_KEY);
  return stored === "opencode" ? "opencode" : "claude";
}

function readLastMode(): Mode {
  return window.localStorage.getItem(LAST_MODE_KEY) === "clone" ? "clone" : "open";
}

// Same words as main's NOT_A_FOLDER, for the folder it resolved.
const notAFolder = (path: string) =>
  `This folder does not exist: ${path}. To make a new one, use Browse, then New Folder.`;

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
  const [mode, setMode] = useState<Mode>("open");
  const [path, setPath] = useState("");
  const [alias, setAlias] = useState("");
  const [backend, setBackend] = useState<BackendName>("claude");
  const [error, setError] = useState("");
  const [showDuplicateWarning, setShowDuplicateWarning] = useState(false);
  // Whether OpenCode can start, while it's selected. A problem is a warning, not a
  // block, as a missing `opencode` always was: it can be installed or upgraded
  // before the contact's next start.
  const [opencode, setOpencode] = useState<BackendAvailability>({ ok: true });

  // Clone from Git. `checked` is what main found at a "Clone into"/<folder name>,
  // with the typed path it was asked about.
  const [url, setUrl] = useState("");
  const [parent, setParent] = useState("");
  const [folderName, setFolderName] = useState("");
  const [checked, setChecked] = useState<{ typed: string; folder: TypedFolder } | null>(null);
  const [cloning, setCloning] = useState(false);
  const [progress, setProgress] = useState<CloneProgress | null>(null);
  const [gitFailure, setGitFailure] = useState<{
    output: string;
    hint?: string;
    kept?: string;
  } | null>(null);
  const [notice, setNotice] = useState("");
  // One submission at a time (Create, Clone, Open it), from the click until the
  // session is asked for: a second click, Cancel or a mode change in between would
  // otherwise act on what the first one was still checking. The ref is the guard,
  // the state what the buttons show.
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setBackend(readLastBackend());
    setMode(readLastMode());
    let cancelled = false;
    // Unless the builder has typed one meanwhile.
    window.electronAPI.cloneDefaultParent().then((folder) => {
      if (!cancelled) setParent((typed) => typed || folder);
    });
    return () => {
      cancelled = true;
    };
  }, [open]);

  // Check opencode availability when dialog is open and opencode is selected
  useEffect(() => {
    if (!open) return;
    if (backend !== "opencode") {
      setOpencode({ ok: true });
      return;
    }
    let cancelled = false;
    window.electronAPI.backendAvailability("opencode").then((availability) => {
      if (!cancelled) setOpencode(availability);
    });
    return () => {
      cancelled = true;
    };
  }, [open, backend]);

  // Re-check duplicate when path or backend changes
  useEffect(() => {
    if (!open || mode !== "open" || !path.trim()) {
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
  }, [open, mode, path, backend]);

  // The folder git would make, and whether something is there already. Empty folder
  // name means the repo's, as `git clone <url>`.
  const cloneName = folderName.trim() || repoNameOf(url);
  const typedTarget =
    parent.trim() && cloneName ? `${parent.trim().replace(/\/+$/, "")}/${cloneName}` : null;
  useEffect(() => {
    if (!open || mode !== "clone" || typedTarget === null) {
      setChecked(null);
      return;
    }
    let cancelled = false;
    window.electronAPI.checkFolder(typedTarget).then((folder) => {
      if (!cancelled) setChecked({ typed: typedTarget, folder });
    });
    return () => {
      cancelled = true;
    };
    // `cloning`: a finished or cancelled clone changes what is at the target.
  }, [open, mode, typedTarget, cloning]);

  useEffect(() => {
    if (!open) return;
    return window.electronAPI.onCloneProgress(setProgress);
  }, [open]);

  if (!open) return null;

  const clearMessages = () => {
    setError("");
    setGitFailure(null);
    setNotice("");
  };

  const reset = () => {
    setPath("");
    setAlias("");
    setUrl("");
    setParent("");
    setFolderName("");
    setProgress(null);
    clearMessages();
    setShowDuplicateWarning(false);
  };

  const exclusive = async (run: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await run();
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  // Every way into a session: the folder exists, the alias rule holds.
  const startIn = async (folder: string, nextMode: Mode) => {
    const duplicate = await window.electronAPI.hasRunningInstanceAt(folder, backend);
    if (duplicate && !alias.trim()) {
      if (nextMode === "open") setShowDuplicateWarning(true);
      setError("Alias is required when a duplicate instance exists");
      return;
    }
    window.localStorage.setItem(LAST_BACKEND_KEY, backend);
    window.localStorage.setItem(LAST_MODE_KEY, nextMode);
    onSubmit(folder, alias.trim() || undefined, backend);
    reset();
  };

  const handleBrowse = async () => {
    const dir = await window.electronAPI.selectDirectory();
    if (dir) {
      setPath(dir);
      setError("");
    }
  };

  const handleBrowseParent = async () => {
    const dir = await window.electronAPI.selectDirectory(parent, "Choose where to clone");
    if (dir) {
      setParent(dir);
      clearMessages();
    }
  };

  const handleSubmit = () => exclusive(async () => {
    clearMessages();
    if (!path.trim()) {
      setError("Please select a project directory");
      return;
    }
    const folder = await window.electronAPI.checkFolder(path);
    if (folder.kind !== "directory") {
      setError(notAFolder(folder.path));
      return;
    }
    await startIn(folder.path, "open");
  });

  const handleClone = () => exclusive(async () => {
    clearMessages();
    if (!url.trim()) {
      setError("Paste a Git URL");
      return;
    }
    if (!cloneUrlOf(url)) {
      setError("This is not a Git URL. Paste an https:// link or an SSH link (git@…).");
      return;
    }
    const nameProblem = cloneName ? folderNameProblem(cloneName) : "Enter a folder name";
    if (nameProblem) {
      setError(nameProblem);
      return;
    }
    setProgress(null);
    setCloning(true);
    // A rejection would leave the dialog stuck at "Cloning…".
    const result: CloneResult = await window.electronAPI
      .cloneRepo(url, parent, folderName)
      .catch((err: unknown) => ({ kind: "refused", reason: String(err) }));
    setCloning(false);
    switch (result.kind) {
      case "done":
        await startIn(result.path, "clone");
        break;
      case "refused":
        setError(result.reason);
        break;
      case "failed":
        setGitFailure({
          output: result.output,
          hint: result.hint,
          kept: result.removed ? undefined : result.path,
        });
        break;
      case "cancelled":
        setNotice(
          result.removed
            ? `Clone cancelled. The partial folder ${result.path} was removed.`
            : `Clone cancelled. The partial folder ${result.path} could not be removed; delete it in Finder.`
        );
        break;
    }
  });

  const handleClose = () => {
    if (busyRef.current) return;
    reset();
    onClose();
  };

  // Only what was found at the path typed now: a check for an earlier name can't
  // turn Clone off or point Open it at the wrong folder.
  const target = checked && checked.typed === typedTarget ? checked.folder : null;
  const targetTaken = mode === "clone" && target !== null && target.kind !== "missing";

  return (
    <div className="dialog-overlay" onClick={handleClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h3 className="dialog-title">New Instance</h3>

        <div className="mode-tabs">
          {(["open", "clone"] as const).map((m) => (
            <button
              key={m}
              className={`mode-tab${mode === m ? " active" : ""}`}
              disabled={busy}
              onClick={() => {
                setMode(m);
                clearMessages();
              }}
            >
              {m === "open" ? "Open folder" : "Clone from Git"}
            </button>
          ))}
        </div>

        <div className="dialog-field">
          <label>Backend</label>
          <div className="backend-options">
            <label className="backend-option">
              <input
                type="radio"
                name="backend"
                value="claude"
                checked={backend === "claude"}
                disabled={busy}
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
                disabled={busy}
                onChange={() => setBackend("opencode")}
              />
              OpenCode
            </label>
          </div>
          {!opencode.ok && opencode.reason === "missing" && (
            <div className="dialog-warning">
              <code>opencode</code> not found on PATH. The instance will fail
              to start. Install OpenCode CLI first, or pick Claude Code.
            </div>
          )}
          {!opencode.ok && opencode.reason === "outdated" && (
            <div className="dialog-warning">
              OpenCode {opencode.version} found. Multi-Code needs
              OpenCode 2: run{" "}
              <code>{OPENCODE_UPGRADE_COMMAND}</code>
            </div>
          )}
        </div>

        {mode === "open" && (
          <>
            <div className="dialog-field">
              <label>Project Directory</label>
              <div className="path-input-row">
                <input
                  type="text"
                  value={path}
                  onChange={(e) => {
                    setPath(e.target.value);
                    setError("");
                  }}
                  placeholder="/path/to/project"
                  className="dialog-input"
                  disabled={busy}
                />
                <button className="browse-btn" disabled={busy} onClick={handleBrowse}>
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
          </>
        )}

        {mode === "clone" && (
          <>
            <div className="dialog-field">
              <label>Git URL</label>
              <input
                type="text"
                value={url}
                disabled={busy}
                onChange={(e) => {
                  setUrl(e.target.value);
                  clearMessages();
                }}
                placeholder="git@github.com:owner/repo.git or https://github.com/owner/repo"
                className="dialog-input full"
              />
            </div>
            <div className="dialog-field">
              <label>Clone into</label>
              <div className="path-input-row">
                <input
                  type="text"
                  value={parent}
                  disabled={busy}
                  onChange={(e) => {
                    setParent(e.target.value);
                    clearMessages();
                  }}
                  placeholder="/path/to/parent"
                  className="dialog-input"
                />
                <button className="browse-btn" disabled={busy} onClick={handleBrowseParent}>
                  Browse
                </button>
              </div>
            </div>
            <div className="dialog-field">
              <label>
                Folder name (optional, like the last argument of <code>git clone</code>)
              </label>
              <input
                type="text"
                value={folderName}
                disabled={busy}
                onChange={(e) => {
                  setFolderName(e.target.value);
                  clearMessages();
                }}
                placeholder={repoNameOf(url) || "the repo's name"}
                className="dialog-input full"
              />
              {target && <div className="target-path">→ {target.path}</div>}
            </div>

            {targetTaken && !cloning && (
              <div className="dialog-warning">
                {target.path} already exists.
                {target.kind === "directory" ? (
                  <>
                    {" "}Open it, or type another folder name.
                    <button
                      className="inline-btn"
                      disabled={busy}
                      onClick={() => {
                        clearMessages();
                        void exclusive(() => startIn(target.path, "clone"));
                      }}
                    >
                      Open it
                    </button>
                  </>
                ) : (
                  " Type another folder name."
                )}
              </div>
            )}

            {cloning && (
              <div className="clone-progress">
                {/* git's own first line already names the target. */}
                <div className="line">{progress?.line ?? "Starting git…"}</div>
                {progress?.percent != null && (
                  <div className="bar">
                    <div style={{ width: `${progress.percent}%` }} />
                  </div>
                )}
              </div>
            )}
          </>
        )}

        {notice && <div className="dialog-info">{notice}</div>}

        <div className="dialog-field">
          <label>
            Alias {showDuplicateWarning ? "(required)" : "(optional)"}{" "}
            <span className="dialog-hint">the session&apos;s name in the sidebar</span>
          </label>
          <input
            type="text"
            value={alias}
            disabled={busy}
            onChange={(e) => setAlias(e.target.value)}
            placeholder="e.g. frontend, api-fix"
            className="dialog-input full"
          />
        </div>

        {error && <div className="dialog-error">{error}</div>}
        {gitFailure && (
          <div className="dialog-error">
            {gitFailure.kept
              ? `git clone failed, and the partial folder ${gitFailure.kept} could not be removed; delete it in Finder. git said:`
              : "git clone failed. Nothing was kept. git said:"}
            <pre>{gitFailure.output}</pre>
            {gitFailure.hint}
          </div>
        )}

        <div className="dialog-actions">
          <button
            className="dialog-btn cancel"
            disabled={busy && !cloning}
            onClick={cloning ? () => void window.electronAPI.cancelClone() : handleClose}
          >
            {cloning ? "Cancel clone" : "Cancel"}
          </button>
          {mode === "open" ? (
            <button className="dialog-btn primary" disabled={busy} onClick={handleSubmit}>
              Create
            </button>
          ) : (
            <button
              className="dialog-btn primary"
              disabled={busy || targetTaken}
              onClick={handleClone}
            >
              {cloning ? "Cloning…" : "Clone"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
