// The outbox's rules: what waits and is resent, what becomes "may not have
// arrived", what can be cancelled or dismissed, and what survives a relaunch.

import { describe, expect, it } from "vitest";
import type { AckFrame, TranscriptEntry } from "../shared/remote-protocol";
import {
  applyAck,
  canCancel,
  cancel,
  dismiss,
  enqueue,
  loadOutbox,
  markSent,
  saveOutbox,
  settleDelivered,
  socketLost,
  toSend,
  type OutboxFrame,
  type OutboxItem,
} from "./outbox";
import { MemoryStorage } from "./test-storage";

const prompt = (id: string, text = "hello", instanceId = "a"): OutboxFrame => ({
  type: "prompt",
  instanceId,
  text,
  clientMsgId: id,
});
const answer = (id: string): OutboxFrame => ({
  type: "answer",
  instanceId: "a",
  seq: 7,
  choice: { effect: "allow-once" },
  clientMsgId: id,
});
const interrupt = (id: string): OutboxFrame => ({ type: "interrupt", instanceId: "a", clientMsgId: id });
const push = (id: string, on = true): OutboxFrame => ({
  type: "push-subscribe",
  subscription: on ? { endpoint: "https://push.example/1", keys: { p256dh: "p", auth: "a" } } : null,
  clientMsgId: id,
});
const ok = (id: string): AckFrame => ({ type: "ack", clientMsgId: id, ok: true });
const refused = (id: string): AckFrame => ({
  type: "ack",
  clientMsgId: id,
  ok: false,
  reason: "dialog-open",
  message: "A dialog is open",
});
const status = (outbox: OutboxItem[]) => Object.fromEntries(outbox.map((i) => [i.frame.clientMsgId, i.status]));

