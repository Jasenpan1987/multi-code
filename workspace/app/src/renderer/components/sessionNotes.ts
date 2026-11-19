// Small pieces of the session notes UI (docs/specs/session-notes/prd.md) that
// don't need React: when a note was written, its first line, and which noted
// session the "N notes" line opens next.

import { nextUnread } from "./contactHotkeys";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY_MS = 24 * 60 * 60 * 1000;

function startOfDay(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// "Today 18:42", "Yesterday 18:42", "Mon 18:42" within the last week, then
// "12 Nov 18:42", with the year when it isn't this one. Local time, 24-hour, in
// English like the rest of the UI.
export function formatNoteTime(writtenAt: number, now: number = Date.now()): string {
  const d = new Date(writtenAt);
  const time = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  // Whole days between the two midnights. Rounded: a day with a clock change in it
  // is 23 or 25 hours long.
  const days = Math.round((startOfDay(now) - startOfDay(writtenAt)) / DAY_MS);
  if (days === 0) return `Today ${time}`;
  if (days === 1) return `Yesterday ${time}`;
  if (days > 1 && days < 7) return `${DAYS[d.getDay()]} ${time}`;
  const date = `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  const year = d.getFullYear() === new Date(now).getFullYear() ? "" : ` ${d.getFullYear()}`;
  return `${date}${year} ${time}`;
}

// The first line that has any text, for the startup bar and the remove
// confirmation.
export function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line !== "") ?? ""
  );
}

// At most `max` characters, with an ellipsis when cut.
export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

// The noted session after `current`, in `order`, wrapping round; null when no
// other session has a note.
export function nextNoted(
  order: string[],
  noted: ReadonlySet<string>,
  current: string | null
): string | null {
  return nextUnread(order, new Map([...noted].map((id) => [id, 1])), current, 1);
}

// "1 note", "3 notes".
export function notesLabel(count: number): string {
  return count === 1 ? "1 note" : `${count} notes`;
}
