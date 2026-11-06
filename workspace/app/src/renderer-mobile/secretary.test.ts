// The secretary on the phone (epic secretary-bar): which brief the bar shows as
// frames, taps and screens come and go (bar.ts, through the reducer), what it says,
// and the store and player behind Play, "Got it", the switch and replies: what goes on
// the wire, when the audio element plays and stops, and what the cache keeps.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AuthOkFrame,
  ClientFrame,
  PairingOffer,
  RemoteBrief,
  RemoteInstance,
  SecretaryFrame,
  ServerFrame,
} from "../shared/remote-protocol";
import { foldedLine, playOffer, stateLine } from "./bar";
import { loadCache, saveCache } from "./cache";
import type { AudioLike } from "./player";
import { IDLE_PLAYER, initialState, reduce, type Action, type AppState } from "./state";
import { createStore, type LinkLike, type Store } from "./store";
import { MemoryStorage } from "./test-storage";
import type { LinkStatus } from "./transport";

const authOk: AuthOkFrame = { type: "auth-ok", hostName: "Multi-Code on MacBook Air", vapidPublicKey: "v", pushEnabled: false };
const pairing = { origin: "https://my-mac.tail1234.ts.net", hostPublicKey: "k", deviceToken: "t", hostName: authOk.hostName };

const finished = (seq: number, at: number, text = `Shop is done, number ${seq}. The tests pass.`, extra: Partial<RemoteBrief> = {}) =>
  ({ seq, kind: "finished", status: "ready", text, language: "English", audio: "ready", at, audioUrl: `/secretary-audio?k=f${seq}`, ...extra }) as RemoteBrief;
const needsYou = (seq: number, at: number, extra: Partial<RemoteBrief> = {}) =>
  ({ seq, kind: "needs-you", status: "ready", text: "Billing wants to run the migrations. Allow it?", language: "English", audio: "ready", at, audioUrl: `/secretary-audio?k=n${seq}`, replyable: true, ...extra }) as RemoteBrief;

const secretary = (briefs: Record<string, RemoteBrief>, on = true, claudeFound = true): SecretaryFrame => ({
  type: "secretary",
  on,
  claudeFound,
  briefs,
});

const frame = (f: ServerFrame, at = 1000): Action => ({ type: "frame", frame: f, at });
const run = (state: AppState, ...actions: Action[]) => actions.reduce(reduce, state);
const online = () => reduce(initialState(pairing), { type: "link", status: { state: "connected", authOk }, at: 1, lastSeenAt: null });
const shown = (state: AppState) => state.bar.shown && `${state.bar.shown.instanceId}:${state.bar.shown.seq}`;

