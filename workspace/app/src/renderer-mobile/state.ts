// The phone app's state and its reducer: everything the screens draw, in one
// object, changed only by `reduce`. Pure (no storage, no socket, no clock), so it
// is tested frame by frame (state.test.ts); store.ts owns the side effects.
//
// Every "…At" time is when that content was last known to be current, in the
// phone's ms: set when it arrives, and moved to the moment the link was last
// heard from when it was live until then. That is the age the offline banner
// shows ("Showing what it said 3 min ago").

import type {
  PromptStateFrame,
  RemoteInstance,
  ServerFrame,
  TranscriptEntry,
} from "../shared/remote-protocol";
import {
  applyAck,
  cancel,
  dismiss,
  enqueue,
  markSent,
  newDevice,
  settleDelivered,
  socketLost,
  type OutboxFrame,
  type OutboxItem,
} from "./outbox";
import type { StoredPairing } from "./pairing";
import type { LinkStatus, OfflineReason, RefusedReason } from "./transport";

// How many turns a session opens with, and how many more "Earlier turns" adds.
export const TURNS_PAGE = 10;

export interface Connection {
  // unpaired   — no pairing yet: the setup screen
  // connecting — dialling (also while the page is hidden and the link paused)
  // connected  — authenticated; everything shown is live
  // offline    — the Mac can't be reached; retrying; `reason` says why
  // refused    — the Mac turned this phone away; `reason` says why
  state: "unpaired" | "connecting" | "connected" | "offline" | "refused";
  offline?: OfflineReason | null;
  // offline only: an attempt is under way.
  retrying?: boolean;
  refused?: RefusedReason;
  // The Mac's name as it reports it ("Multi-Code on MacBook Air"); format.ts
  // `macName` gives the short form the screens show.
  hostName: string;
  // When the Mac was last heard from (any frame). Null if never.
  lastSeenAt: number | null;
}

// The open dialog, as the last `prompt-state` described it.
export type OpenDialog = Omit<PromptStateFrame, "type" | "instanceId">;

export interface Session {
  // Null until a transcript arrives (or comes from the cache).
  transcript: TranscriptEntry[] | null;
  hasEarlier: boolean;
  // Turns asked for in `subscribe`: TURNS_PAGE, plus TURNS_PAGE per "Earlier turns".
  turns: number;
  dialog: OpenDialog | null;
  // The PTY's size from the last snapshot or resize; the bytes go to the terminal
  // sink (store.ts), never through state.
  terminal: { cols: number; rows: number } | null;
  exit: { code: number; at: number } | null;
  refreshedAt: number | null;
}

export interface AppState {
  pairing: StoredPairing | null;
  connection: Connection;
  // From the last `auth-ok`, and kept up to date by push-subscribe acks. Null
  // before the first connect.
  push: { vapidPublicKey: string; enabled: boolean } | null;
  // The Mac's list, in its order; null until one arrives (or comes from the cache).
  instances: RemoteInstance[] | null;
  instancesAt: number | null;
  // By instance id: every session the phone has opened or been told about.
  sessions: Record<string, Session>;
  // The session the phone is subscribed to (its chat or terminal is on screen).
  openId: string | null;
  outbox: OutboxItem[];
  // By instance id: the transcript entries that delivered one of its outbox prompts
  // (outbox.ts `settleDelivered`), so none delivers another. Kept with the outbox.
  delivered: Record<string, readonly string[]>;
}

export type Action =
  | { type: "paired"; pairing: StoredPairing }
  | { type: "unpaired" }
  // `lastSeenAt`: when the link last delivered a frame, so content that was live
  // until a drop is dated to the drop.
  | { type: "link"; status: LinkStatus; at: number; lastSeenAt: number | null }
  | { type: "frame"; frame: ServerFrame; at: number }
  | { type: "open"; id: string | null; at: number }
  | { type: "earlier"; id: string }
  | { type: "outbox-add"; frame: OutboxFrame; at: number; sent: boolean }
  | { type: "outbox-sent"; ids: ReadonlySet<string> }
  | { type: "outbox-cancel"; clientMsgId: string }
  | { type: "outbox-dismiss"; clientMsgId: string }
  // Paired again with the same Mac under a new token (outbox.ts `newDevice`).
  | { type: "outbox-new-device"; at: number };

