import { memo, useEffect, useMemo, useRef, useState } from "react";
import { diffErrorMessage, offersEditorFallback } from "./diffErrors";
import { overviewMarks } from "./diffOverview";
import { refForRange } from "./diffRef";
import type { DiffRow, DiffSide, FileDiff } from "../../shared/types";

interface DiffWindowProps {
  instanceId: string;
  cwd: string;
  relPath: string;
  side: DiffSide;
  // Only for a renamed file: git needs both sides in the pathspec to detect the
  // rename at all.
  oldPath?: string;
  // Whether the instance is running. The compose box only targets a running
  // instance, so "Ask agent" is disabled otherwise.
  running: boolean;
  onClose: () => void;
  onAskAgent: (ref: string) => void;
}

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

// Header wording before the diff has loaded, and for the states where there is
// no diff to report one. getFileDiff returns the same strings on success.
const SIDE_LABEL: Record<DiffSide, string> = {
  unstaged: "working tree vs index",
  staged: "index vs HEAD",
  untracked: "new file",
};

const MIN_WIDTH = 380;
const MIN_HEIGHT = 240;
// The app's own titlebar is a drag region; a window header overlapping it would
// move the whole Electron window instead of this one.
const MIN_TOP = 32;
// How much of the window must stay on screen, so it can always be grabbed back.
const KEEP_VISIBLE = 140;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function initialRect(): Rect {
  // Default position leaves the toolbox visible on the right and the compose box
  // clear at the bottom: the point of a movable window is being able to click the
  // next file while this one is open.
  return {
    left: 16,
    top: 40,
    width: Math.min(940, Math.round(window.innerWidth * 0.62)),
    height: Math.round(window.innerHeight * 0.72),
  };
}

/** Fills the app window below its titlebar. */
function maximizedRect(): Rect {
  return {
    left: 0,
    top: MIN_TOP,
    width: window.innerWidth,
    height: window.innerHeight - MIN_TOP,
  };
}

/** Pulls a rect back so it can always be grabbed, and fits it in the app window. */
function keepOnScreen(rect: Rect): Rect {
  return {
    left: clamp(rect.left, KEEP_VISIBLE - rect.width, window.innerWidth - KEEP_VISIBLE),
    top: clamp(rect.top, MIN_TOP, window.innerHeight - MIN_TOP),
    width: Math.min(rect.width, window.innerWidth),
    height: Math.min(rect.height, window.innerHeight - MIN_TOP),
  };
}

/**
 * A read-only view of one file's diff, in a window the user can move and resize.
 *
 * Deliberately not modal: with no backdrop, the Git section stays clickable, so
 * opening a second file refreshes this window rather than stacking another one.
 * Read-only is the point, not a default — it is what makes this safe to open on a
 * repo an agent is actively writing to, so nothing here issues a write.
 */