describe("which brief the bar shows", () => {
  it("shows nothing while the secretary is off or the Mac never said", () => {
    expect(online().bar).toEqual({ shown: null, open: false });
    const off = run(online(), frame(secretary({ shop: finished(1, 10) }, false)));
    expect(off.bar.shown).toBeNull();
  });

  it("takes the queue's head, Needs you first, and keeps it while it waits when another arrives", () => {
    let state = run(online(), frame(secretary({ shop: finished(1, 10), billing: needsYou(2, 20) })));
    expect(shown(state)).toBe("billing:2");
    state = run(state, frame(secretary({ shop: finished(1, 10), billing: needsYou(2, 20), docs: needsYou(3, 5) })));
    expect(shown(state)).toBe("billing:2");
  });

  it("moves on silently once the brief is dealt with, unless its panel is open", () => {
    let state = run(online(), frame(secretary({ shop: finished(1, 10), docs: finished(2, 20) })));
    expect(shown(state)).toBe("shop:1");
    state = run(state, { type: "bar", open: true }, frame(secretary({ shop: finished(1, 10, undefined, { seen: true }), docs: finished(2, 20) })));
    expect(shown(state)).toBe("shop:1");
    state = run(state, { type: "bar", open: false });
    expect(shown(state)).toBe("docs:2");
    expect(state.player).toBe(IDLE_PLAYER);
  });

  it("shows the latest brief, handled, with nothing waiting, and folds when the mode goes off", () => {
    let state = run(
      online(),
      frame(secretary({ shop: finished(1, 10, undefined, { seen: true }), docs: needsYou(2, 20, { handled: true }) }))
    );
    expect(shown(state)).toBe("docs:2");
    state = run(state, { type: "bar", open: true }, frame(secretary({}, false)));
    expect(state.bar).toEqual({ shown: null, open: false });
  });

  it("goes to the session's newer brief when a newer event replaces it", () => {
    let state = run(online(), frame(secretary({ shop: finished(1, 10) })), { type: "bar", open: true });
    state = run(state, frame(secretary({ shop: needsYou(4, 40) })));
    expect(shown(state)).toBe("shop:4");
    expect(state.bar.open).toBe(true);
  });

  it("brings an opened session's waiting brief to the bar and keeps it there while it is on screen", () => {
    let state = run(online(), frame(secretary({ billing: needsYou(2, 20), shop: finished(1, 10) })));
    expect(shown(state)).toBe("billing:2");
    // Opened from its push: its brief comes to the bar, and opening it reads it.
    state = run(state, { type: "open", id: "shop", at: 30 });
    expect(shown(state)).toBe("shop:1");
    state = run(state, frame(secretary({ billing: needsYou(2, 20), shop: finished(1, 10, undefined, { seen: true }) })));
    expect(shown(state)).toBe("shop:1");
    // Back to the list: the bar moves on.
    state = run(state, { type: "open", id: null, at: 40 });
    expect(shown(state)).toBe("billing:2");
  });

  it("doesn't take the bar from a brief the builder is busy with", () => {
    let state = run(online(), frame(secretary({ billing: needsYou(2, 20), shop: finished(1, 10) })), { type: "bar", open: true });
    state = run(state, { type: "open", id: "shop", at: 30 });
    expect(shown(state)).toBe("billing:2");
    state = run(state, { type: "bar", open: false }, { type: "player", player: { ref: { instanceId: "billing", seq: 2 }, status: "playing" } });
    state = run(state, frame(secretary({ billing: needsYou(2, 20), shop: finished(5, 50) })));
    expect(shown(state)).toBe("billing:2");
  });

  it("holds a brief while a reply to it is being read", () => {
    let state = run(online(), frame(secretary({ billing: needsYou(2, 20, { exchanges: [{ reply: "yes" }] }), shop: finished(1, 10) })));
    state = run(state, frame(secretary({ billing: needsYou(2, 20, { handled: true, exchanges: [{ reply: "yes" }] }), shop: finished(1, 10) })));
    expect(shown(state)).toBe("billing:2");
    state = run(
      state,
      frame(secretary({ billing: needsYou(2, 20, { handled: true, exchanges: [{ reply: "yes", outcome: "pressed", response: "Done." }] }), shop: finished(1, 10) }))
    );
    expect(shown(state)).toBe("shop:1");
  });
});

