// Toolbox section showing every tool call the manager agent has made.
//
// This is not diagnostics. The manager drives other sessions without asking the
// user to approve each action, and the condition for that was that none of it is
// invisible — so a refused dispatch has to be as visible here as a successful one,
// with the reason attached.
//
// App-wide rather than per-instance, like the Phone section: there is one manager,
// and the toolbox is where everything that isn't the terminal lives.

import { useCallback, useEffect, useState } from "react";
import type { ManagerActivityEntry } from "../../shared/types";

interface ManagerSectionProps {
  active: boolean;
}

// One line's worth at the toolbox's usual width. The full text is one click away,
// so this only has to be enough to recognise the call.
const PREVIEW_CHARS = 110;

export function ManagerSection({ active }: ManagerSectionProps) {
  const [entries, setEntries] = useState<ManagerActivityEntry[]>([]);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  useEffect(() => {
    if (!active) return;
    void window.electronAPI.getManagerActivity().then(setEntries);
  }, [active]);

  // Live pushes carry a single entry, inserted or updated — a call appears the
  // moment it starts and is rewritten in place when it finishes, which is what
  // makes a slow tool visible while it is still running.
  useEffect(() => {
    const cleanup = window.electronAPI.onManagerActivity((entry) => {
      setEntries((prev) => {
        const at = prev.findIndex((e) => e.id === entry.id);
        if (at === -1) return [entry, ...prev];
        const next = [...prev];
        next[at] = entry;
        return next;
      });
    });
    return cleanup;
  }, []);

  const toggle = useCallback((id: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  if (!active) return null;

  if (entries.length === 0) {
    return (
      <div className="manager-section">
        <div className="manager-hint">
          Nothing yet. Every time the Manager looks at a session or sends one
          work, the call shows up here — including the ones it was refused, and
          why.
        </div>
      </div>
    );
  }

  return (
    <div className="manager-section">
      {entries.map((entry) => {
        const isOpen = expanded.has(entry.id);
        const detail = [entry.payload, entry.result].filter(Boolean).join("\n\n");
        // A refusal reason takes precedence over the arguments in the collapsed
        // line: a blocked write is the entry the user is scanning for, and "why"
        // is the part they need without a click. Otherwise the arguments, falling
        // back to the result for a tool that takes none — list_sessions would
        // otherwise render a blank second line.
        const previewText = preview(
          entry.status === "error" ? entry.result : entry.payload || entry.result
        );
        return (
          <div key={entry.id} className="manager-entry" data-status={entry.status}>
            <button
              type="button"
              className="manager-entry-head"
              onClick={() => toggle(entry.id)}
              // Nothing to open for a no-argument tool that hasn't answered yet.
              disabled={detail === ""}
            >
              <span className="manager-entry-dot" />
              <span className="manager-entry-tool">{entry.tool}</span>
              {entry.target ? (
                <span className="manager-entry-target">{entry.target}</span>
              ) : null}
              <span className="manager-entry-time">
                {formatClock(entry.at)}
                {entry.status === "running"
                  ? " · running"
                  : entry.durationMs !== undefined
                    ? ` · ${formatDuration(entry.durationMs)}`
                    : ""}
              </span>
            </button>

            {detail === "" ? null : isOpen ? (
              <div className="manager-entry-detail">
                {entry.payload ? (
                  <pre className="manager-entry-payload">{entry.payload}</pre>
                ) : null}
                {entry.result ? (
                  <pre
                    className="manager-entry-result"
                    data-error={entry.status === "error" ? "true" : "false"}
                  >
                    {entry.result}
                  </pre>
                ) : null}
              </div>
            ) : previewText === "" ? null : (
              <div
                className="manager-entry-preview"
                data-error={entry.status === "error" ? "true" : "false"}
              >
                {previewText}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function preview(text: string | undefined): string {
  if (!text) return "";
  // Newlines would otherwise collapse into a run of spaces mid-sentence and make
  // a multi-line instruction read as gibberish.
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length <= PREVIEW_CHARS
    ? oneLine
    : `${oneLine.slice(0, PREVIEW_CHARS)}…`;
}

// Wall-clock rather than an age: the user is matching these against what they
// remember happening, and against the terminal beside them.
function formatClock(at: number): string {
  return new Date(at).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 60_000)}m`;
}
