// What the phone has asked the Mac to do and what became of it: every `prompt`,
// `answer`, `interrupt` and `push-subscribe`, by its `clientMsgId`, until the
// desktop's `ack` settles it. Pure functions over an array, so the store's reducer
// stays pure and every rule here is tested on its own (outbox.test.ts).
//
// The two kinds behave differently on a lost socket (contract, AnswerFrame):
//   - `prompt` and `push-subscribe` wait. Queued while offline, persisted in
//     localStorage so a closed app keeps them, and resent on every connect until
//     acked; the desktop answers a clientMsgId it has already handled with the same
//     ack and doesn't act on it twice, so a resend never sends a message twice.
//   - `answer` and `interrupt` are never queued and never resent: a dialog or a
//     turn may have moved on while the phone was away. One sent on a socket that
//     dropped before its ack is `unknown` ("may not have arrived, check the
//     session"), and the builder looks again instead.

import nacl from "tweetnacl";
import type {
  AckFrame,
  AckRefusal,
  AnswerFrame,
  InterruptFrame,
  PromptFrame,
  PushSubscribeFrame,
  TranscriptEntry,
} from "../shared/remote-protocol";

export type OutboxFrame = PromptFrame | AnswerFrame | InterruptFrame | PushSubscribeFrame;

// waiting — not on the open socket: queued offline, or back in the queue after the
//           socket it went out on dropped (prompt and push-subscribe only)
// sent    — written to the open socket, its ack not back yet
// acked   — the desktop took it (`ack` ok)
// refused — the desktop said no (`refusal` says why)
// unknown — an answer or interrupt whose socket dropped before its ack, or a prompt
//           that went out before the phone paired again (see `newDevice`)
export type OutboxStatus = "waiting" | "sent" | "acked" | "refused" | "unknown";

export interface OutboxItem {
  frame: OutboxFrame;
  createdAt: number;
  status: OutboxStatus;
  // Written to a socket at least once, so the desktop may have it: it can no
  // longer be cancelled.
  sentOnce: boolean;
  refusal?: { reason: AckRefusal; message: string };
  // When it was acked, refused or became unknown.
  settledAt?: number;
  // A prompt or push-subscribe that went out on a socket that dropped before its
  // ack (or was on one when the app closed): the Mac may have had it since then.
  dropped?: boolean;
  // A dropped prompt still unacked when its session's CLI session was replaced
  // (`renewSession`): the new session's transcript may never show it, so its ack
  // settles it.
  oldSession?: boolean;
}

const STORAGE_KEY = "multicode.outbox";
const DELIVERED_KEY = "multicode.delivered";
// Plenty for a phone's backlog; the oldest settled items go first beyond it.
const MAX_ITEMS = 100;
// An acked prompt (or one whose arrival is unknown) is kept until the transcript
// shows it (see `settleDelivered`); one the transcript never showed is dropped at
// the next launch after this long.
const ACKED_KEPT_MS = 60 * 60_000;
// How far a transcript entry may predate the prompt it matches: the phone's clock
// and the Mac's are not the same clock.
const CLOCK_SKEW_MS = 2 * 60_000;
// How many of the entries that delivered a session's prompts are remembered.
const DELIVERED_KEPT = 50;

export const isQueued = (frame: OutboxFrame) => frame.type === "prompt" || frame.type === "push-subscribe";

export function newClientMsgId(): string {
  return Array.from(nacl.randomBytes(16), (b) => b.toString(16).padStart(2, "0")).join("");
}

export const idOf = (item: OutboxItem) => item.frame.clientMsgId;

// The session an item is about; null for a push-subscribe, which is the phone's.
export const instanceOf = (item: OutboxItem) => ("instanceId" in item.frame ? item.frame.instanceId : null);

// Only a prompt that never left the phone can be taken back.
export const canCancel = (item: OutboxItem) =>
  item.frame.type === "prompt" && item.status === "waiting" && !item.sentOnce;

// Adds a frame as `sent` when it went out on the open socket, else `waiting`.
// A newer push-subscribe replaces one still unacked: only the latest
// subscription matters.
export function enqueue(outbox: OutboxItem[], frame: OutboxFrame, now: number, sent: boolean): OutboxItem[] {
  const kept =
    frame.type === "push-subscribe"
      ? outbox.filter((i) => i.frame.type !== "push-subscribe" || i.status === "acked" || i.status === "refused")
      : outbox;
  return trim([...kept, { frame, createdAt: now, status: sent ? "sent" : "waiting", sentOnce: sent }]);
}

// What to write on a socket that has just authenticated, oldest first.
export const toSend = (outbox: OutboxItem[]) => outbox.filter((i) => i.status === "waiting");