describe("what the bar says", () => {
  const view = (connection: AppState["connection"]["state"] = "connected", played: string[] = []) => ({
    player: IDLE_PLAYER,
    played,
    connection: { state: connection, hostName: "", lastSeenAt: null },
  });
  const ref = { instanceId: "shop", seq: 1 };

  it("folds to the brief's first sentence, or what the secretary is doing", () => {
    expect(foldedLine(finished(1, 10, "Shop 那边，登录修好了。测试全部通过。"))).toBe("Shop 那边，登录修好了。");
    expect(foldedLine({ seq: 1, kind: "finished", status: "preparing", at: 1 })).toBe("Writing the brief…");
    expect(foldedLine({ seq: 1, kind: "finished", status: "failed", reason: "x", at: 1 })).toBe("No brief could be written");
    expect(foldedLine(null)).toBe("Nothing new");
  });

  it("says each state, with the reason when there is no voice or no brief", () => {
    expect(stateLine(finished(1, 10), IDLE_PLAYER, ref)).toBe("Ready to play");
    expect(stateLine(finished(1, 10, undefined, { audio: "pending" }), IDLE_PLAYER, ref)).toBe("The voice is on its way…");
    expect(stateLine(finished(1, 10, undefined, { audio: "unavailable", voiceReason: "no speech server set" }), IDLE_PLAYER, ref)).toBe(
      "Text only, no voice: no speech server set"
    );
    expect(stateLine({ seq: 1, kind: "finished", status: "failed", reason: "claude exited", at: 1 }, IDLE_PLAYER, ref)).toBe(
      "No brief could be written: claude exited"
    );
    expect(stateLine(finished(1, 10), { ref, status: "playing" }, ref)).toBe("Playing");
  });

  it("offers Play, Replay once played, Stop while playing, and nothing without a voice", () => {
    expect(playOffer(finished(1, 10), view(), ref)).toBe("play");
    expect(playOffer(finished(1, 10), view("connected", ["shop:1"]), ref)).toBe("replay");
    expect(playOffer(finished(1, 10), { ...view(), player: { ref, status: "loading" } }, ref)).toBe("stop");
    expect(playOffer(finished(1, 10), view("offline"), ref)).toBe("offline");
    expect(playOffer(finished(1, 10, undefined, { audio: "pending", audioUrl: undefined }), view(), ref)).toBe("wait");
    expect(playOffer(finished(1, 10, undefined, { audio: "unavailable", audioUrl: undefined }), view(), ref)).toBe("none");
    expect(playOffer(null, view(), null)).toBe("none");
  });
});

// ---------------------------------------------------------------------------
// The store, the player and the cache
// ---------------------------------------------------------------------------

class FakeLink implements LinkLike {
  sent: ClientFrame[] = [];
  open = false;
  constructor(private readonly handlers: { onStatus: (s: LinkStatus) => void; onFrame: (f: ServerFrame) => void }) {}
  start() {}
  stop() {}
  send(frame: ClientFrame) {
    if (!this.open) return false;
    this.sent.push(frame);
    return true;
  }
  retryNow() {}
  up() {
    this.open = true;
    this.handlers.onStatus({ state: "connected", authOk });
  }
  down() {
    this.open = false;
    this.handlers.onStatus({ state: "offline", reason: "mac-unreachable", retrying: false });
  }
  frame(frame: ServerFrame) {
    this.handlers.onFrame(frame);
  }
}

