import { useEffect, useState } from "react";
import type { SyntheticEvent } from "react";
import type { GitStatus, GitFileEntry } from "../../shared/types";

const POLL_INTERVAL_MS = 5000;
const MAX_FILES = 50;

interface GitSectionProps {
  instanceId: string;
  cwd: string;
  active: boolean;
  onPreviewInView: (path: string) => void;
}

// A file is previewable in the Markdown View if it's a markdown document.
// Case-insensitive, mirrors the read-file IPC's extension gate.
function isMarkdown(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.endsWith(".md") || lower.endsWith(".markdown");
}

export function GitSection({
  instanceId,
  cwd,
  active,
  onPreviewInView,
}: GitSectionProps) {
  const [status, setStatus] = useState<GitStatus | null>(null);

  useEffect(() => {
    if (!active) return;

    let cancelled = false;

    const fetchOnce = async () => {
      const result = await window.electronAPI.getGitStatus(instanceId);
      if (!cancelled) setStatus(result);
    };

    fetchOnce();
    const interval = setInterval(fetchOnce, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [instanceId, active]);

  if (!active) return null;

  if (status === null) {
    return <div className="git-section-placeholder">Loading…</div>;
  }

  if (!status.available) {
    return <div className="git-section-placeholder">Not a git repository</div>;
  }

  const totalFiles =
    status.newFiles.length +
    status.modifiedFiles.length +
    status.stagedFiles.length;
  const tooMany = totalFiles > MAX_FILES;

  return (
    <div className="git-section">
      <div className="git-row git-branch-row">
        <span className="git-label">Branch</span>
        <span className="git-branch">{status.branch}</span>
      </div>
      <div className="git-row">
        <span className="git-label">Files</span>
        <span className="git-counts">
          <span className="git-count git-count-new">new {status.untracked}</span>
          <span className="git-count git-count-modified">
            modified {status.unstaged}
          </span>
          <span className="git-count git-count-staged">
            staged {status.staged}
          </span>
        </span>
      </div>
      <div className="git-row">
        <span className="git-label">Remote</span>
        <span className="git-remote">
          ↑ {status.ahead} &nbsp; ↓ {status.behind}
        </span>
      </div>

      {totalFiles > 0 && (
        <div className="git-files">
          {tooMany ? (
            <div className="git-files-too-many">
              Too many files ({totalFiles})… open in your editor
            </div>
          ) : (
            <>
              <FileGroup
                title="New"
                files={status.newFiles}
                cwd={cwd}
                kind="new"
                onPreviewInView={onPreviewInView}
              />
              <FileGroup
                title="Modified"
                files={status.modifiedFiles}
                cwd={cwd}
                kind="modified"
                onPreviewInView={onPreviewInView}
              />
              <FileGroup
                title="Staged"
                files={status.stagedFiles}
                cwd={cwd}
                kind="staged"
                onPreviewInView={onPreviewInView}
              />
            </>
          )}
        </div>
      )}
    </div>
  );
}

interface FileGroupProps {
  title: string;
  files: GitFileEntry[];
  cwd: string;
  kind: "new" | "modified" | "staged";
  onPreviewInView: (path: string) => void;
}

function FileGroup({ title, files, cwd, kind, onPreviewInView }: FileGroupProps) {
  if (files.length === 0) return null;

  return (
    <div className="git-file-group">
      <div className="git-file-group-title">{title}</div>
      {files.map((file) => (
        <FileRow
          key={`${kind}:${file.path}`}
          file={file}
          cwd={cwd}
          onPreviewInView={onPreviewInView}
        />
      ))}
    </div>
  );
}

function FileRow({
  file,
  cwd,
  onPreviewInView,
}: {
  file: GitFileEntry;
  cwd: string;
  onPreviewInView: (path: string) => void;
}) {
  const slashIdx = file.path.lastIndexOf("/");
  const dir = slashIdx >= 0 ? file.path.slice(0, slashIdx) : "";
  const name = slashIdx >= 0 ? file.path.slice(slashIdx + 1) : file.path;
  const codeLetter = displayCode(file.code);
  const absPath = `${cwd}/${file.path}`;
  const previewable = isMarkdown(file.path);

  const handleClick = () => {
    window.electronAPI.openInVSCode(absPath);
  };

  // Open the file in the Markdown View. stopPropagation so it doesn't also
  // fire the row's open-in-VS-Code click. keydown mirror keeps it keyboard-
  // reachable despite living inside the row button (a nested <button> would be
  // invalid HTML, so this is a role="button" span).
  const handlePreview = (e: SyntheticEvent) => {
    e.stopPropagation();
    onPreviewInView(absPath);
  };

  return (
    <button
      type="button"
      className="git-file-row"
      onClick={handleClick}
      title={file.path}
    >
      <span className="git-file-name">{name}</span>
      {dir && <span className="git-file-dir">{dir}</span>}
      {previewable && (
        <span
          className="git-file-view"
          role="button"
          tabIndex={0}
          title="Preview in View"
          onClick={handlePreview}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") handlePreview(e);
          }}
        >
          View
        </span>
      )}
      <span className={`git-file-code git-file-code-${codeLetter}`}>
        {codeLetter}
      </span>
    </button>
  );
}

function displayCode(code: string): string {
  // Normalize: '?' (untracked) -> 'U'; otherwise show the raw letter (M/D/A/R/C)
  if (code === "?") return "U";
  return code.toUpperCase();
}