export function markSent(outbox: OutboxItem[], ids: ReadonlySet<string>): OutboxItem[] {
  if (ids.size === 0) return outbox;
  return outbox.map((i) => (ids.has(idOf(i)) ? { ...i, status: "sent", sentOnce: true } : i));
}

// The desktop's ack. An acked push-subscribe leaves the outbox (the store keeps
// what it means), and so does a prompt from before a new CLI session (`oldSession`);
// an ack for an id the phone no longer holds is ignored.
export function applyAck(outbox: OutboxItem[], ack: AckFrame, now: number): OutboxItem[] {
  const item = outbox.find((i) => idOf(i) === ack.clientMsgId);
  if (!item) return outbox;
  if (ack.ok && (item.frame.type === "push-subscribe" || item.oldSession)) return outbox.filter((i) => i !== item);
  const settled: OutboxItem = ack.ok
    ? { ...item, status: "acked", settledAt: now }
    : { ...item, status: "refused", refusal: { reason: ack.reason, message: ack.message }, settledAt: now };
  return outbox.map((i) => (i === item ? settled : i));
}

// The socket the `sent` items went out on is gone.
export function socketLost(outbox: OutboxItem[], now: number): OutboxItem[] {
  if (!outbox.some((i) => i.status === "sent")) return outbox;
  return outbox.map((i) => {
    if (i.status !== "sent") return i;
    return isQueued(i.frame) ? { ...i, status: "waiting", dropped: true } : { ...i, status: "unknown", settledAt: now };
  });
}

// The phone paired again with the same Mac: a new token, which the Mac counts as a
// new device, with no record of the clientMsgIds the old one sent. A prompt that
// went out on a socket may have arrived, so resending it could send it twice: it
// becomes `unknown`, and the builder looks. One that never left still waits.
export function newDevice(outbox: OutboxItem[], now: number): OutboxItem[] {
  if (!outbox.some((i) => i.frame.type === "prompt" && i.sentOnce && (i.status === "waiting" || i.status === "sent"))) {
    return outbox;
  }
  return outbox.map((i) =>
    i.frame.type === "prompt" && i.sentOnce && (i.status === "waiting" || i.status === "sent")
      ? { ...i, status: "unknown", settledAt: now }
      : i
  );
}

// The instance's CLI session was replaced (`/new`, `/clear`; TranscriptFrame.session):
// the new session's transcript won't show what the old one was sent, the `/new`
// itself included. An acked prompt is settled now. One that went out on a socket
// that dropped before its ack may have reached the old session then, so its ack
// (to the resend) settles it. Anything else goes to the new session and waits to
// show there: one that never left, and one first written on this socket, which went
// out after the resubscribe that brought the new session's transcript (store.ts
// writes the outbox right after it, before that transcript is back).
export function renewSession(outbox: OutboxItem[], instanceId: string): OutboxItem[] {
  const ours = (i: OutboxItem) => i.frame.type === "prompt" && i.frame.instanceId === instanceId;
  const inFlight = (i: OutboxItem) =>
    Boolean(i.dropped) && (i.status === "waiting" || i.status === "sent") && !i.oldSession;
  if (!outbox.some((i) => ours(i) && (i.status === "acked" || inFlight(i)))) return outbox;
  return outbox
    .filter((i) => !(ours(i) && i.status === "acked"))
    .map((i) => (ours(i) && inFlight(i) ? { ...i, oldSession: true } : i));
}

export function cancel(outbox: OutboxItem[], clientMsgId: string): OutboxItem[] {
  const item = outbox.find((i) => idOf(i) === clientMsgId);
  return item && canCancel(item) ? outbox.filter((i) => i !== item) : outbox;
}

// Forget a settled item (a refusal read, an unknown checked). Never an item still
// on its way, which would lose a message.
export function dismiss(outbox: OutboxItem[], clientMsgId: string): OutboxItem[] {
  const item = outbox.find((i) => idOf(i) === clientMsgId);
  if (!item || item.status === "waiting" || item.status === "sent") return outbox;
  return outbox.filter((i) => i !== item);
}

