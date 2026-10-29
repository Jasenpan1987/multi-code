// The store over a fake link: what goes on the wire, in which order, and what is
// kept in localStorage, through connects, drops and relaunches.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthOkFrame, ClientFrame, PairingOffer, ServerFrame } from "../shared/remote-protocol";
import { sessionOf } from "./state";
import { createStore, type LinkLike, type Store, type StoreDeps } from "./store";
import { MemoryStorage } from "./test-storage";
import type { LinkStatus } from "./transport";

const offer: PairingOffer = {
  v: 3,
  origin: "https://mac.tailnet.ts.net",
  hostPublicKey: "host-key",
  deviceToken: "token",
  hostName: "Multi-Code on MacBook Air",
};
const authOk: AuthOkFrame = { type: "auth-ok", hostName: offer.hostName, vapidPublicKey: "v", pushEnabled: false };

// A link the test drives: `up` / `down` play the socket, `sent` is the wire.
class FakeLink implements LinkLike {
  sent: ClientFrame[] = [];
  open = false;
  started = false;
  retries = 0;
  constructor(private readonly handlers: { onStatus: (s: LinkStatus) => void; onFrame: (f: ServerFrame) => void }) {}
  start() {
    this.started = true;
  }
  stop() {
    this.started = false;
  }
  send(frame: ClientFrame) {
    if (!this.open) return false;
    this.sent.push(frame);
    return true;
  }
  retryNow() {
    this.retries += 1;
  }
  up() {
    this.open = true;
    this.handlers.onStatus({ state: "connected", authOk });
  }
  down(status: LinkStatus = { state: "offline", reason: "mac-unreachable", retrying: false }) {
    this.open = false;
    this.handlers.onStatus(status);
  }
  frame(frame: ServerFrame) {
    this.handlers.onFrame(frame);
  }
  types() {
    return this.sent.map((f) => f.type);
  }
}

let storage: MemoryStorage;
let links: FakeLink[];
let clock: number;

function make(): Store {
  const deps: StoreDeps = {
    storage,
    now: () => clock,
    createLink: (_pairing, handlers) => {
      const l = new FakeLink(handlers);
      links.push(l);
      return l;
    },
  };
  return createStore(deps);
}

const lastLink = () => links[links.length - 1];
const ids = (frames: ClientFrame[]) => frames.map((f) => ("clientMsgId" in f ? f.clientMsgId : f.type));