export function DiffWindow({
  instanceId,
  cwd,
  relPath,
  side,
  oldPath,
  running,
  onClose,
  onAskAgent,
}: DiffWindowProps) {
  // null while the diff is in flight.
  const [diff, setDiff] = useState<FileDiff | null>(null);
  // Selected rows, by row index rather than line number — a deleted row has no
  // new-version line number, so an index is the only thing every row has.
  const [selection, setSelection] = useState<{
    anchor: number;
    head: number;
  } | null>(null);
  const [rect, setRect] = useState<Rect>(initialRect);
  // Where to go back to while maximized; null when not maximized.
  const [restoreRect, setRestoreRect] = useState<Rect | null>(null);
  const maximized = restoreRect !== null;
  const draggingRef = useRef(false);

  // Refetched whenever the window is pointed at another file. Deliberately not
  // tied to the Git section's 5s poll — the diff is a snapshot of the moment it
  // was opened, and re-rendering underneath someone reading it would move the
  // lines they are looking at.
  useEffect(() => {
    let cancelled = false;
    setDiff(null);
    setSelection(null);
    window.electronAPI
      .getFileDiff(instanceId, relPath, side, oldPath)
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
  }, [instanceId, relPath, side, oldPath]);

  // Esc closes, unless a text field has focus — Esc in the compose box is that
  // box's own cancel, and closing both at once would be a surprise.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "TEXTAREA" || tag === "INPUT") return;
      e.preventDefault();
      onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  // A line-selection drag can be released anywhere, including outside the window.
  useEffect(() => {
    const onUp = () => {
      draggingRef.current = false;
    };
    window.addEventListener("mouseup", onUp);
    return () => window.removeEventListener("mouseup", onUp);
  }, []);

  // Keep the window reachable if the app window shrinks under it, and keep a
  // maximized one filling it.
  useEffect(() => {
    const onResize = () => {
      setRect((prev) => (maximized ? maximizedRect() : keepOnScreen(prev)));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [maximized]);

  // Double-clicking the header toggles between filling the app window and the
  // size and place it had before.
  const toggleMaximize = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest("button")) return;
    if (restoreRect) {
      // The app window may have shrunk while this one was maximized.
      setRect(keepOnScreen(restoreRect));
      setRestoreRect(null);
    } else {
      setRestoreRect(rect);
      setRect(maximizedRect());
    }
  };

  // Shared by the title-bar drag and the corner resize: both track the pointer on
  // document, so the gesture survives the pointer leaving the window.
  const trackPointer = (
    e: React.MouseEvent,
    onDelta: (dx: number, dy: number) => void
  ) => {
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    const onMove = (ev: MouseEvent) => onDelta(ev.clientX - startX, ev.clientY - startY);
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.userSelect = "";
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    document.body.style.userSelect = "none";
  };

  const startMove = (e: React.MouseEvent) => {
    // The × and any other header control keep their own click.
    if ((e.target as HTMLElement).closest("button")) return;
    // A maximized window stays put until restored. Letting a drag un-maximize it
    // would also fire on the pixel of jitter in a double-click meant to restore.
    if (maximized) return;
    const start = rect;
    trackPointer(e, (dx, dy) => {
      setRect({
        ...start,
        left: clamp(
          start.left + dx,
          KEEP_VISIBLE - start.width,
          window.innerWidth - KEEP_VISIBLE
        ),
        top: clamp(start.top + dy, MIN_TOP, window.innerHeight - MIN_TOP),
      });
    });
  };

  const startResize = (e: React.MouseEvent) => {
    const start = rect;
    trackPointer(e, (dx, dy) => {
      setRect({
        ...start,
        width: clamp(
          start.width + dx,
          MIN_WIDTH,
          window.innerWidth - start.left
        ),
        height: clamp(
          start.height + dy,
          MIN_HEIGHT,
          window.innerHeight - start.top
        ),
      });
    });
  };

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
    const extend = e.shiftKey;
    // Functional update rather than reading `selection` from this closure: two
    // clicks landing inside one frame would otherwise see a stale anchor, and a
    // shift-click would collapse to a single row.
    setSelection((prev) => {
      if (extend && prev) return { anchor: prev.anchor, head: index };
      // Clicking the one selected row clears the selection.
      if (prev && prev.anchor === index && prev.head === index) return null;
      return { anchor: index, head: index };
    });
    if (!extend) draggingRef.current = true;
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
      className={`diff-window${maximized ? " maximized" : ""}`}
      style={{
        left: `${rect.left}px`,
        top: `${rect.top}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
      }}
    >
      <div
        className="diff-window-header"
        onMouseDown={startMove}
        onDoubleClick={toggleMaximize}
        title={maximized ? "Double-click to restore" : "Double-click to maximize"}
      >
        <span className="diff-window-path" title={`${cwd}/${relPath}`}>
          {renamed ?? relPath}
        </span>
        <span className="diff-window-comparison">
          {diff?.ok === true ? diff.comparison : SIDE_LABEL[side]}
        </span>
        <button
          type="button"
          className="diff-window-close"
          onClick={onClose}
          title="Close (Esc)"
          aria-label="Close"
        >
          ×
        </button>
      </div>

      {reference && (
        <div className="diff-window-refbar">
          <code className="diff-window-ref">{reference.ref}</code>
          {reference.fellBack && (
            <span className="diff-window-ref-note">
              nearest line — the selected lines were removed
            </span>
          )}
          <button
            type="button"
            className="diff-window-ask"
            disabled={!running}
            title={
              running
                ? "Put this reference in the compose box"
                : "Instance is offline — start it to ask"
            }
            onClick={() => onAskAgent(reference.ref)}
          >
            Ask agent
          </button>
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

      {!maximized && (
        <div
          className="diff-window-resize"
          onMouseDown={startResize}
          title="Resize"
        />
      )}
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
  const bodyRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  if (diff === null) {
    return <div className="diff-window-note">Loading…</div>;
  }

  // No columns for a state that has no diff — and no stale rows either, since the
  // fetch clears them before the next result lands.
  if (!diff.ok) {
    return (
      <div className="diff-window-note">
        <span>{diffErrorMessage(diff.reason, diff.detail)}</span>
        {offersEditorFallback(diff.reason) && (
          <button
            type="button"
            className="diff-window-note-action"
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

  // Body and footer are siblings so the footer stays put while the diff scrolls;
  // the ruler sits beside the body rather than inside it for the same reason.
  return (
    <>
      <div className="diff-window-main">
        <div className="diff-window-body" ref={bodyRef}>
          <div
            className="diff-grid"
            ref={gridRef}
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
        <OverviewRuler rows={diff.rows} bodyRef={bodyRef} gridRef={gridRef} />
      </div>
      {diff.truncated && (
        <div className="diff-window-footer">
          Showing the first {diff.rows.length} lines.
        </div>
      )}
    </>
  );
}

/**
 * A strip down the right edge showing where the changes are in the whole file,
 * like VS Code's diff overview ruler: removed lines in the left lane, added lines
 * in the right, and a box for the part currently on screen. Clicking or dragging
 * on it scrolls there.
 *
 * Its own component so a scroll re-renders only the ruler, not every grid row.
 * Everything here is in pixels of the grid, not row indices: long lines wrap, so
 * rows differ in height and a row's index says nothing about where it sits.
 */
function OverviewRuler({
  rows,
  bodyRef,
  gridRef,
}: {
  rows: DiffRow[];
  bodyRef: React.RefObject<HTMLDivElement | null>;
  gridRef: React.RefObject<HTMLDivElement | null>;
}) {
  const marks = useMemo(() => overviewMarks(rows), [rows]);
  // Where each mark sits, as fractions of the grid's height. Empty until measured.
  const [spans, setSpans] = useState<{ top: number; height: number }[]>([]);
  // The visible part of the body, as fractions of its full scroll height.
  const [view, setView] = useState({ top: 0, height: 1 });

  useEffect(() => {
    const body = bodyRef.current;
    const grid = gridRef.current;
    if (!body || !grid) return;
    // Four cells per row, the same structure the grid's nth-child rules rely on;
    // indexing children beats a selector lookup per mark across 20k cells.
    const cellAt = (row: number) => grid.children[row * 4] as HTMLElement;
    const measure = () => {
      const total = grid.offsetHeight;
      if (total <= 0) return;
      setSpans(
        marks.map((mark) => {
          const top = cellAt(mark.start).offsetTop;
          const last = cellAt(mark.end - 1);
          return {
            top: top / total,
            height: (last.offsetTop + last.offsetHeight - top) / total,
          };
        })
      );
    };
    const updateView = () => {
      const { scrollTop, scrollHeight, clientHeight } = body;
      if (scrollHeight <= 0) return;
      setView({
        top: scrollTop / scrollHeight,
        height: Math.min(clientHeight / scrollHeight, 1),
      });
    };
    measure();
    updateView();
    body.addEventListener("scroll", updateView, { passive: true });
    // Resizing the window rewraps long lines, which moves every mark, and
    // changes how much of the file fits on screen.
    const observer = new ResizeObserver(() => {
      measure();
      updateView();
    });
    observer.observe(body);
    observer.observe(grid);
    return () => {
      body.removeEventListener("scroll", updateView);
      observer.disconnect();
    };
  }, [bodyRef, gridRef, marks]);

  const onMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    const ruler = e.currentTarget;
    // Centres the clicked point on screen, the way VS Code's ruler does.
    const scrollTo = (clientY: number) => {
      const body = bodyRef.current;
      if (!body) return;
      const box = ruler.getBoundingClientRect();
      const fraction = clamp((clientY - box.top) / box.height, 0, 1);
      body.scrollTop = fraction * body.scrollHeight - body.clientHeight / 2;
    };
    scrollTo(e.clientY);
    const onMove = (ev: MouseEvent) => scrollTo(ev.clientY);
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  return (
    <div
      className="diff-ruler"
      onMouseDown={onMouseDown}
      title="Changes in this file — click to jump"
    >
      {spans.length === marks.length &&
        marks.map((mark, i) => (
          <span
            key={`${mark.side}-${mark.start}`}
            className="diff-ruler-mark"
            data-side={mark.side}
            style={{
              top: `${spans[i].top * 100}%`,
              height: `${spans[i].height * 100}%`,
            }}
          />
        ))}
      <span
        className="diff-ruler-view"
        style={{
          top: `${view.top * 100}%`,
          height: `${view.height * 100}%`,
        }}
      />
    </div>
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
