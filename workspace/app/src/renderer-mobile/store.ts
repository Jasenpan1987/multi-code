// The phone app's one store: state.ts's reducer plus everything with a side
// effect: the link to the Mac (transport.ts), what's kept in localStorage (the
// pairing, the outbox, the offline cache), and the terminal sink. Screens read it
// with `useApp(selector)` and change it only through `useActions()`:
//
//   pair(offer)                    save a pairing and connect with it
//   unpair()                       forget the Mac, its outbox and cache
//   retry()                        dial now (the offline banner's Retry)
//   open(id | null)                subscribe to one session (App does this from
//                                  the route), unsubscribing the previous one
//   loadEarlier(id)                ask for TURNS_PAGE more turns
//   sendPrompt(id, text)           queue a compose-box message; returns its item
//   cancelPrompt(clientMsgId)      take back a prompt that never left (canCancel)
//   answer(id, seq, choice, confirmed?)
//                                  answer a dialog; null when offline (not queued)
//   interrupt(id)                  stop the running turn; null when offline
//   sendInput(id, data)            raw keys for the terminal; false when offline
//   pushSubscribe(subscription | null)
//                                  this phone's Web Push subscription (T-811)
//   dismiss(clientMsgId)           forget a settled outbox item
//   attachTerminal(id, sink)       stream the session's PTY to a terminal
//   setSecretaryMode(enabled)      the secretary's switch; null when offline
//   secretarySeen(id, seq)         a Finished brief dealt with; false when offline
//   secretaryReply(id, seq, text)  a reply in words; null when offline
//   openBar(open)                  open or fold the secretary bar's panel
//   showBrief(ref)                 put another brief on the bar (‹ ›)
//   play(ref) / stopPlaying()      the bar's brief, from the tap itself (player.ts)
//
// Rules the actions keep: a prompt or push-subscribe goes out at once when the
// link is up and otherwise waits (outbox.ts), and everything still waiting is
// written, oldest first, right after every connect, once the open session has
// been subscribed again. An answer, interrupt or input is written only on an open
// link, never later, and so are the secretary's switch and replies. A brief that plays
// stops when it leaves the bar, is replaced, or the secretary goes off.

import { createContext, useContext, useRef, useSyncExternalStore } from "react";
import type {
  ClientFrame,
  PairingOffer,
  RemoteChoice,
  RemotePushSubscription,
  ServerFrame,
} from "../shared/remote-protocol";
import { clearCache, loadCache, saveCache } from "./cache";
import {
  idOf,
  loadDelivered,
  loadOutbox,
  newClientMsgId,
  saveDelivered,
  saveOutbox,
  toSend,
  type OutboxFrame,
  type OutboxItem,
} from "./outbox";
import { clearPairing, loadPairing, savePairing, storedPairing, type StoredPairing } from "./pairing";
import { briefOf, isPlaying, sameRef } from "./bar";
import { BriefPlayer, browserPlayerEnv, type PlayerEnv, type PlayerEvents } from "./player";
import { IDLE_PLAYER, initialState, reduce, sessionOf, type Action, type AppState, type Session } from "./state";
import type { LinkStatus } from "./transport";
import { isWaiting, type BriefRef } from "../shared/secretaryQueue";

// What the terminal screen (T-809) gives `attachTerminal`. `snapshot` replaces the
// screen: on attach (the session's buffer so far), and on every resubscribe.
export interface TerminalSink {
  snapshot(data: string, cols: number, rows: number): void;
  output(data: string): void;
  resize(cols: number, rows: number): void;
}

// The part of transport.ts's Link the store uses, so tests can stand in for it.
export interface LinkLike {
  start(): void;
  stop(): void;
  send(frame: ClientFrame): boolean;
  retryNow(): void;
}

export interface StoreDeps {
  storage: Storage;
  now?: () => number;
  createLink: (
    pairing: StoredPairing,
    handlers: { onStatus: (status: LinkStatus) => void; onFrame: (frame: ServerFrame) => void }
  ) => LinkLike;
  // The audio element briefs play in; the browser's by default.
  player?: PlayerEnv;
}