beforeEach(() => {
  vi.useFakeTimers();
  storage = new MemoryStorage();
  links = [];
  clock = 1_000_000;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("store", () => {
  it("connects once paired, and starts a saved pairing's link on start()", () => {
    const store = make();
    expect(store.getState().connection.state).toBe("unpaired");
    store.actions.pair(offer);
    expect(lastLink().started).toBe(true);
    expect(store.getState().pairing?.hostPublicKey).toBe("host-key");

    const again = make();
    expect(again.getState().connection.state).toBe("connecting");
    again.start();
    expect(links).toHaveLength(2);
    again.start();
    expect(links).toHaveLength(2);
  });

  it("delivers a prompt typed offline once, after the open session is subscribed again", () => {
    const store = make();
    store.actions.pair(offer);
    const link = lastLink();
    store.actions.open("a");
    expect(link.sent).toEqual([]);

    const item = store.actions.sendPrompt("a", "run the tests");
    expect(item.status).toBe("waiting");
    expect(JSON.parse(storage.getItem("multicode.outbox")!)).toHaveLength(1);

    link.up();
    expect(link.types()).toEqual(["subscribe", "prompt"]);
    expect(link.sent[0]).toEqual({ type: "subscribe", instanceId: "a", turns: 10 });
    expect(store.getState().outbox[0].status).toBe("sent");

    link.frame({ type: "ack", clientMsgId: item.frame.clientMsgId, ok: true });
    expect(store.getState().outbox[0].status).toBe("acked");
    // A reconnect now sends nothing again.
    link.down();
    link.up();
    expect(link.types()).toEqual(["subscribe", "prompt", "subscribe"]);
  });

  it("resends a prompt whose socket dropped before its ack, with the same clientMsgId", () => {
    const store = make();
    store.actions.pair(offer);
    const link = lastLink();
    link.up();
    const item = store.actions.sendPrompt("a", "hi");
    expect(item.status).toBe("sent");
    link.down();
    expect(store.getState().outbox[0].status).toBe("waiting");
    link.up();
    expect(ids(link.sent)).toEqual([item.frame.clientMsgId, item.frame.clientMsgId]);
  });

  it("keeps the outbox across a relaunch and sends it on the first connect", () => {
    const first = make();
    first.actions.pair(offer);
    const item = first.actions.sendPrompt("a", "later");

    const second = make();
    second.start();
    lastLink().up();
    expect(ids(lastLink().sent)).toEqual([item.frame.clientMsgId]);
  });

  it("remembers across a relaunch which transcript entry already delivered an identical prompt", () => {
    const first = make();
    first.actions.pair(offer);
    lastLink().up();
    const p1 = first.actions.sendPrompt("a", "go");
    clock += 1000;
    const p2 = first.actions.sendPrompt("a", "go");
    lastLink().frame({ type: "ack", clientMsgId: p1.frame.clientMsgId, ok: true });
    lastLink().frame({ type: "ack", clientMsgId: p2.frame.clientMsgId, ok: true });
    const one = { type: "transcript" as const, instanceId: "a", entries: [{ kind: "user" as const, id: "u1", text: "go", at: clock }], hasEarlier: false };
    lastLink().frame(one);
    expect(first.getState().outbox.map((i) => i.frame.clientMsgId)).toEqual([p2.frame.clientMsgId]);

    // p2 still waits behind a running turn when the app closes.
    const second = make();
    second.start();
    lastLink().up();
    lastLink().frame(one);
    expect(second.getState().outbox.map((i) => i.frame.clientMsgId)).toEqual([p2.frame.clientMsgId]);

    // Unpairing forgets it with the outbox.
    second.actions.unpair();
    expect(storage.getItem("multicode.delivered")).toBeNull();
  });

  it("never queues an answer or an interrupt, and marks one in flight unknown when the socket drops", () => {
    const store = make();
    store.actions.pair(offer);
    const link = lastLink();
    expect(store.actions.answer("a", 4, { effect: "allow-once" })).toBeNull();
    expect(store.actions.interrupt("a")).toBeNull();
    expect(store.actions.sendInput("a", "\x1b")).toBe(false);
    expect(store.getState().outbox).toEqual([]);

    link.up();
    const answer = store.actions.answer("a", 4, { effect: "allow-always" }, true);
    expect(answer?.status).toBe("sent");
    expect(link.sent.at(-1)).toMatchObject({ type: "answer", seq: 4, confirmed: true, choice: { effect: "allow-always" } });
    expect(store.actions.sendInput("a", "\x1b")).toBe(true);
    link.down();
    expect(store.getState().outbox[0].status).toBe("unknown");
    link.up();
    expect(link.types()).toEqual(["answer", "input"]);
    // Not persisted: by the next launch that moment has passed.
    expect(storage.getItem("multicode.outbox")).toBeNull();
  });

  it("cancels a prompt still waiting, so it is never sent", () => {
    const store = make();
    store.actions.pair(offer);
    const item = store.actions.sendPrompt("a", "never mind");
    store.actions.cancelPrompt(item.frame.clientMsgId);
    lastLink().up();
    expect(lastLink().sent).toEqual([]);
  });

  it("subscribes and unsubscribes as the open session changes, and asks for earlier turns", () => {
    const store = make();
    store.actions.pair(offer);
    const link = lastLink();
    link.up();
    store.actions.open("a");
    store.actions.loadEarlier("a");
    store.actions.open("b");
    store.actions.open(null);
    expect(link.sent).toEqual([
      { type: "subscribe", instanceId: "a", turns: 10 },
      { type: "subscribe", instanceId: "a", turns: 20 },
      { type: "unsubscribe", instanceId: "a" },
      { type: "subscribe", instanceId: "b", turns: 10 },
      { type: "unsubscribe", instanceId: "b" },
    ]);
  });

  it("starts the open session afresh on a new CLI session: the first page of turns, and a cache of the new one only", () => {
    const store = make();
    store.actions.pair(offer);
    const link = lastLink();
    link.up();
    store.actions.open("a");
    const old = [
      { kind: "user", id: "o1", text: "你是谁" },
      { kind: "assistant", id: "o2", text: "我是 Claude。" },
    ] as const;
    link.frame({ type: "transcript", instanceId: "a", entries: [...old], hasEarlier: true, session: "s1" });
    store.actions.loadEarlier("a");
    link.frame({ type: "transcript", instanceId: "a", entries: [...old], hasEarlier: false, session: "s1" });
    const item = store.actions.sendPrompt("a", "/new");
    link.frame({ type: "ack", clientMsgId: item.frame.clientMsgId, ok: true });
    store.flush();
    expect(JSON.parse(storage.getItem("multicode.cache")!).sessions.a.cli).toBe("s1");
    link.sent.length = 0;

    link.frame({ type: "transcript", instanceId: "a", entries: [], hasEarlier: false, session: "s2" });
    // The Mac sends the new session at the first page from now on.
    expect(link.sent).toEqual([{ type: "subscribe", instanceId: "a", turns: 10 }]);
    expect(store.getState().outbox).toEqual([]);
    vi.advanceTimersByTime(600);
    const cached = JSON.parse(storage.getItem("multicode.cache")!).sessions.a;
    expect(cached).toMatchObject({ transcript: [], cli: "s2", renewed: true });
    // Relaunched, it opens on the new session.
    expect(sessionOf(make().getState(), "a")).toMatchObject({ transcript: [], cli: "s2", renewed: true });

    // At the first page already, nothing is asked again.
    link.sent.length = 0;
    link.frame({ type: "transcript", instanceId: "a", entries: [], hasEarlier: false, session: "s3" });
    expect(link.sent).toEqual([]);
  });

  it("on a new CLI session found at a reconnect, settles a dropped prompt by its ack and lets one typed offline wait to show", () => {
    const store = make();
    store.actions.pair(offer);
    const link = lastLink();
    link.up();
    store.actions.open("a");
    link.frame({ type: "transcript", instanceId: "a", entries: [], hasEarlier: false, session: "s1" });
    // "/new" goes out, and the socket drops before its ack.
    const renew = store.actions.sendPrompt("a", "/new");
    link.down();
    const typed = store.actions.sendPrompt("a", "typed offline");
    expect(typed.status).toBe("waiting");

    // Back: the resubscribe, then the outbox, then what the Mac says.
    link.sent.length = 0;
    link.up();
    expect(ids(link.sent)).toEqual(["subscribe", renew.frame.clientMsgId, typed.frame.clientMsgId]);
    link.frame({ type: "transcript", instanceId: "a", entries: [], hasEarlier: false, session: "s2" });
    link.frame({ type: "ack", clientMsgId: renew.frame.clientMsgId, ok: true });
    link.frame({ type: "ack", clientMsgId: typed.frame.clientMsgId, ok: true });
    // "/new" made the new session; "typed offline" went to it, and is on its way
    // through the CLI until the transcript shows it.
    expect(store.getState().outbox.map((i) => [i.frame.clientMsgId, i.status])).toEqual([[typed.frame.clientMsgId, "acked"]]);
    link.frame({
      type: "transcript",
      instanceId: "a",
      entries: [{ kind: "user", id: "n1", text: "typed offline", at: clock }],
      hasEarlier: false,
      session: "s2",
    });
    expect(store.getState().outbox).toEqual([]);
  });

  it("replays the terminal to a late sink, then streams to it", () => {
    const store = make();
    store.actions.pair(offer);
    const link = lastLink();
    link.up();
    store.actions.open("a");
    link.frame({ type: "snapshot", instanceId: "a", data: "screen", cols: 120, rows: 36 });
    link.frame({ type: "output", instanceId: "a", data: "+more" });

    const calls: string[] = [];
    const detach = store.actions.attachTerminal("a", {
      snapshot: (data, cols, rows) => calls.push(`snapshot ${data} ${cols}x${rows}`),
      output: (data) => calls.push(`output ${data}`),
      resize: (cols, rows) => calls.push(`resize ${cols}x${rows}`),
    });
    link.frame({ type: "output", instanceId: "a", data: "!" });
    link.frame({ type: "resize", instanceId: "a", cols: 100, rows: 30 });
    link.frame({ type: "output", instanceId: "b", data: "not mine" });
    detach();
    link.frame({ type: "output", instanceId: "a", data: "after" });
    expect(calls).toEqual(["snapshot screen+more 120x36", "output !", "resize 100x30"]);
    expect(sessionOf(store.getState(), "a").terminal).toEqual({ cols: 100, rows: 30 });
  });

  it("caches the list and the opened session, and opens with them and their age", () => {
    const store = make();
    store.actions.pair(offer);
    const link = lastLink();
    link.up();
    store.actions.open("a");
    clock += 1000;
    link.frame({
      type: "instances",
      instances: [{ id: "a", name: "a", cwd: "/a", backend: "claude", status: "running", state: "working" }],
    });
    link.frame({ type: "transcript", instanceId: "a", entries: [{ kind: "user", text: "hi" }], hasEarlier: false });
    clock += 60_000;
    // Something from the Mac a minute later: what's on screen was live until then.
    link.frame({ type: "pong", at: clock });
    link.down();
    store.flush();

    const relaunched = make();
    const state = relaunched.getState();
    expect(state.instances?.map((i) => i.id)).toEqual(["a"]);
    expect(state.instancesAt).toBe(clock);
    expect(sessionOf(state, "a").transcript).toEqual([{ kind: "user", text: "hi" }]);
    expect(sessionOf(state, "a").refreshedAt).toBe(clock);
  });

  it("writes the cache by itself shortly after content changes", () => {
    const store = make();
    store.actions.pair(offer);
    lastLink().up();
    lastLink().frame({ type: "instances", instances: [] });
    expect(storage.getItem("multicode.cache")).toBeNull();
    vi.advanceTimersByTime(600);
    expect(JSON.parse(storage.getItem("multicode.cache")!).instances).toEqual([]);
  });

  it("drops another Mac's content when pairing with a new one", () => {
    const store = make();
    store.actions.pair(offer);
    lastLink().up();
    store.actions.sendPrompt("a", "for the old Mac");
    lastLink().frame({ type: "instances", instances: [] });
    store.flush();
    store.actions.pair({ ...offer, hostPublicKey: "other-key" });
    expect(store.getState().instances).toBeNull();
    expect(store.getState().outbox).toEqual([]);
    expect(storage.getItem("multicode.cache")).toBeNull();
    expect(links[0].started).toBe(false);
    expect(lastLink().started).toBe(true);
  });

  it("keeps content when the same Mac pairs the phone again", () => {
    const store = make();
    store.actions.pair(offer);
    lastLink().up();
    lastLink().frame({ type: "instances", instances: [] });
    store.actions.pair({ ...offer, deviceToken: "new-token" });
    expect(store.getState().instances).toEqual([]);
    expect(store.getState().pairing?.deviceToken).toBe("new-token");
  });

  it("settles what was on the old socket when the same Mac pairs the phone again", () => {
    const store = make();
    store.actions.pair(offer);
    lastLink().up();
    const prompt = store.actions.sendPrompt("a", "in flight");
    store.actions.interrupt("a");
    // The same pairing link again: the same device, whose ids the Mac remembers.
    store.actions.pair(offer);
    expect(store.getState().outbox.map((i) => [i.frame.type, i.status])).toEqual([
      ["prompt", "waiting"],
      ["interrupt", "unknown"],
    ]);
    lastLink().up();
    expect(ids(lastLink().sent)).toEqual([prompt.frame.clientMsgId]);
  });

  it("doesn't resend under a new token what may have reached the Mac under the old one", () => {
    const store = make();
    store.actions.pair(offer);
    const old = lastLink();
    old.up();
    store.actions.sendPrompt("a", "in flight");
    old.down();
    const offline = store.actions.sendPrompt("a", "typed offline");
    // A new device to the Mac (each Pair mints one), with no record of the old ids.
    store.actions.pair({ ...offer, deviceToken: "new-token" });
    expect(store.getState().outbox.map((i) => [i.frame.type, i.status])).toEqual([
      ["prompt", "unknown"],
      ["prompt", "waiting"],
    ]);
    lastLink().up();
    expect(ids(lastLink().sent)).toEqual([offline.frame.clientMsgId]);
  });

  it("gives up the offline cache before a queued prompt when storage is full", () => {
    const store = make();
    store.actions.pair(offer);
    lastLink().up();
    store.actions.open("a");
    lastLink().frame({
      type: "transcript",
      instanceId: "a",
      entries: [{ kind: "assistant", text: "x".repeat(5000) }],
      hasEarlier: false,
    });
    store.flush();
    // Room for the cache as it is, and not much more.
    storage.quota = storage.used() + 100;
    lastLink().down();
    const item = store.actions.sendPrompt("a", "must survive ".repeat(20));
    expect(item.status).toBe("waiting");

    const relaunched = make();
    expect(relaunched.getState().outbox.map((i) => i.frame.clientMsgId)).toEqual([item.frame.clientMsgId]);
  });

  it("pairs even when storage is full, giving up the cache first", () => {
    const store = make();
    store.actions.pair(offer);
    lastLink().up();
    lastLink().frame({ type: "instances", instances: [] });
    store.flush();
    storage.quota = storage.used();
    const other = { ...offer, deviceToken: "a-much-longer-token-than-before" };
    expect(() => store.actions.pair(other)).not.toThrow();
    expect(store.getState().pairing?.deviceToken).toBe(other.deviceToken);
    expect(JSON.parse(storage.getItem("multicode.pairing")!).deviceToken).toBe(other.deviceToken);
    // Nothing fits at all: it still pairs, for as long as the page lives.
    storage.quota = 0;
    expect(() => store.actions.pair({ ...offer, deviceToken: "t3" })).not.toThrow();
    expect(store.getState().pairing?.deviceToken).toBe("t3");
    expect(lastLink().started).toBe(true);
  });

  it("forgets the Mac on unpair", () => {
    const store = make();
    store.actions.pair(offer);
    store.actions.sendPrompt("a", "x");
    store.actions.unpair();
    expect(store.getState().connection.state).toBe("unpaired");
    expect(storage.getItem("multicode.pairing")).toBeNull();
    expect(storage.getItem("multicode.outbox")).toBeNull();
    expect(lastLink().started).toBe(false);
  });

  it("passes Retry to the link, and tells subscribers about changes only", () => {
    const store = make();
    store.actions.pair(offer);
    let calls = 0;
    store.subscribe(() => (calls += 1));
    store.actions.retry();
    expect(lastLink().retries).toBe(1);
    lastLink().up();
    const after = calls;
    lastLink().frame({ type: "pong", at: 1 });
    expect(calls).toBe(after);
  });
});
