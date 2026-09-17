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

// Cap on the tool_use_id → entry id map for the manager's own tool calls. A
// PostToolUse hook that never arrives (the call was interrupted, or the app
// stopped listening mid-call) would otherwise leave its key behind forever.
const MAX_PENDING_KEYS = 200;

export class ManagerActivityLog {
  // Newest first, which is the order the feed renders and the order that makes
  // the cap a plain truncation.
  private entries: ManagerActivityEntry[] = [];
  private nextId = 1;
  private listener: ((entry: ManagerActivityEntry) => void) | null = null;
  // The manager's own calls are reported by two separate hook invocations that
  // share a `tool_use_id`, so pairing them needs a map from that id to our entry.
  // Insertion-ordered, and the oldest is dropped at the cap.
  private pendingSelfKeys = new Map<string, number>();

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
    return this.add({
      tool,
      target: targetOf(args),
      payload: formatArgs(args),
      origin: "mcp",
    });
  }

  finish(id: number, outcome: { ok: boolean; text: string }) {
    const entry = this.entries.find((e) => e.id === id);
    // Gone already, having fallen off the end of a very busy feed. Nothing to
    // update and nothing worth reporting — the call itself was recorded.
    if (!entry) return;
    this.settle(entry, outcome);
  }

  // A tool the manager ran itself, keyed by the CLI's `tool_use_id` so the
  // PostToolUse hook can find the entry its PreToolUse counterpart opened.
  //
  // A repeated key replaces nothing and opens a second entry: ids come from the
  // CLI and are unique per call, so a duplicate means something is replaying
  // hook deliveries, and losing the first entry would hide a real call.
  startSelf(
    key: string,
    tool: string,
    detail: { target?: string; payload: string }
  ): number {
    const id = this.add({
      tool,
      target: detail.target,
      payload: detail.payload,
      origin: "self",
    });
    this.pendingSelfKeys.set(key, id);
    if (this.pendingSelfKeys.size > MAX_PENDING_KEYS) {
      const oldest = this.pendingSelfKeys.keys().next();
      if (!oldest.done) this.pendingSelfKeys.delete(oldest.value);
    }
    return id;
  }

  // Closes the entry `startSelf` opened for this key. Returns false when there
  // is nothing to close, which is normal rather than an error: the app can start
  // listening between a call's two hooks, and a PostToolUse for a call we never
  // saw begin is better recorded than dropped — see `hook-activity.ts`.
  finishSelf(key: string, outcome: { ok: boolean; text: string }): boolean {
    const id = this.pendingSelfKeys.get(key);
    if (id === undefined) return false;
    this.pendingSelfKeys.delete(key);
    const entry = this.entries.find((e) => e.id === id);
    if (!entry) return false;
    this.settle(entry, outcome);
    return true;
  }

  private add(fields: Omit<ManagerActivityEntry, "id" | "at" | "status">): number {
    const entry: ManagerActivityEntry = {
      ...fields,
      id: this.nextId++,
      at: Date.now(),
      payload: truncate(fields.payload),
      status: "running",
    };
    this.entries.unshift(entry);
    if (this.entries.length > MAX_ENTRIES) this.entries.length = MAX_ENTRIES;
    this.emit(entry);
    return entry.id;
  }

  private settle(
    entry: ManagerActivityEntry,
    outcome: { ok: boolean; text: string }
  ) {
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
    this.pendingSelfKeys.clear();
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