export interface Actions {
  pair(offer: PairingOffer): void;
  unpair(): void;
  retry(): void;
  open(id: string | null): void;
  loadEarlier(id: string): void;
  sendPrompt(id: string, text: string): OutboxItem;
  cancelPrompt(clientMsgId: string): void;
  answer(id: string, seq: number, choice: RemoteChoice, confirmed?: boolean): OutboxItem | null;
  interrupt(id: string): OutboxItem | null;
  sendInput(id: string, data: string): boolean;
  pushSubscribe(subscription: RemotePushSubscription | null): OutboxItem;
  dismiss(clientMsgId: string): void;
  attachTerminal(id: string, sink: TerminalSink): () => void;
  setSecretaryMode(enabled: boolean): OutboxItem | null;
  secretarySeen(id: string, seq: number): boolean;
  secretaryReply(id: string, seq: number, text: string): OutboxItem | null;
  openBar(open: boolean): void;
  showBrief(ref: BriefRef): void;
  // True when it started; only the brief on the bar, with its audio ready, online.
  play(ref: BriefRef): boolean;
  stopPlaying(): void;
}

export interface Store {
  getState(): AppState;
  subscribe(listener: () => void): () => void;
  actions: Actions;
  // Start the link (once, after the first render has the cached state on screen).
  start(): void;
  // Write the cache now: the page is being hidden and may not run again.
  flush(): void;
}

// What the terminal sink replays to a terminal that attaches late: the last
// snapshot and the output since, capped (a full repaint comes with the next
// snapshot anyway).
const TERMINAL_BUFFER_CHARS = 1_000_000;
const CACHE_SAVE_DELAY_MS = 500;

