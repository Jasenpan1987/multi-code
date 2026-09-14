// Every manager tool call, recorded so the user can see it.
//
// The user authorised the manager to drive other sessions without approving each
// action, on the condition that nothing it does is invisible. That makes this a
// requirement of the feature rather than a debugging aid, and it is why a
// *refused* call is recorded too: a blocked dispatch the user never learns about
// is exactly the failure this exists to surface.
//
// No dependency beyond the entry type, so server.ts can record into it without
// acquiring one on process-manager — the direction that would close a cycle.

import type { ManagerActivityEntry } from "../../shared/types";

// Enough to cover a working day of coordination. This is a feed for watching, not
// an audit trail, so the oldest entries fall off rather than growing forever.
const MAX_ENTRIES = 200;

// A send_task can carry a whole briefing and read_session returns a transcript
// tail; neither has to be kept in full to be recognisable, and this lives in
// memory for the life of the app.
const MAX_TEXT = 4000;

export class ManagerActivityLog {
  // Newest first, which is the order the feed renders and the order that makes
  // the cap a plain truncation.
  private entries: ManagerActivityEntry[] = [];
  private nextId = 1;
  private listener: ((entry: ManagerActivityEntry) => void) | null = null;

  // One listener, set by the wiring layer — same shape as the remote server's
  // status listener. Nothing else needs to observe this.
  setListener(listener: ((entry: ManagerActivityEntry) => void) | null) {
    this.listener = listener;
  }

  // Records the call as `running` and returns its id, to be passed to finish().
  //
  // Two-phase on purpose. A tool can run for minutes — wait_for_idle is designed
  // to — and a feed that only showed calls once they returned would show nothing
  // during precisely the period the user wants to watch.
  start(tool: string, args: Record<string, unknown>): number {
    const entry: ManagerActivityEntry = {
      id: this.nextId++,
      at: Date.now(),
      tool,
      target: targetOf(args),
      payload: truncate(formatArgs(args)),
      status: "running",
    };
    this.entries.unshift(entry);
    if (this.entries.length > MAX_ENTRIES) this.entries.length = MAX_ENTRIES;
    this.emit(entry);
    return entry.id;
  }

  finish(id: number, outcome: { ok: boolean; text: string }) {
    const entry = this.entries.find((e) => e.id === id);
    // Gone already, having fallen off the end of a very busy feed. Nothing to
    // update and nothing worth reporting — the call itself was recorded.
    if (!entry) return;
    entry.status = outcome.ok ? "ok" : "error";
    entry.result = truncate(outcome.text);
    entry.durationMs = Date.now() - entry.at;
    this.emit(entry);
  }

  // Copies, because finish() mutates the stored entries in place and the caller
  // is handing these to the renderer.
  list(): ManagerActivityEntry[] {
    return this.entries.map((e) => ({ ...e }));
  }

  // Only used to isolate tests from each other; the running app never drops the
  // feed, since the point of it is that the user can look back at what happened.
  reset() {
    this.entries = [];
    this.nextId = 1;
  }

  private emit(entry: ManagerActivityEntry) {
    this.listener?.({ ...entry });
  }
}

// Tools address sessions by the name the user sees, under the `name` argument,
// consistently across read-tools and write-tools. Pulled out so the feed can show
// "who was this aimed at" as its own column instead of burying it in the payload.
function targetOf(args: Record<string, unknown>): string | undefined {
  const name = args.name;
  return typeof name === "string" && name.trim() !== "" ? name : undefined;
}

// JSON rather than a prettier rendering: this is the exact thing the model sent,
// and for a write the user needs to be able to read it literally. An empty object
// prints as nothing, so a no-argument tool doesn't show a meaningless `{}`.
function formatArgs(args: Record<string, unknown>): string {
  if (Object.keys(args).length === 0) return "";
  try {
    return JSON.stringify(args);
  } catch {
    // Circular or otherwise unserialisable arguments can't come off the wire as
    // JSON in the first place, but a handler is not the place to find out.
    return "(unreadable arguments)";
  }
}

function truncate(text: string): string {
  return text.length <= MAX_TEXT ? text : `${text.slice(0, MAX_TEXT)}…`;
}

export const managerActivityLog = new ManagerActivityLog();
