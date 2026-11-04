// Where a drop's files went, or why they didn't (file-drop PRD Stories 4 and 6), at
// the bottom right of the window, a card per drop. Each goes by itself; the pointer
// on it holds it, a click puts it away. It never takes the keyboard: nothing in it
// can be focused, and a press on it leaves the focus where it was, so typing goes
// on reaching the terminal.

import { useEffect, useRef, useState } from "react";
import { dropMessage, hideAfterMs, LINGER_MS } from "./dropNotice";
import type { DropLineTone, DropNotice } from "./dropNotice";
import type { DropReport } from "./dropFlow";

const MARKS: Record<DropLineTone, string> = {
  busy: "",
  ok: "✓",
  failed: "✕",
  more: "",
};

interface DropMessageProps {
  // Oldest first.
  notices: DropNotice[];
  // Its time is up, or it was clicked. Must keep its identity across renders: a
  // new one re-arms every card's timer.
  onDismiss: (drop: number) => void;
}

export function DropMessage({ notices, onDismiss }: DropMessageProps) {
  // Always there, so a screen reader hears what a new card says.
  return (
    <div className="drop-message-stack" aria-live="polite">
      {notices.map((n) => (
        <DropMessageCard key={n.drop} notice={n} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

function DropMessageCard({
  notice,
  onDismiss,
}: {
  notice: DropNotice;
  onDismiss: (drop: number) => void;
}) {
  const { drop, report } = notice;
  const { lines, tone } = dropMessage(report);
  const [hovered, setHovered] = useState(false);
  // The time this report has left; a new report (the copy done) starts its own.
  const time = useRef<{ report: DropReport; left: number } | null>(null);

  useEffect(() => {
    const full = hideAfterMs(report);
    if (full === null) return;
    if (time.current?.report !== report) time.current = { report, left: full };
    if (hovered) return;
    const t = time.current;
    const started = Date.now();
    const timer = setTimeout(() => onDismiss(drop), t.left);
    return () => {
      clearTimeout(timer);
      t.left = Math.max(LINGER_MS, t.left - (Date.now() - started));
    };
  }, [drop, report, hovered, onDismiss]);

  return (
    <div
      className="drop-message"
      data-tone={tone}
      title="Click to dismiss"
      // A press would move the focus off the terminal.
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => onDismiss(drop)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {lines.map((line, i) => (
        <div
          key={i}
          className="drop-message-line"
          data-tone={line.tone}
          data-path={line.path ? "" : undefined}
        >
          {MARKS[line.tone] && (
            <span className="drop-message-mark" aria-hidden="true">
              {MARKS[line.tone]}
            </span>
          )}
          <span className="drop-message-text">{line.text}</span>
        </div>
      ))}
    </div>
  );
}