export function createStore(deps: StoreDeps): Store {
  const { storage } = deps;
  const now = deps.now ?? Date.now;
  const cached = loadCache(storage);
  let state = initialState(loadPairing(storage), {
    ...cached,
    outbox: loadOutbox(storage, now()),
    delivered: loadDelivered(storage),
  });
  let link: LinkLike | null = null;
  let lastSeenAt: number | null = cached?.lastSeenAt ?? null;
  let cacheTimer: ReturnType<typeof setTimeout> | null = null;
  const listeners = new Set<() => void>();
  const terminals = new Map<string, { data: string; cols: number; rows: number }>();
  const sinks = new Map<string, Set<TerminalSink>>();
  let player: BriefPlayer | null = null;

  function dispatch(action: Action) {
    const prev = state;
    state = reduce(state, action);
    if (state === prev) return;
    // The brief playing has left the bar, been replaced, or the secretary is off.
    const { player: playing } = state;
    if (isPlaying(playing, playing.ref) && (!briefOf(state, playing.ref) || !sameRef(playing.ref, state.bar.shown))) {
      player?.stop();
      state = reduce(state, { type: "player", player: IDLE_PLAYER });
    }
    if (state.outbox !== prev.outbox) persistOutbox();
    if (state.delivered !== prev.delivered) saveDelivered(storage, state.delivered);
    if (state.instances !== prev.instances || state.sessions !== prev.sessions || state.secretary !== prev.secretary) {
      scheduleCache();
    }
    for (const listener of listeners) listener();
  }

  // What the audio element reports, about the brief the state says it plays.
  const playerEvents: PlayerEvents = {
    playing() {
      const ref = state.player.ref;
      if (ref) dispatch({ type: "player", player: { ref, status: "playing" } });
    },
    // Played to the end: a Finished brief has been heard, which reads its session
    // (Story 4).
    ended() {
      const ref = state.player.ref;
      dispatch({ type: "player", player: IDLE_PLAYER });
      const brief = briefOf(state, ref);
      if (ref && brief?.kind === "finished" && isWaiting(brief)) actions.secretarySeen(ref.instanceId, ref.seq);
    },
    stopped() {
      dispatch({ type: "player", player: IDLE_PLAYER });
    },
    failed(error) {
      dispatch({ type: "player", player: { ref: state.player.ref, status: "error", error } });
    },
  };

  // The outbox and the cache share the origin's localStorage. The cache is the
  // expendable one: when the outbox doesn't fit, the cache goes (it is written
  // again, smaller, on its next save) so a queued message survives a relaunch.
  function persistOutbox() {
    if (saveOutbox(storage, state.outbox)) return;
    clearCache(storage);
    if (!saveOutbox(storage, state.outbox)) console.warn("Multi-Code: no room to keep the outbox on this phone");
  }

  function scheduleCache() {
    if (cacheTimer) return;
    cacheTimer = setTimeout(() => {
      cacheTimer = null;
      saveCache(storage, state, lastSeenAt);
    }, CACHE_SAVE_DELAY_MS);
  }

  function flush() {
    if (cacheTimer) clearTimeout(cacheTimer);
    cacheTimer = null;
    if (state.pairing) saveCache(storage, state, lastSeenAt);
  }

  const send = (frame: ClientFrame) => link?.send(frame) ?? false;
  const connected = () => state.connection.state === "connected";

  function subscribeOpen() {
    const id = state.openId;
    if (id) send({ type: "subscribe", instanceId: id, turns: sessionOf(state, id).turns });
  }

  // Everything still waiting, oldest first.
  function flushOutbox() {
    const sent = new Set<string>();
    for (const item of toSend(state.outbox)) {
      if (!send(item.frame)) break;
      sent.add(idOf(item));
    }
    dispatch({ type: "outbox-sent", ids: sent });
  }

  function onStatus(status: LinkStatus) {
    dispatch({ type: "link", status, at: now(), lastSeenAt });
    if (status.state === "connected") {
      lastSeenAt = now();
      // The desktop holds all state: resubscribing is how the phone catches up on
      // what it missed. Before the outbox, so a resent prompt lands after it.
      subscribeOpen();
      flushOutbox();
    }
  }

  function onFrame(frame: ServerFrame) {
    lastSeenAt = now();
    if (frame.type === "snapshot" || frame.type === "output" || frame.type === "resize") feedTerminal(frame);
    if (frame.type === "error") console.warn(`Multi-Code: ${frame.message}`);
    const before: Session | null = frame.type === "transcript" ? sessionOf(state, frame.instanceId) : null;
    dispatch({ type: "frame", frame, at: lastSeenAt });
    // A new CLI session went back to the first page of turns: the Mac sends the
    // open one at that page from now on too.
    if (before && frame.type === "transcript" && frame.instanceId === state.openId) {
      if (sessionOf(state, frame.instanceId).turns < before.turns && connected()) subscribeOpen();
    }
  }

  function feedTerminal(frame: Extract<ServerFrame, { type: "snapshot" | "output" | "resize" }>) {
    const id = frame.instanceId;
    const listening = sinks.get(id) ?? new Set<TerminalSink>();
    if (frame.type === "snapshot") {
      terminals.set(id, { data: frame.data, cols: frame.cols, rows: frame.rows });
      for (const sink of listening) sink.snapshot(frame.data, frame.cols, frame.rows);
      return;
    }
    const buffer = terminals.get(id);
    if (frame.type === "resize") {
      if (buffer) terminals.set(id, { ...buffer, cols: frame.cols, rows: frame.rows });
      for (const sink of listening) sink.resize(frame.cols, frame.rows);
      return;
    }
    if (buffer) {
      const data = buffer.data + frame.data;
      terminals.set(id, { ...buffer, data: data.length > TERMINAL_BUFFER_CHARS ? data.slice(-TERMINAL_BUFFER_CHARS) : data });
    }
    for (const sink of listening) sink.output(frame.data);
  }

  // Link.stop reports nothing, so what was on its socket is settled here: prompts
  // wait for the next link, answers and interrupts become unknown.
  function stopLink() {
    if (!link) return;
    link.stop();
    link = null;
    dispatch({ type: "link", status: { state: "connecting" }, at: now(), lastSeenAt });
  }

  function startLink() {
    stopLink();
    if (!state.pairing) return;
    link = deps.createLink(state.pairing, { onStatus, onFrame });
    link.start();
  }

  function queue(frame: OutboxFrame): OutboxItem {
    const sent = connected() && send(frame);
    dispatch({ type: "outbox-add", frame, at: now(), sent });
    return state.outbox.find((i) => idOf(i) === frame.clientMsgId)!;
  }

  // An answer or interrupt: on the open link, or not at all.
  function sendNow(frame: OutboxFrame): OutboxItem | null {
    if (!connected() || !send(frame)) return null;
    dispatch({ type: "outbox-add", frame, at: now(), sent: true });
    return state.outbox.find((i) => idOf(i) === frame.clientMsgId) ?? null;
  }

  const actions: Actions = {
    pair(offer) {
      stopLink();
      // Another Mac's content isn't this one's.
      if (state.pairing && state.pairing.hostPublicKey !== offer.hostPublicKey) {
        clearCache(storage);
        dispatch({ type: "unpaired" });
      } else if (state.pairing && state.pairing.deviceToken !== offer.deviceToken) {
        // The same Mac, as a new device: it can't tell a resend from a new message.
        dispatch({ type: "outbox-new-device", at: now() });
      }
      // The cache gives way to the pairing too. Failing that the pairing still
      // works until the app closes: the address bar no longer holds the offer, so
      // dropping it would mean scanning again.
      const pairing = storedPairing(offer);
      if (!savePairing(storage, pairing)) {
        clearCache(storage);
        if (!savePairing(storage, pairing)) console.warn("Multi-Code: no room to keep the pairing on this phone");
      }
      dispatch({ type: "paired", pairing });
      startLink();
    },

    unpair() {
      player?.stop();
      stopLink();
      clearPairing(storage);
      clearCache(storage);
      terminals.clear();
      dispatch({ type: "unpaired" });
    },

    retry() {
      link?.retryNow();
    },

    open(id) {
      const previous = state.openId;
      if (id === previous) return;
      if (previous) {
        send({ type: "unsubscribe", instanceId: previous });
        terminals.delete(previous);
      }
      dispatch({ type: "open", id, at: now() });
      if (connected()) subscribeOpen();
    },

    loadEarlier(id) {
      dispatch({ type: "earlier", id });
      if (id === state.openId && connected()) subscribeOpen();
    },

    sendPrompt(id, text) {
      return queue({ type: "prompt", instanceId: id, text, clientMsgId: newClientMsgId() });
    },

    cancelPrompt(clientMsgId) {
      dispatch({ type: "outbox-cancel", clientMsgId });
    },

    answer(id, seq, choice, confirmed) {
      return sendNow({
        type: "answer",
        instanceId: id,
        seq,
        choice,
        ...(confirmed ? { confirmed: true } : {}),
        clientMsgId: newClientMsgId(),
      });
    },

    interrupt(id) {
      return sendNow({ type: "interrupt", instanceId: id, clientMsgId: newClientMsgId() });
    },

    sendInput(id, data) {
      return connected() && send({ type: "input", instanceId: id, data });
    },

    pushSubscribe(subscription) {
      return queue({ type: "push-subscribe", subscription, clientMsgId: newClientMsgId() });
    },

    dismiss(clientMsgId) {
      dispatch({ type: "outbox-dismiss", clientMsgId });
    },

    setSecretaryMode(enabled) {
      return sendNow({ type: "secretary-mode", enabled, clientMsgId: newClientMsgId() });
    },

    secretarySeen(id, seq) {
      return connected() && send({ type: "secretary-seen", instanceId: id, seq });
    },

    secretaryReply(id, seq, text) {
      return sendNow({ type: "secretary-reply", instanceId: id, seq, text, clientMsgId: newClientMsgId() });
    },

    openBar(open) {
      dispatch({ type: "bar", open });
    },

    showBrief(ref) {
      dispatch({ type: "bar", shown: ref });
    },

    // Synchronous from the tap to the element's play() (player.ts).
    play(ref) {
      const brief = briefOf(state, ref);
      if (!connected() || !sameRef(ref, state.bar.shown)) return false;
      if (brief?.status !== "ready" || brief.audio !== "ready" || !brief.audioUrl) return false;
      const name = state.instances?.find((i) => i.id === ref.instanceId)?.name;
      player ??= new BriefPlayer(deps.player ?? browserPlayerEnv(), playerEvents);
      player.play(brief.audioUrl, name ? `${name} · Secretary` : "Secretary");
      dispatch({ type: "player", player: { ref, status: "loading" } });
      return true;
    },

    stopPlaying() {
      player?.stop();
      dispatch({ type: "player", player: IDLE_PLAYER });
    },

    attachTerminal(id, sink) {
      let set = sinks.get(id);
      if (!set) sinks.set(id, (set = new Set()));
      set.add(sink);
      const buffer = terminals.get(id);
      if (buffer) sink.snapshot(buffer.data, buffer.cols, buffer.rows);
      return () => {
        set.delete(sink);
        if (set.size === 0) sinks.delete(id);
      };
    },
  };

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    actions,
    start: () => {
      if (!link) startLink();
    },
    flush,
  };
}