// An audio element the test plays: what it was told, and the events it fires.
class FakeAudio implements AudioLike {
  src = "";
  ended = false;
  error: { code: number } | null = null;
  played: string[] = [];
  paused = 0;
  rejectWith: string | null = null;
  private listeners = new Map<string, (() => void)[]>();
  play() {
    this.played.push(this.src);
    return this.rejectWith ? Promise.reject(Object.assign(new Error("no"), { name: this.rejectWith })) : Promise.resolve();
  }
  pause() {
    this.paused++;
  }
  load() {}
  removeAttribute(name: string) {
    if (name === "src") this.src = "";
  }
  addEventListener(type: string, listener: () => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  fire(type: string) {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }
}

const offer: PairingOffer = { v: 3, ...pairing };
let storage: MemoryStorage;
let link: FakeLink;
let audio: FakeAudio;

function make(): Store {
  const store = createStore({
    storage,
    now: () => 5000,
    createLink: (_pairing, handlers) => (link = new FakeLink(handlers)),
    player: { createAudio: () => (audio = new FakeAudio()), storage },
  });
  store.actions.pair(offer);
  link.up();
  return store;
}

const instances = (...ids: string[]): ServerFrame => ({
  type: "instances",
  instances: ids.map((id): RemoteInstance => ({ id, name: id === "shop" ? "Shop" : id, cwd: `/code/${id}`, backend: "claude", status: "running", state: "idle" })),
});
const sentTypes = () => link.sent.map((f) => f.type);

beforeEach(() => {
  vi.useFakeTimers();
  storage = new MemoryStorage();
  audio = undefined as unknown as FakeAudio;
});
afterEach(() => {
  vi.useRealTimers();
});

describe("Play", () => {
  it("plays the bar's brief from the tap itself, and nothing without one", () => {
    const store = make();
    link.frame(instances("shop"));
    link.frame(secretary({ shop: finished(1, 10) }));
    // Nothing plays on arrival.
    expect(audio).toBeUndefined();

    expect(store.actions.play({ instanceId: "other", seq: 1 })).toBe(false);
    expect(store.actions.play({ instanceId: "shop", seq: 1 })).toBe(true);
    expect(audio.played).toEqual(["/secretary-audio?k=f1"]);
    expect(store.getState().player).toEqual({ ref: { instanceId: "shop", seq: 1 }, status: "loading" });
    audio.fire("playing");
    expect(store.getState().player.status).toBe("playing");
    expect(store.getState().played).toEqual(["shop:1"]);
  });

  it("needs the Mac and a ready voice", () => {
    const store = make();
    link.frame(secretary({ shop: finished(1, 10, undefined, { audio: "pending", audioUrl: undefined }) }));
    expect(store.actions.play({ instanceId: "shop", seq: 1 })).toBe(false);
    link.frame(secretary({ shop: finished(1, 10) }));
    link.down();
    expect(store.actions.play({ instanceId: "shop", seq: 1 })).toBe(false);
    expect(audio).toBeUndefined();
  });

  it("stops when the bar moves to another brief, its brief is replaced, or the mode goes off", () => {
    const store = make();
    link.frame(secretary({ shop: finished(1, 10), docs: finished(2, 20) }));
    const playing = () => store.getState().player.status;

    store.actions.play({ instanceId: "shop", seq: 1 });
    store.actions.showBrief({ instanceId: "docs", seq: 2 });
    expect(playing()).toBe("idle");
    expect(audio.src).toBe("");

    store.actions.play({ instanceId: "docs", seq: 2 });
    link.frame(secretary({ shop: finished(1, 10), docs: needsYou(3, 30) }));
    expect(playing()).toBe("idle");
    expect(audio.src).toBe("");

    store.actions.play({ instanceId: "docs", seq: 3 });
    expect(playing()).toBe("loading");
    // Moving around the app doesn't stop it.
    store.actions.open("shop");
    expect(playing()).toBe("loading");
    link.frame(secretary({}, false));
    expect(playing()).toBe("idle");
    expect(audio.src).toBe("");
  });

  it("reads a Finished brief's session when it plays to the end, not a Needs you", () => {
    const store = make();
    link.frame(secretary({ shop: finished(1, 10) }));
    store.actions.play({ instanceId: "shop", seq: 1 });
    audio.fire("playing");
    audio.ended = true;
    audio.fire("pause");
    audio.fire("ended");
    expect(store.getState().player).toBe(IDLE_PLAYER);
    expect(link.sent.at(-1)).toEqual({ type: "secretary-seen", instanceId: "shop", seq: 1 });
    expect(audio.src).toBe("");

    link.frame(secretary({ shop: needsYou(2, 20) }));
    audio.ended = false;
    store.actions.play({ instanceId: "shop", seq: 2 });
    audio.ended = true;
    audio.fire("ended");
    expect(sentTypes().filter((t) => t === "secretary-seen")).toHaveLength(1);
  });

  it("takes a pause it didn't ask for (the lock screen, a call) as a stop", () => {
    const store = make();
    link.frame(secretary({ shop: finished(1, 10) }));
    store.actions.play({ instanceId: "shop", seq: 1 });
    audio.fire("playing");
    audio.fire("pause");
    expect(store.getState().player).toBe(IDLE_PLAYER);
    expect(sentTypes()).not.toContain("secretary-seen");
  });

  it("asks for PCM once when the phone can't play the compact WAV, and keeps to it", () => {
    const store = make();
    link.frame(secretary({ shop: finished(1, 10), docs: finished(2, 20) }));
    store.actions.play({ instanceId: "shop", seq: 1 });
    audio.error = { code: 4 };
    audio.fire("error");
    audio.error = null;
    expect(audio.played).toEqual(["/secretary-audio?k=f1", "/secretary-audio?k=f1&f=pcm"]);
    expect(store.getState().player.status).toBe("loading");

    store.actions.showBrief({ instanceId: "docs", seq: 2 });
    store.actions.play({ instanceId: "docs", seq: 2 });
    expect(audio.played.at(-1)).toBe("/secretary-audio?k=f2&f=pcm");

    // PCM failing too says so.
    audio.error = { code: 4 };
    audio.fire("error");
    expect(store.getState().player).toMatchObject({ status: "error", error: "The voice couldn't play." });
  });

  it("says so when the phone won't let it play", async () => {
    const store = make();
    link.frame(secretary({ shop: finished(1, 10) }));
    store.actions.play({ instanceId: "shop", seq: 1 });
    audio.rejectWith = "NotAllowedError";
    store.actions.play({ instanceId: "shop", seq: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState().player).toMatchObject({ status: "error", error: "The phone didn't let it play. Tap Play again." });
  });
});

describe("the switch, Got it and replies", () => {
  it("sends the switch on an open link only, and never queues it", () => {
    const store = make();
    expect(store.actions.setSecretaryMode(true)).toMatchObject({ status: "sent" });
    expect(link.sent.at(-1)).toMatchObject({ type: "secretary-mode", enabled: true });
    link.down();
    expect(store.actions.setSecretaryMode(false)).toBeNull();
    link.up();
    expect(sentTypes().filter((t) => t === "secretary-mode")).toHaveLength(1);
  });

  it("sends Got it on an open link only", () => {
    const store = make();
    expect(store.actions.secretarySeen("shop", 1)).toBe(true);
    link.down();
    expect(store.actions.secretarySeen("shop", 1)).toBe(false);
  });

  it("sends a reply on an open link only, and keeps a refusal on the item", () => {
    const store = make();
    link.frame(secretary({ billing: needsYou(2, 20) }));
    const item = store.actions.secretaryReply("billing", 2, "可以，跑吧");
    expect(link.sent.at(-1)).toMatchObject({ type: "secretary-reply", instanceId: "billing", seq: 2, text: "可以，跑吧" });
    // On its way, it holds the bar.
    link.frame(secretary({ billing: needsYou(2, 20), shop: finished(1, 10, undefined, {}) }));
    link.frame({ type: "ack", clientMsgId: item!.frame.clientMsgId, ok: false, reason: "busy", message: "The secretary is still reading your last reply" });
    expect(store.getState().outbox.find((i) => i.frame.clientMsgId === item!.frame.clientMsgId)).toMatchObject({
      status: "refused",
      refusal: { reason: "busy" },
    });
    link.down();
    expect(store.actions.secretaryReply("billing", 2, "yes")).toBeNull();
    link.up();
    expect(sentTypes().filter((t) => t === "secretary-reply")).toHaveLength(1);
  });
});

describe("offline", () => {
  it("keeps the briefs' text in the cache, never their audio paths, and shows them at the next launch", () => {
    const state = run(online(), frame(secretary({ shop: finished(1, 10) }), 300));
    saveCache(storage, state, 300);
    expect(storage.getItem("multicode.cache")).not.toContain("secretary-audio");
    const cached = loadCache(storage)!;
    expect(cached.secretary).toEqual({ on: true, claudeFound: true, briefs: { shop: { ...finished(1, 10), audioUrl: undefined } } });
    expect(cached.secretary!.briefs.shop).not.toHaveProperty("audioUrl");
    expect(cached.secretaryAt).toBe(300);

    const launched = run(initialState(pairing, cached), { type: "link", status: { state: "offline", reason: "mac-unreachable", retrying: false }, at: 400, lastSeenAt: null });
    expect(shown(launched)).toBe("shop:1");
    expect(playOffer(launched.secretary!.briefs.shop, launched, launched.bar.shown)).toBe("offline");
  });

  it("reads a cache from before the epic as no secretary", () => {
    storage.setItem("multicode.cache", JSON.stringify({ v: 1, instances: [], instancesAt: 1, lastSeenAt: 1, sessions: {} }));
    expect(loadCache(storage)).toMatchObject({ secretary: null, secretaryAt: null });
  });
});
