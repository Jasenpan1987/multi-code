import { useEffect, useRef, useState } from "react";
import { diffErrorMessage, offersEditorFallback } from "./diffErrors";
import type { DiffRow, DiffSide, FileDiff } from "../../shared/types";

interface DiffOverlayProps {
  instanceId: string;
  cwd: string;
  relPath: string;
  side: DiffSide;
  onClose: () => void;
}

// Header wording before the diff has loaded, and for the states where there is
// no diff to report one. getFileDiff returns the same strings on success.
const SIDE_LABEL: Record<DiffSide, string> = {
  unstaged: "working tree vs index",
  staged: "index vs HEAD",
  untracked: "new file",
};

/**
 * A read-only, full-window view of one file's diff.
 *
 * Read-only is the point, not a default: it is what makes this safe to open on a
 * repo an agent is actively writing to, so nothing here issues a write of any
 * kind.
 */
export function DiffOverlay({
  instanceId,
  cwd,
  relPath,
  side,
  onClose,
}: DiffOverlayProps) {
  // null while the diff is in flight.
  const [diff, setDiff] = useState<FileDiff | null>(null);

  // Whether the press that started this click landed on the backdrop. A drag that
  // selects text inside the panel and releases outside it dispatches its click on
  // the backdrop (the common ancestor), which would otherwise close the overlay
  // mid-copy.
  const pressedBackdropRef = useRef(false);

  // Fetched once per file. Deliberately not tied to the Git section's 5s poll —
  // the overlay is a snapshot of the moment it was opened, and re-rendering
  // underneath someone reading it would move the lines they are looking at.
  useEffect(() => {
    let cancelled = false;
    setDiff(null);
    window.electronAPI
      .getFileDiff(instanceId, relPath, side)
      .then((result) => {
        if (!cancelled) setDiff(result);
      })
      .catch(() => {
        if (!cancelled) {
          setDiff({ ok: false, reason: "failed", detail: "IPC failed" });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [instanceId, relPath, side]);

  // Esc closes. On document rather than the panel so it works before anything
  // inside has been focused.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const renamed =
    diff?.ok === true && diff.oldPath !== diff.newPath
      ? `${diff.oldPath} → ${diff.newPath}`
      : null;

  return (
    <div
      className="diff-overlay-backdrop"
      onMouseDown={(e) => {
        pressedBackdropRef.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && pressedBackdropRef.current) {
          onClose();
        }
      }}
    >
      <div
        className="diff-overlay"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <div className="diff-overlay-header">
          <span className="diff-overlay-path" title={`${cwd}/${relPath}`}>
            {renamed ?? relPath}
          </span>
          <span className="diff-overlay-comparison">
            {diff?.ok === true ? diff.comparison : SIDE_LABEL[side]}
          </span>
          <button
            type="button"
            className="diff-overlay-close"
            onClick={onClose}
            title="Close (Esc)"
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <DiffBody diff={diff} cwd={cwd} relPath={relPath} />
      </div>
    </div>
  );
}

function DiffBody({
  diff,
  cwd,
  relPath,
}: {
  diff: FileDiff | null;
  cwd: string;
  relPath: string;
}) {
  if (diff === null) {
    return <div className="diff-overlay-note">Loading…</div>;
  }

  // No columns for a state that has no diff — and no stale rows either, since the
  // overlay remounts per file.
  if (!diff.ok) {
    return (
      <div className="diff-overlay-note">
        <span>{diffErrorMessage(diff.reason, diff.detail)}</span>
        {offersEditorFallback(diff.reason) && (
          <button
            type="button"
            className="diff-overlay-note-action"
            onClick={() =>
              window.electronAPI.openInVSCode(`${cwd}/${relPath}`, cwd)
            }
          >
            Go To
          </button>
        )}
      </div>
    );
  }

  // Body and footer are siblings so the footer stays put while the diff scrolls.
  return (
    <>
      <div className="diff-overlay-body">
        <div className="diff-grid">
          {diff.rows.map((row, i) => (
            <DiffGridRow key={i} row={row} />
          ))}
        </div>
      </div>
      {diff.truncated && (
        <div className="diff-overlay-footer">
          Showing the first {diff.rows.length} lines.
        </div>
      )}
    </>
  );
}

/**
 * One line of the file across both versions. Four cells so every row lines up
 * structurally in the grid — alignment can't drift the way two scroll containers
 * kept in sync by script can.
 */
function DiffGridRow({ row }: { row: DiffRow }) {
  const leftFilled = row.oldText !== null;
  const rightFilled = row.newText !== null;
  // What tints each side: a deletion is only on the left, an addition only on the
  // right, a replacement is both.
  const leftKind = row.kind === "replace" ? "del" : row.kind;
  const rightKind = row.kind === "replace" ? "add" : row.kind;

  // Line numbers are drawn by CSS from data-line rather than being text nodes:
  // generated content can't end up in a selection, so copying code out of the
  // diff yields the code. `user-select: none` alone doesn't achieve that.
  return (
    <>
      <span
        className="diff-gutter"
        data-kind={leftFilled ? leftKind : "empty"}
        data-line={row.oldLine ?? ""}
      />
      <span className="diff-text" data-kind={leftFilled ? leftKind : "empty"}>
        {row.oldText ?? ""}
      </span>
      <span
        className="diff-gutter"
        data-kind={rightFilled ? rightKind : "empty"}
        data-line={row.newLine ?? ""}
      />
      <span className="diff-text" data-kind={rightFilled ? rightKind : "empty"}>
        {row.newText ?? ""}
      </span>
    </>
  );
}