describe("outbox", () => {
  it("queues a frame sent offline and marks one that went out as sent", () => {
    let outbox = enqueue([], prompt("p1"), 1, false);
    outbox = enqueue(outbox, prompt("p2"), 2, true);
    expect(status(outbox)).toEqual({ p1: "waiting", p2: "sent" });
    expect(outbox.map((i) => i.sentOnce)).toEqual([false, true]);
    expect(toSend(outbox).map((i) => i.frame.clientMsgId)).toEqual(["p1"]);
  });

  it("writes what waits oldest first, then knows it has been on a socket", () => {
    let outbox = enqueue(enqueue([], prompt("p1"), 1, false), prompt("p2"), 2, false);
    expect(toSend(outbox).map((i) => i.frame.clientMsgId)).toEqual(["p1", "p2"]);
    outbox = markSent(outbox, new Set(["p1", "p2"]));
    expect(status(outbox)).toEqual({ p1: "sent", p2: "sent" });
    expect(outbox.every((i) => i.sentOnce)).toBe(true);
    expect(toSend(outbox)).toEqual([]);
  });

  it("settles an item by its ack, and ignores an ack for an id it doesn't hold", () => {
    let outbox = enqueue(enqueue([], prompt("p1"), 1, true), prompt("p2"), 2, true);
    outbox = applyAck(outbox, ok("p1"), 10);
    outbox = applyAck(outbox, refused("p2"), 11);
    expect(status(outbox)).toEqual({ p1: "acked", p2: "refused" });
    expect(outbox[0].settledAt).toBe(10);
    expect(outbox[1].refusal).toEqual({ reason: "dialog-open", message: "A dialog is open" });
    expect(applyAck(outbox, ok("nobody"), 12)).toBe(outbox);
  });

  it("puts prompts back in the queue when their socket drops, and marks answers and interrupts unknown", () => {
    let outbox = enqueue([], prompt("p1"), 1, true);
    outbox = enqueue(outbox, answer("a1"), 2, true);
    outbox = enqueue(outbox, interrupt("i1"), 3, true);
    outbox = enqueue(outbox, push("s1"), 4, true);
    outbox = socketLost(outbox, 20);
    expect(status(outbox)).toEqual({ p1: "waiting", a1: "unknown", i1: "unknown", s1: "waiting" });
    expect(outbox.find((i) => i.frame.clientMsgId === "a1")?.settledAt).toBe(20);
    // Only what can be resent is resent.
    expect(toSend(outbox).map((i) => i.frame.clientMsgId)).toEqual(["p1", "s1"]);
  });

  it("leaves acked and refused items alone when the socket drops", () => {
    let outbox = enqueue(enqueue([], answer("a1"), 1, true), prompt("p1"), 2, true);
    outbox = applyAck(applyAck(outbox, ok("a1"), 5), refused("p1"), 6);
    expect(socketLost(outbox, 9)).toBe(outbox);
  });

  it("cancels only a prompt that never left the phone", () => {
    let outbox = enqueue([], prompt("never"), 1, false);
    outbox = enqueue(outbox, prompt("inflight"), 2, true);
    outbox = socketLost(outbox, 3);
    // Both wait now, but the second may have reached the Mac before the drop.
    expect(outbox.map(canCancel)).toEqual([true, false]);
    expect(status(cancel(outbox, "never"))).toEqual({ inflight: "waiting" });
    expect(cancel(outbox, "inflight")).toBe(outbox);
  });

  it("dismisses settled items only", () => {
    let outbox = enqueue(enqueue([], prompt("p1"), 1, false), answer("a1"), 2, true);
    outbox = socketLost(outbox, 3);
    expect(dismiss(outbox, "p1")).toBe(outbox);
    expect(status(dismiss(outbox, "a1"))).toEqual({ p1: "waiting" });
  });

  it("keeps one push subscription in flight: the newest replaces an unacked one", () => {
    let outbox = enqueue([], push("s1"), 1, false);
    outbox = enqueue(outbox, push("s2", false), 2, false);
    expect(outbox.map((i) => i.frame.clientMsgId)).toEqual(["s2"]);
    // Acked, a push-subscribe leaves the outbox: the store keeps what it means.
    outbox = applyAck(markSent(outbox, new Set(["s2"])), ok("s2"), 3);
    expect(outbox).toEqual([]);
  });

  it("drops an acked prompt once the transcript shows it, not before", () => {
    const entry = (text: string, at?: number): TranscriptEntry => ({ kind: "user", text, ...(at ? { at } : {}) });
    let outbox = enqueue([], prompt("p1", "run  the\ntests", "a"), 100_000, true);
    outbox = enqueue(outbox, prompt("p2", "yes"), 200_000, true);
    outbox = applyAck(applyAck(outbox, ok("p1"), 100_500), ok("p2"), 200_500);

    // An earlier "yes", from before p2 was sent (beyond the clock skew allowed),
    // isn't p2 arriving.
    const early = settleDelivered(outbox, "a", [entry("yes", 200_000 - 3 * 60_000)]);
    expect(early).toBe(outbox);
    // Another session's transcript doesn't count.
    expect(settleDelivered(outbox, "b", [entry("run the tests")])).toBe(outbox);

    // Whitespace aside, the same text; an entry without a time counts.
    const shown = settleDelivered(outbox, "a", [entry("run the tests", 100_200), entry("yes")]);
    expect(shown).toEqual([]);
  });

  it("needs one transcript entry per identical prompt", () => {
    let outbox = enqueue(enqueue([], prompt("p1", "go"), 1000, true), prompt("p2", "go"), 2000, true);
    outbox = applyAck(applyAck(outbox, ok("p1"), 1100), ok("p2"), 2100);
    const once = settleDelivered(outbox, "a", [{ kind: "user", text: "go", at: 1500 }]);
    expect(once.map((i) => i.frame.clientMsgId)).toEqual(["p2"]);
  });

  it("keeps a waiting or refused prompt unless the transcript shows it was acked", () => {
    let outbox = enqueue([], prompt("p1", "x"), 1, false);
    outbox = enqueue(outbox, prompt("p2", "x"), 2, true);
    outbox = applyAck(outbox, refused("p2"), 3);
    expect(settleDelivered(outbox, "a", [{ kind: "user", text: "x" }])).toBe(outbox);
  });

  it("stops at 100 items by dropping the oldest settled ones, never one still on its way", () => {
    let outbox: OutboxItem[] = enqueue([], prompt("waiting-0"), 0, false);
    for (let i = 1; i <= 100; i++) {
      outbox = enqueue(outbox, answer(`a${i}`), i, true);
      outbox = applyAck(outbox, ok(`a${i}`), i);
    }
    expect(outbox).toHaveLength(100);
    expect(outbox[0].frame.clientMsgId).toBe("waiting-0");
    expect(outbox[1].frame.clientMsgId).toBe("a2");
  });

  it("persists only prompts and push subscriptions, and sends whatever was in flight again after a relaunch", () => {
    const storage = new MemoryStorage();
    let outbox = enqueue([], prompt("p1"), 1, true);
    outbox = enqueue(outbox, prompt("p2"), 2, false);
    outbox = enqueue(outbox, answer("a1"), 3, true);
    outbox = enqueue(outbox, push("s1"), 4, true);
    saveOutbox(storage, outbox);

    const loaded = loadOutbox(storage, 5);
    expect(status(loaded)).toEqual({ p1: "waiting", p2: "waiting", s1: "waiting" });
    // Still not cancellable: it was on a socket before the relaunch.
    expect(loaded.map(canCancel)).toEqual([false, true, false]);
  });

  it("forgets at launch an acked prompt the transcript never showed after an hour", () => {
    const storage = new MemoryStorage();
    let outbox = enqueue(enqueue([], prompt("old"), 0, true), prompt("new"), 0, true);
    outbox = applyAck(applyAck(outbox, ok("old"), 1000), ok("new"), 3_000_000);
    saveOutbox(storage, outbox);
    expect(status(loadOutbox(storage, 1000 + 61 * 60_000))).toEqual({ new: "acked" });
  });

  it("removes the stored outbox when nothing waits, and survives bad storage", () => {
    const storage = new MemoryStorage();
    saveOutbox(storage, enqueue([], prompt("p1"), 1, false));
    saveOutbox(storage, []);
    expect(storage.getItem("multicode.outbox")).toBeNull();
    storage.setItem("multicode.outbox", "{not json");
    expect(loadOutbox(storage, 1)).toEqual([]);
    storage.quota = 10;
    expect(saveOutbox(storage, enqueue([], prompt("p1"), 1, false))).toBe(false);
  });
});