export const EMPTY_SESSION: Session = Object.freeze({
  transcript: null,
  hasEarlier: false,
  turns: TURNS_PAGE,
  dialog: null,
  terminal: null,
  exit: null,
  refreshedAt: null,
}) as Session;

export function initialState(
  pairing: StoredPairing | null,
  saved: Partial<Pick<AppState, "instances" | "instancesAt" | "sessions" | "outbox" | "delivered">> & {
    lastSeenAt?: number | null;
  } = {}
): AppState {
  return {
    pairing,
    connection: {
      state: pairing ? "connecting" : "unpaired",
      hostName: pairing?.hostName ?? "",
      lastSeenAt: saved.lastSeenAt ?? null,
    },
    push: null,
    instances: saved.instances ?? null,
    instancesAt: saved.instancesAt ?? null,
    sessions: saved.sessions ?? {},
    openId: null,
    outbox: saved.outbox ?? [],
    delivered: saved.delivered ?? {},
  };
}

export function sessionOf(state: AppState, id: string): Session {
  return state.sessions[id] ?? EMPTY_SESSION;
}

export function reduce(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "paired":
      return {
        ...state,
        pairing: action.pairing,
        connection: { ...state.connection, state: "connecting", hostName: action.pairing.hostName },
      };
    case "unpaired":
      return initialState(null);
    case "link":
      return reduceLink(state, action.status, action.at, action.lastSeenAt);
    case "frame":
      return reduceFrame(state, action.frame, action.at);
    case "open": {
      if (action.id === state.openId) return state;
      let sessions = state.sessions;
      // The session being left was live until now.
      if (state.openId && state.connection.state === "connected") {
        sessions = patch(sessions, state.openId, { refreshedAt: action.at });
      }
      // Every open starts at the last TURNS_PAGE turns again.
      if (action.id) sessions = patch(sessions, action.id, { turns: TURNS_PAGE });
      return { ...state, sessions, openId: action.id };
    }
    case "earlier": {
      const session = sessionOf(state, action.id);
      return { ...state, sessions: patch(state.sessions, action.id, { turns: session.turns + TURNS_PAGE }) };
    }
    case "outbox-add":
      return { ...state, outbox: enqueue(state.outbox, action.frame, action.at, action.sent) };
    case "outbox-sent":
      return withOutbox(state, markSent(state.outbox, action.ids));
    case "outbox-cancel":
      return withOutbox(state, cancel(state.outbox, action.clientMsgId));
    case "outbox-dismiss":
      return withOutbox(state, dismiss(state.outbox, action.clientMsgId));
    case "outbox-new-device":
      return withOutbox(state, newDevice(state.outbox, action.at));
  }
}

function reduceLink(state: AppState, status: LinkStatus, at: number, lastSeenAt: number | null): AppState {
  const was = state.connection;
  let next: AppState = state;

  // Leaving `connected`: what was live is now as old as the last frame, and what
  // was on the socket may or may not have arrived.
  if (was.state === "connected" && status.state !== "connected") {
    const liveUntil = lastSeenAt ?? at;
    next = {
      ...next,
      outbox: socketLost(next.outbox, at),
      instancesAt: next.instances ? liveUntil : next.instancesAt,
      sessions: next.openId ? patch(next.sessions, next.openId, { refreshedAt: liveUntil }) : next.sessions,
    };
  }

  let connection: Connection;
  switch (status.state) {
    case "connected":
      connection = { state: "connected", hostName: status.authOk.hostName, lastSeenAt: at };
      next = { ...next, push: { vapidPublicKey: status.authOk.vapidPublicKey, enabled: status.authOk.pushEnabled } };
      break;
    case "connecting":
    case "paused":
      connection = { state: "connecting", hostName: was.hostName, lastSeenAt: lastSeenAt ?? was.lastSeenAt };
      break;
    case "offline":
      connection = {
        state: "offline",
        offline: status.reason,
        retrying: status.retrying,
        hostName: was.hostName,
        lastSeenAt: lastSeenAt ?? was.lastSeenAt,
      };
      break;
    case "refused":
      connection = {
        state: "refused",
        refused: status.reason,
        hostName: was.hostName,
        lastSeenAt: lastSeenAt ?? was.lastSeenAt,
      };
      break;
  }
  if (!state.pairing) connection = { ...connection, state: "unpaired" };
  if (sameConnection(was, connection) && next === state) return state;
  return { ...next, connection };
}