// A transcript for the instance arrived: an acked prompt (or one whose arrival is
// unknown) that now shows in it as the builder's message has been delivered all the
// way, and the transcript's own bubble takes over from the outbox's. Matched on its
// text, and only against entries written after it was sent, so an earlier identical
// "yes" doesn't count. A slash command arrives as a command line (`local`), which
// may name the command alone: "/model" for "/model opus". One transcript entry
// delivers one prompt, so two identical messages need two, in this transcript and
// in every later one: `delivered` holds the entries (`entryKey`) that have
// delivered one of the session's prompts, which the caller keeps and passes in
// again (state.ts). Each stands for one occurrence.
export function settleDelivered(
  outbox: OutboxItem[],
  instanceId: string,
  entries: TranscriptEntry[],
  delivered: readonly string[] = []
): { outbox: OutboxItem[]; delivered: readonly string[] } {
  const open = outbox.filter(
    (i) =>
      (i.status === "acked" || i.status === "unknown") && i.frame.type === "prompt" && i.frame.instanceId === instanceId
  );
  if (open.length === 0) return { outbox, delivered };
  const left = new Map<string, number>();
  for (const key of delivered) left.set(key, (left.get(key) ?? 0) + 1);
  const free = entries.filter((e) => {
    if (e.kind !== "user") return false;
    const n = left.get(entryKey(e)) ?? 0;
    if (n > 0) left.set(entryKey(e), n - 1);
    return n === 0;
  });
  const settled = new Set<OutboxItem>();
  const used: string[] = [];
  for (const item of open) {
    const text = normalize((item.frame as PromptFrame).text);
    const command = text.startsWith("/") ? text.split(" ")[0] : null;
    const after = (e: TranscriptEntry) => e.at === undefined || e.at >= item.createdAt - CLOCK_SKEW_MS;
    let at = free.findIndex((e) => normalize(e.text) === text && after(e));
    if (at < 0 && command) at = free.findIndex((e) => e.local && normalize(e.text) === command && after(e));
    if (at < 0) continue;
    settled.add(item);
    used.push(entryKey(free[at]));
    free.splice(at, 1);
  }
  if (settled.size === 0) return { outbox, delivered };
  return {
    outbox: outbox.filter((i) => !settled.has(i)),
    delivered: [...delivered, ...used].slice(-DELIVERED_KEPT),
  };
}

const normalize = (text: string) => text.replace(/\s+/g, " ").trim();

// A transcript entry's identity across refreshes: its id, else when it was written
// and what it says.
const entryKey = (e: TranscriptEntry) => e.id ?? `${e.at ?? ""}:${normalize(e.text)}`;

function trim(outbox: OutboxItem[]): OutboxItem[] {
  if (outbox.length <= MAX_ITEMS) return outbox;
  const drop = new Set<OutboxItem>();
  for (const item of outbox) {
    if (outbox.length - drop.size <= MAX_ITEMS) break;
    if (item.status !== "waiting" && item.status !== "sent") drop.add(item);
  }
  return outbox.filter((i) => !drop.has(i));
}

// Only what waits survives a closed app: prompts and push subscriptions. Answers
// and interrupts are about a moment that has passed by the next launch. False
// when storage is full (store.ts then makes room).
export function saveOutbox(storage: Storage, outbox: OutboxItem[]): boolean {
  const kept = outbox.filter((i) => isQueued(i.frame));
  try {
    if (kept.length === 0) storage.removeItem(STORAGE_KEY);
    else storage.setItem(STORAGE_KEY, JSON.stringify(kept));
    return true;
  } catch {
    return false;
  }
}

// The entries that delivered each session's prompts (state.ts `delivered`), kept
// beside the outbox: an acked prompt that waits to show across a relaunch mustn't
// be settled by one of them. Full storage loses them, which can only drop such a
// bubble early.
export function saveDelivered(storage: Storage, delivered: Record<string, readonly string[]>) {
  const kept = Object.entries(delivered).filter(([, keys]) => keys.length > 0);
  try {
    if (kept.length === 0) storage.removeItem(DELIVERED_KEY);
    else storage.setItem(DELIVERED_KEY, JSON.stringify(Object.fromEntries(kept)));
  } catch {
    // Full storage.
  }
}

export function loadDelivered(storage: Storage): Record<string, readonly string[]> {
  try {
    const parsed = JSON.parse(storage.getItem(DELIVERED_KEY) ?? "{}") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(
        (entry): entry is [string, string[]] =>
          Array.isArray(entry[1]) && entry[1].every((key) => typeof key === "string")
      )
    );
  } catch {
    return {};
  }
}

// At launch nothing is on a socket yet, so whatever was `sent` waits again.
export function loadOutbox(storage: Storage, now: number): OutboxItem[] {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as OutboxItem[];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((i) => i?.frame && typeof i.frame.clientMsgId === "string" && isQueued(i.frame))
      .filter(
        (i) =>
          !((i.status === "acked" || i.status === "unknown") && now - (i.settledAt ?? i.createdAt) > ACKED_KEPT_MS)
      )
      .map((i) => (i.status === "sent" ? { ...i, status: "waiting", dropped: true } : i));
  } catch {
    return [];
  }
}