// ---------------------------------------------------------------------------
// React
// ---------------------------------------------------------------------------

export const StoreContext = createContext<Store | null>(null);

function useStore(): Store {
  const store = useContext(StoreContext);
  if (!store) throw new Error("useApp outside <StoreContext.Provider>");
  return store;
}

export function useActions(): Actions {
  return useStore().actions;
}

// A slice of the state; the component re-renders when it changes. `select` should
// return part of the state as it is (`s => s.instances`, `s => sessionOf(s, id)`)
// or a primitive; one that builds a new array or object needs an `equal` that
// compares by content (`shallowEqual`), or it re-renders on every change.
export function useApp<T>(select: (state: AppState) => T, equal: (a: T, b: T) => boolean = Object.is): T {
  const store = useStore();
  const last = useRef<{ state: AppState; select: (state: AppState) => T; value: T } | null>(null);
  const read = () => {
    const current = store.getState();
    const prev = last.current;
    if (prev && prev.state === current && prev.select === select) return prev.value;
    const value = select(current);
    const kept = prev && equal(prev.value, value) ? prev.value : value;
    last.current = { state: current, select, value: kept };
    return kept;
  };
  return useSyncExternalStore(store.subscribe, read);
}

export function shallowEqual<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((item, i) => Object.is(item, b[i]));
}
