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
// unknown — an answer or interrupt whose socket dropped before its ack
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
}

const STORAGE_KEY = "multicode.outbox";
// Plenty for a phone's backlog; the oldest settled items go first beyond it.
const MAX_ITEMS = 100;
// An acked prompt is kept until the transcript shows it (see `settleDelivered`);
// one the transcript never showed is dropped at the next launch after this long.
const ACKED_KEPT_MS = 60 * 60_000;
// How far a transcript entry may predate the prompt it matches: the phone's clock
// and the Mac's are not the same clock.
const CLOCK_SKEW_MS = 2 * 60_000;

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
// what it means); an ack for an id the phone no longer holds is ignored.
export function applyAck(outbox: OutboxItem[], ack: AckFrame, now: number): OutboxItem[] {
  const item = outbox.find((i) => idOf(i) === ack.clientMsgId);
  if (!item) return outbox;
  if (ack.ok && item.frame.type === "push-subscribe") return outbox.filter((i) => i !== item);
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
    return isQueued(i.frame) ? { ...i, status: "waiting" } : { ...i, status: "unknown", settledAt: now };
  });
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

// A transcript for the instance arrived: an acked prompt that now shows in it as
// the builder's message has been delivered all the way, and the transcript's own
// bubble takes over from the outbox's. Matched on its text, and only against
// entries written after it was sent, so an earlier identical "yes" doesn't count.
export function settleDelivered(outbox: OutboxItem[], instanceId: string, entries: TranscriptEntry[]): OutboxItem[] {
  const acked = outbox.filter(
    (i) => i.status === "acked" && i.frame.type === "prompt" && i.frame.instanceId === instanceId
  );
  if (acked.length === 0) return outbox;
  const shown = entries.filter((e) => e.kind === "user");
  const delivered = new Set<OutboxItem>();
  for (const item of acked) {
    const text = normalize((item.frame as PromptFrame).text);
    const at = shown.findIndex(
      (e) => normalize(e.text) === text && (e.at === undefined || e.at >= item.createdAt - CLOCK_SKEW_MS)
    );
    if (at < 0) continue;
    delivered.add(item);
    // One transcript entry delivers one prompt, so two identical messages need two.
    shown.splice(at, 1);
  }
  return delivered.size ? outbox.filter((i) => !delivered.has(i)) : outbox;
}

const normalize = (text: string) => text.replace(/\s+/g, " ").trim();

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

// At launch nothing is on a socket yet, so whatever was `sent` waits again.
export function loadOutbox(storage: Storage, now: number): OutboxItem[] {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as OutboxItem[];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((i) => i?.frame && typeof i.frame.clientMsgId === "string" && isQueued(i.frame))
      .filter((i) => !(i.status === "acked" && now - (i.settledAt ?? i.createdAt) > ACKED_KEPT_MS))
      .map((i) => (i.status === "sent" ? { ...i, status: "waiting" } : i));
  } catch {
    return [];
  }
}
