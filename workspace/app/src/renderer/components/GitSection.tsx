import { useEffect, useState } from "react";
import type {
  DiffSide,
  GitStatus,
  GitFileEntry,
} from "../../shared/types";

const POLL_INTERVAL_MS = 5000;
const MAX_FILES = 50;

interface GitSectionProps {
  instanceId: string;
  cwd: string;
  active: boolean;
  onPreviewInView: (path: string) => void;
  // Open the diff overlay for one file. `relPath` stays repo-relative — the main
  // process refuses anything that isn't.
  onViewDiff: (relPath: string, side: DiffSide) => void;
}

// A file is previewable in the Markdown View if it's a markdown document.
// Case-insensitive, mirrors the read-file IPC's extension gate.
function isMarkdown(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.endsWith(".md") || lower.endsWith(".markdown");
}

// Which comparison a group's rows are about: a New row has nothing to compare
// against, Modified is the unstaged change, Staged is what's in the index.
const SIDE_FOR_KIND: Record<FileGroupKind, DiffSide> = {
  new: "untracked",
  modified: "unstaged",
  staged: "staged",
};

type FileGroupKind = "new" | "modified" | "staged";

export function GitSection({
  instanceId,
  cwd,
  active,
  onPreviewInView,
  onViewDiff,
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
                onViewDiff={onViewDiff}
              />
              <FileGroup
                title="Modified"
                files={status.modifiedFiles}
                cwd={cwd}
                kind="modified"
                onPreviewInView={onPreviewInView}
                onViewDiff={onViewDiff}
              />
              <FileGroup
                title="Staged"
                files={status.stagedFiles}
                cwd={cwd}
                kind="staged"
                onPreviewInView={onPreviewInView}
                onViewDiff={onViewDiff}
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
  kind: FileGroupKind;
  onPreviewInView: (path: string) => void;
  onViewDiff: (relPath: string, side: DiffSide) => void;
}

function FileGroup({
  title,
  files,
  cwd,
  kind,
  onPreviewInView,
  onViewDiff,
}: FileGroupProps) {
  if (files.length === 0) return null;

  return (
    <div className="git-file-group">
      <div className="git-file-group-title">{title}</div>
      {files.map((file) => (
        <FileRow
          key={`${kind}:${file.path}`}
          file={file}
          cwd={cwd}
          side={SIDE_FOR_KIND[kind]}
          onPreviewInView={onPreviewInView}
          onViewDiff={onViewDiff}
        />
      ))}
    </div>
  );
}

/**
 * One changed file, with its two destinations as explicit tags rather than a
 * whole-row click: `View` shows the diff without leaving the app, `Go To` hands
 * the file to VS Code. Markdown files keep their renderer preview as `MD`.
 */
function FileRow({
  file,
  cwd,
  side,
  onPreviewInView,
  onViewDiff,
}: {
  file: GitFileEntry;
  cwd: string;
  side: DiffSide;
  onPreviewInView: (path: string) => void;
  onViewDiff: (relPath: string, side: DiffSide) => void;
}) {
  const slashIdx = file.path.lastIndexOf("/");
  const dir = slashIdx >= 0 ? file.path.slice(0, slashIdx) : "";
  const name = slashIdx >= 0 ? file.path.slice(slashIdx + 1) : file.path;
  const codeLetter = displayCode(file.code);
  const absPath = `${cwd}/${file.path}`;
  const previewable = isMarkdown(file.path);

  return (
    <div className="git-file-row" title={file.path}>
      <span className="git-file-name">{name}</span>
      {dir && <span className="git-file-dir">{dir}</span>}
      <span className="git-file-tags">
        {previewable && (
          <button
            type="button"
            className="git-file-tag git-file-tag-md"
            title="Render in the View section"
            onClick={() => onPreviewInView(absPath)}
          >
            MD
          </button>
        )}
        <button
          type="button"
          className="git-file-tag git-file-tag-view"
          title="Show the diff"
          onClick={() => onViewDiff(file.path, side)}
        >
          View
        </button>
        <button
          type="button"
          className="git-file-tag git-file-tag-goto"
          // The instance cwd as project root so VS Code opens/focuses the project
          // window and reveals the file inside it, rather than dropping the file
          // into whatever window is frontmost.
          title="Open in VS Code"
          onClick={() => window.electronAPI.openInVSCode(absPath, cwd)}
        >
          Go To
        </button>
      </span>
      <span className={`git-file-code git-file-code-${codeLetter}`}>
        {codeLetter}
      </span>
    </div>
  );
}

function displayCode(code: string): string {
  // Normalize: '?' (untracked) -> 'U'; otherwise show the raw letter (M/D/A/R/C)
  if (code === "?") return "U";
  return code.toUpperCase();
}
