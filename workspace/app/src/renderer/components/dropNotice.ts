// The message after a drop (file-drop PRD Story 4): what a drop's report says, how
// long it stays, and which drops' messages show at once. Nothing here reads the
// document or the clock, so it is tested apart from DropMessage and App.

import type { DropCopyOutcome } from "../../shared/types";
import { MAX_SHOWN_NAMES } from "./dropFlow";
import type { DropReport } from "./dropFlow";

// A report with the drop it belongs to. Drops are numbered as they come, so a
// drop's `copied` replaces its own `copying` and never another drop's.
export interface DropNotice {
  drop: number;
  report: DropReport;
}

// At most this many drops' messages at once, the newest last. More only when drops
// come faster than their messages go; the oldest then makes room.
export const MAX_NOTICES = 3;

// "Copying…" only once a copy has run this long, so a quick one doesn't flash it.
export const COPYING_DELAY_MS = 400;

// How long a message stays, from when it shows: longer when something wasn't
// copied, as there is more to read and something to do about it.
export const HIDE_AFTER_MS = 6000;
export const HIDE_FAILED_AFTER_MS = 12000;
// The least it stays once the pointer leaves it: hovering holds it.
export const LINGER_MS = 2000;

export type DropLineTone = "busy" | "ok" | "partial" | "failed" | "more";

export interface DropLine {
  tone: DropLineTone;
  text: string;
  // A path or file name, shown in the terminal's font; else a sentence.
  path: boolean;
}

export interface DropMessageText {
  lines: DropLine[];
  // The whole message's: the copy running, everything copied, something copied
  // only in part, or something not copied at all.
  tone: Exclude<DropLineTone, "more">;
}

// The last part of an absolute path: what the builder dropped.
function baseName(source: string): string {
  return source.split("/").filter(Boolean).pop() ?? source;
}

function outcomeLine(outcome: DropCopyOutcome): DropLine {
  if (outcome.ok) {
    // `display` already carries the new name; the mark says why it isn't the
    // dropped one.
    return {
      tone: "ok",
      text: outcome.renamed ? `${outcome.display} (renamed)` : outcome.display,
      path: true,
    };
  }
  if (outcome.partial) {
    // Where what was copied is; the reason starts "partly copied: ".
    return {
      tone: "partial",
      text: `${outcome.display ?? baseName(outcome.source)} (${outcome.reason})`,
      path: true,
    };
  }
  return { tone: "failed", text: `${baseName(outcome.source)}: ${outcome.reason}`, path: true };
}

/**
 * What a report says, a line each. A copy gives one line per dropped item, in the
 * drop's order, up to `max`; past that, the failures are the ones kept (they need
 * the builder), then the first copies, and a last line counts the rest.
 */
export function dropMessage(report: DropReport, max = MAX_SHOWN_NAMES): DropMessageText {
  switch (report.kind) {
    case "copying":
      return { lines: [{ tone: "busy", text: "Copying…", path: false }], tone: "busy" };
    case "only-finder":
      return {
        lines: [{ tone: "failed", text: "Only files from Finder can be dropped", path: false }],
        tone: "failed",
      };
    case "error":
      return { lines: [{ tone: "failed", text: report.message, path: false }], tone: "failed" };
    case "copied": {
      const { outcomes } = report;
      const failedAt = outcomes.flatMap((o, i) => (o.ok ? [] : [i]));
      const copiedAt = outcomes.flatMap((o, i) => (o.ok ? [i] : []));
      const keptFailed = failedAt.slice(0, max);
      const kept = new Set([...keptFailed, ...copiedAt.slice(0, max - keptFailed.length)]);
      const lines = outcomes.filter((_, i) => kept.has(i)).map(outcomeLine);
      const more = outcomes.length - kept.size;
      if (more > 0) {
        const moreFailed = failedAt.length - keptFailed.length;
        lines.push({
          tone: "more",
          text:
            moreFailed === 0
              ? `+${more} more copied`
              : `+${more} more (${moreFailed} not copied)`,
          path: false,
        });
      }
      const tone =
        failedAt.length === 0
          ? "ok"
          : failedAt.every((i) => {
                const o = outcomes[i];
                return !o.ok && o.partial === true;
              })
            ? "partial"
            : "failed";
      return { lines, tone };
    }
  }
}

// How long a report's message stays; null while the copy runs, as it stays until
// the copy is done.
export function hideAfterMs(report: DropReport): number | null {
  if (report.kind === "copying") return null;
  return dropMessage(report).tone === "ok" ? HIDE_AFTER_MS : HIDE_FAILED_AFTER_MS;
}

/**
 * The messages with `report` in: in place of the same drop's earlier report, else
 * as the newest, the oldest going past `max`.
 */
export function withDropReport(
  notices: DropNotice[],
  drop: number,
  report: DropReport,
  max = MAX_NOTICES
): DropNotice[] {
  if (notices.some((n) => n.drop === drop)) {
    return notices.map((n) => (n.drop === drop ? { drop, report } : n));
  }
  return [...notices, { drop, report }].slice(-max);
}