function reduceFrame(state: AppState, frame: ServerFrame, at: number): AppState {
  switch (frame.type) {
    case "instances": {
      const listed = new Set(frame.instances.map((i) => i.id));
      const sessions: Record<string, Session> = {};
      for (const [id, session] of Object.entries(state.sessions)) {
        // A contact removed at the desk takes its saved session with it.
        if (!listed.has(id) && id !== state.openId) continue;
        const instance = frame.instances.find((i) => i.id === id);
        // Only a session in needs-you has a dialog: one closed while the phone was
        // away sent its prompt-cleared to nobody.
        sessions[id] =
          session.dialog && instance && instance.state !== "needs-you" ? { ...session, dialog: null } : session;
      }
      return { ...state, instances: frame.instances, instancesAt: at, sessions };
    }
    case "transcript":
      return {
        ...state,
        sessions: patch(state.sessions, frame.instanceId, {
          transcript: frame.entries,
          hasEarlier: frame.hasEarlier,
          refreshedAt: at,
        }),
        ...settle(state, state.outbox, frame.instanceId, frame.entries),
      };
    case "snapshot":
    case "resize": {
      const current = sessionOf(state, frame.instanceId).terminal;
      if (current?.cols === frame.cols && current.rows === frame.rows) return state;
      return {
        ...state,
        sessions: patch(state.sessions, frame.instanceId, { terminal: { cols: frame.cols, rows: frame.rows } }),
      };
    }
    case "exit":
      return {
        ...state,
        sessions: patch(state.sessions, frame.instanceId, { exit: { code: frame.code, at }, dialog: null }),
      };
    case "prompt-state":
      return {
        ...state,
        sessions: patch(state.sessions, frame.instanceId, {
          dialog: frame.dialog
            ? { seq: frame.seq, summary: frame.summary, dialog: frame.dialog }
            : { seq: frame.seq, summary: frame.summary },
          refreshedAt: at,
        }),
      };
    case "prompt-cleared": {
      const dialog = sessionOf(state, frame.instanceId).dialog;
      if (!dialog || (frame.seq !== undefined && frame.seq !== dialog.seq)) return state;
      return { ...state, sessions: patch(state.sessions, frame.instanceId, { dialog: null, refreshedAt: at }) };
    }
    case "ack": {
      const item = state.outbox.find((i) => i.frame.clientMsgId === frame.clientMsgId);
      const acked = applyAck(state.outbox, frame, at);
      let next = withOutbox(state, acked);
      // A resent prompt's ack can come after the transcript that already shows it
      // (the resubscribe goes first).
      if (item?.frame.type === "prompt" && frame.ok) {
        const shown = sessionOf(state, item.frame.instanceId).transcript;
        if (shown) next = { ...next, ...settle(next, acked, item.frame.instanceId, shown) };
      }
      // The desktop now holds (or has dropped) this phone's push subscription.
      if (item?.frame.type === "push-subscribe" && frame.ok && next.push) {
        return { ...next, push: { ...next.push, enabled: item.frame.subscription !== null } };
      }
      return next;
    }
    // `output` goes to the terminal sink only; `auth-ok`, `auth-failed` and `pong`
    // are the link's (transport.ts); `error` is only logged.
    default:
      return state;
  }
}

// What a transcript settles of the outbox (outbox.ts `settleDelivered`), with the
// entries that did the settling noted for the next one.
function settle(
  state: AppState,
  outbox: OutboxItem[],
  instanceId: string,
  entries: TranscriptEntry[]
): Pick<AppState, "outbox" | "delivered"> {
  const settled = settleDelivered(outbox, instanceId, entries, state.delivered[instanceId]);
  if (settled.outbox === outbox) return { outbox, delivered: state.delivered };
  return { outbox: settled.outbox, delivered: { ...state.delivered, [instanceId]: settled.delivered } };
}

function patch(sessions: Record<string, Session>, id: string, change: Partial<Session>): Record<string, Session> {
  return { ...sessions, [id]: { ...(sessions[id] ?? EMPTY_SESSION), ...change } };
}

function withOutbox(state: AppState, outbox: OutboxItem[]): AppState {
  return outbox === state.outbox ? state : { ...state, outbox };
}

function sameConnection(a: Connection, b: Connection): boolean {
  return (
    a.state === b.state &&
    a.offline === b.offline &&
    a.retrying === b.retrying &&
    a.refused === b.refused &&
    a.hostName === b.hostName &&
    a.lastSeenAt === b.lastSeenAt
  );
}
