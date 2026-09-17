import { memo, useEffect, useRef, useState } from "react";
import { diffErrorMessage, offersEditorFallback } from "./diffErrors";
import { refForRange } from "./diffRef";
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
  // Selected rows, by row index rather than line number — a deleted row has no
  // new-version line number, so an index is the only thing every row has.
  const [selection, setSelection] = useState<{
    anchor: number;
    head: number;
  } | null>(null);
  const draggingRef = useRef(false);

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

  // A drag can end anywhere, including outside the panel, so the release is
  // caught on the window rather than on the grid.
  useEffect(() => {
    const onUp = () => {
      draggingRef.current = false;
    };
    window.addEventListener("mouseup", onUp);
    return () => window.removeEventListener("mouseup", onUp);
  }, []);

  const renamed =
    diff?.ok === true && diff.oldPath !== diff.newPath
      ? `${diff.oldPath} → ${diff.newPath}`
      : null;

  const rows = diff?.ok === true ? diff.rows : [];
  const selectedLo = selection
    ? Math.min(selection.anchor, selection.head)
    : -1;
  const selectedHi = selection
    ? Math.max(selection.anchor, selection.head)
    : -1;
  const reference =
    selection && rows.length > 0
      ? refForRange(rows, selectedLo, selectedHi, relPath)
      : null;

  // Line selection deliberately does not preventDefault: the browser's own text
  // selection has to keep working, because copying code out of the diff matters
  // as much as pointing the agent at it.
  const onGridMouseDown = (e: React.MouseEvent) => {
    const index = rowIndexFromEvent(e);
    if (index === null) return;
    if (e.shiftKey && selection) {
      setSelection({ anchor: selection.anchor, head: index });
      return;
    }
    // Clicking the one selected row clears the selection.
    if (selection && selection.anchor === index && selection.head === index) {
      setSelection(null);
      return;
    }
    setSelection({ anchor: index, head: index });
    draggingRef.current = true;
  };

  const onGridMouseMove = (e: React.MouseEvent) => {
    if (!draggingRef.current) return;
    const index = rowIndexFromEvent(e);
    if (index === null) return;
    // Moving within the same row changes nothing; skipping the state update keeps
    // a drag across a long file from re-rendering on every pixel.
    setSelection((prev) =>
      prev === null || prev.head === index ? prev : { ...prev, head: index }
    );
  };

  const onGridMouseUp = () => {
    draggingRef.current = false;
  };

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
        {reference && (
          <div className="diff-overlay-refbar">
            <code className="diff-overlay-ref">{reference.ref}</code>
            {reference.fellBack && (
              <span className="diff-overlay-ref-note">
                nearest line — the selected lines were removed
              </span>
            )}
          </div>
        )}
        <DiffBody
          diff={diff}
          cwd={cwd}
          relPath={relPath}
          selectedLo={selectedLo}
          selectedHi={selectedHi}
          onGridMouseDown={onGridMouseDown}
          onGridMouseMove={onGridMouseMove}
          onGridMouseUp={onGridMouseUp}
        />
      </div>
    </div>
  );
}

function DiffBody({
  diff,
  cwd,
  relPath,
  selectedLo,
  selectedHi,
  onGridMouseDown,
  onGridMouseMove,
  onGridMouseUp,
}: {
  diff: FileDiff | null;
  cwd: string;
  relPath: string;
  selectedLo: number;
  selectedHi: number;
  onGridMouseDown: (e: React.MouseEvent) => void;
  onGridMouseMove: (e: React.MouseEvent) => void;
  onGridMouseUp: () => void;
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
        <div
          className="diff-grid"
          onMouseDown={onGridMouseDown}
          onMouseMove={onGridMouseMove}
          onMouseUp={onGridMouseUp}
        >
          {diff.rows.map((row, i) => (
            <DiffGridRow
              key={i}
              index={i}
              row={row}
              selected={i >= selectedLo && i <= selectedHi}
            />
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

/** The row a mouse event landed on, or null if it missed the cells. */
function rowIndexFromEvent(e: React.MouseEvent): number | null {
  const el = (e.target as HTMLElement).closest<HTMLElement>("[data-row]");
  if (!el) return null;
  const raw = el.dataset.row;
  if (raw === undefined) return null;
  const index = Number.parseInt(raw, 10);
  return Number.isNaN(index) ? null : index;
}

/**
 * One line of the file across both versions. Four cells so every row lines up
 * structurally in the grid — alignment can't drift the way two scroll containers
 * kept in sync by script can.
 */
const DiffGridRow = memo(function DiffGridRow({
  index,
  row,
  selected,
}: {
  index: number;
  row: DiffRow;
  selected: boolean;
}) {
  const leftFilled = row.oldText !== null;
  const rightFilled = row.newText !== null;
  // What tints each side: a deletion is only on the left, an addition only on the
  // right, a replacement is both.
  const leftKind = row.kind === "replace" ? "del" : row.kind;
  const rightKind = row.kind === "replace" ? "add" : row.kind;
  const sel = selected ? "true" : undefined;

  // Line numbers are drawn by CSS from data-line rather than being text nodes:
  // generated content can't end up in a selection, so copying code out of the
  // diff yields the code. `user-select: none` alone doesn't achieve that.
  return (
    <>
      <span
        className="diff-gutter"
        data-row={index}
        data-selected={sel}
        data-kind={leftFilled ? leftKind : "empty"}
        data-line={row.oldLine ?? ""}
      />
      <span
        className="diff-text"
        data-row={index}
        data-selected={sel}
        data-kind={leftFilled ? leftKind : "empty"}
      >
        {row.oldText ?? ""}
      </span>
      <span
        className="diff-gutter"
        data-row={index}
        data-selected={sel}
        data-kind={rightFilled ? rightKind : "empty"}
        data-line={row.newLine ?? ""}
      />
      <span
        className="diff-text"
        data-row={index}
        data-selected={sel}
        data-kind={rightFilled ? rightKind : "empty"}
      >
        {row.newText ?? ""}
      </span>
    </>
  );
});
