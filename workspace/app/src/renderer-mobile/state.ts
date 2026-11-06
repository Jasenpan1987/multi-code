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
  RemoteBrief,
  RemoteInstance,
  ServerFrame,
  TranscriptEntry,
} from "../shared/remote-protocol";
import type { BriefRef } from "../shared/secretaryQueue";
import { settleBar } from "./bar";
import {
  applyAck,
  cancel,
  dismiss,
  enqueue,
  instanceOf,
  markSent,
  newDevice,
  renewSession,
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
  // The CLI session the transcript is from (TranscriptFrame.session); null while the
  // Mac hasn't said (an older desktop).
  cli: string | null;
  // The phone saw that CLI session replace the one before it (`/new`, `/clear`), so
  // the chat starts at its start, under a "New session" mark.
  renewed: boolean;
  // Turns asked for in `subscribe`: TURNS_PAGE, plus TURNS_PAGE per "Earlier turns".
  turns: number;
  dialog: OpenDialog | null;
  // The PTY's size from the last snapshot or resize; the bytes go to the terminal
  // sink (store.ts), never through state.
  terminal: { cols: number; rows: number } | null;
  exit: { code: number; at: number } | null;
  refreshedAt: number | null;
}

// The secretary as the Mac last said (SecretaryFrame), its audio paths aside when it
// comes from the cache.
export interface SecretaryView {
  on: boolean;
  claudeFound: boolean;
  briefs: Record<string, RemoteBrief>;
}

// The secretary bar (epic secretary-bar): the brief it shows, which this phone moves
// through on its own (bar.ts keeps it to the shared queue's rules), and whether its
// panel is open.
export interface Bar {
  shown: BriefRef | null;
  open: boolean;
}

// A brief's reply box (bar.ts `refKey`): what is typed in it, and the reply last sent
// from it, kept here rather than in the box so that folding the panel or changing
// screens loses neither (epic secretary-bar, Story 7). `sentText` is what the box
// held when it was sent: its ack empties the box only while it still holds that.
export interface ReplyDraft {
  text: string;
  // Its outbox item says how it went, until another is sent from the box.
  sentId: string | null;
  sentText: string | null;
}

export const EMPTY_REPLY: ReplyDraft = Object.freeze({ text: "", sentId: null, sentText: null }) as ReplyDraft;

// The one brief this phone plays (player.ts): starting, playing, or why it couldn't.
export interface Player {
  ref: BriefRef | null;
  status: "idle" | "loading" | "playing" | "error";
  error?: string;
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
  // Null until the Mac says (one from before the epic never does) or the cache has it.
  secretary: SecretaryView | null;
  secretaryAt: number | null;
  // A `secretary` frame has come on this connection. Until one has, the secretary's
  // controls wait: a cached one may be from a newer Mac than the one answering, which
  // would never ack them. Its text still shows.
  secretaryLive: boolean;
  bar: Bar;
  replies: Record<string, ReplyDraft>;
  player: Player;
  // The briefs that have started playing on this phone (`<id>:<seq>`), so their
  // button says Replay. Not kept across launches.
  played: readonly string[];
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
  | { type: "outbox-new-device"; at: number }
  // The builder opened or folded the bar's panel, or moved it to another brief.
  | { type: "bar"; open?: boolean; shown?: BriefRef | null }
  // What the player is doing now.
  | { type: "player"; player: Player }
  // The builder typed in a brief's reply box, or sent what it holds.
  | { type: "reply-edit"; key: string; text: string }
  | { type: "reply-sent"; key: string; clientMsgId: string; text: string };

export const EMPTY_SESSION: Session = Object.freeze({
  transcript: null,
  hasEarlier: false,
  cli: null,
  renewed: false,
  turns: TURNS_PAGE,
  dialog: null,
  terminal: null,
  exit: null,
  refreshedAt: null,
}) as Session;

export const IDLE_PLAYER: Player = Object.freeze({ ref: null, status: "idle" }) as Player;
const FOLDED: Bar = Object.freeze({ shown: null, open: false }) as Bar;

export function initialState(
  pairing: StoredPairing | null,
  saved: Partial<
    Pick<AppState, "instances" | "instancesAt" | "sessions" | "outbox" | "delivered" | "secretary" | "secretaryAt">
  > & {
    lastSeenAt?: number | null;
  } = {}
): AppState {
  const state: AppState = {
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
    secretary: saved.secretary ?? null,
    secretaryAt: saved.secretaryAt ?? null,
    secretaryLive: false,
    bar: FOLDED,
    replies: {},
    player: IDLE_PLAYER,
    played: [],
  };
  // A cached secretary puts its brief on the bar at once.
  return state.secretary ? settleBar({ ...state, secretary: null }, state) : state;
}

export function sessionOf(state: AppState, id: string): Session {
  return state.sessions[id] ?? EMPTY_SESSION;
}

// Every change, then the bar kept to its rules (bar.ts).
export function reduce(state: AppState, action: Action): AppState {
  return settleBar(state, reduceAction(state, action));
}

function reduceAction(state: AppState, action: Action): AppState {
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
    case "bar":
      return {
        ...state,
        bar: {
          shown: action.shown !== undefined ? action.shown : state.bar.shown,
          open: action.open ?? state.bar.open,
        },
      };
    case "reply-edit": {
      const draft = state.replies[action.key] ?? EMPTY_REPLY;
      return { ...state, replies: { ...state.replies, [action.key]: { ...draft, text: action.text } } };
    }
    case "reply-sent": {
      const draft = state.replies[action.key] ?? EMPTY_REPLY;
      return {
        ...state,
        replies: { ...state.replies, [action.key]: { ...draft, sentId: action.clientMsgId, sentText: action.text } },
      };
    }
    case "player": {
      const { player } = action;
      const key = player.ref && player.status === "playing" ? `${player.ref.instanceId}:${player.ref.seq}` : null;
      const played = key && !state.played.includes(key) ? [...state.played, key] : state.played;
      return { ...state, player, played };
    }
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
      secretaryAt: next.secretary ? liveUntil : next.secretaryAt,
      sessions: next.openId ? patch(next.sessions, next.openId, { refreshedAt: liveUntil }) : next.sessions,
    };
  }

  let connection: Connection;
  switch (status.state) {
    case "connected":
      connection = { state: "connected", hostName: status.authOk.hostName, lastSeenAt: at };
      next = {
        ...next,
        push: { vapidPublicKey: status.authOk.vapidPublicKey, enabled: status.authOk.pushEnabled },
        // A new connection: its own `secretary` frame says what this Mac has.
        secretaryLive: false,
      };
      break;
    case "connecting":
    case "paused":
      connection = { state: "connecting", hostName: was.hostName, lastSeenAt: lastSeenAt ?? was.lastSeenAt };
      next = next.secretaryLive ? { ...next, secretaryLive: false } : next;
      break;
    case "offline":
      next = next.secretaryLive ? { ...next, secretaryLive: false } : next;
      connection = {
        state: "offline",
        offline: status.reason,
        retrying: status.retrying,
        hostName: was.hostName,
        lastSeenAt: lastSeenAt ?? was.lastSeenAt,
      };
      break;
    case "refused":
      next = next.secretaryLive ? { ...next, secretaryLive: false } : next;
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
    case "transcript": {
      const id = frame.instanceId;
      const was = sessionOf(state, id);
      const change: Partial<Session> = { transcript: frame.entries, hasEarlier: frame.hasEarlier, refreshedAt: at };
      if (frame.session !== undefined) change.cli = frame.session;
      // A new CLI session (`/new`, `/clear`): the chat starts afresh, at its last
      // page of turns, and nothing sent to the old one waits to show in it. A frame
      // that doesn't say, or the first that does, is no change.
      if (frame.session === undefined || was.cli === null || frame.session === was.cli) {
        return { ...state, sessions: patch(state.sessions, id, change), ...settle(state, state.outbox, id, frame.entries) };
      }
      const fresh = { ...state, delivered: Object.fromEntries(Object.entries(state.delivered).filter(([key]) => key !== id)) };
      return {
        ...fresh,
        sessions: patch(state.sessions, id, { ...change, renewed: true, turns: TURNS_PAGE }),
        ...settle(fresh, renewSession(state.outbox, id), id, frame.entries),
      };
    }
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
      let acked = applyAck(state.outbox, frame, at);
      // OpenCode's transcript shows no commands (its TUI runs `/new` or `/models`
      // itself, and a command of the project's reaches the model as its template), so
      // nothing would ever settle a slash command sent to it: its ack does.
      if (item?.frame.type === "prompt" && frame.ok && item.frame.text.trimStart().startsWith("/")) {
        const backend = state.instances?.find((i) => i.id === instanceOf(item))?.backend;
        if (backend === "opencode") acked = acked.filter((i) => i.frame.clientMsgId !== frame.clientMsgId);
      }
      let next = withOutbox(state, acked);
      // A resent prompt's ack can come after the transcript that already shows it
      // (the resubscribe goes first).
      if (item?.frame.type === "prompt" && frame.ok) {
        const shown = sessionOf(state, item.frame.instanceId).transcript;
        if (shown) next = { ...next, ...settle(next, acked, item.frame.instanceId, shown) };
      }
      // A reply the secretary took: its box empties, unless the builder has typed in it
      // since (Story 7).
      if (item?.frame.type === "secretary-reply" && frame.ok) {
        const entry = Object.entries(next.replies).find(([, d]) => d.sentId === frame.clientMsgId);
        if (entry) {
          const [key, draft] = entry;
          const text = draft.text === draft.sentText ? "" : draft.text;
          next = { ...next, replies: { ...next.replies, [key]: { ...draft, text, sentText: null } } };
        }
      }
      // The desktop now holds (or has dropped) this phone's push subscription.
      if (item?.frame.type === "push-subscribe" && frame.ok && next.push) {
        return { ...next, push: { ...next.push, enabled: item.frame.subscription !== null } };
      }
      return next;
    }
    case "secretary": {
      // The reply boxes of briefs that went, go.
      const replies = Object.fromEntries(
        Object.entries(state.replies).filter(([key]) =>
          Object.entries(frame.briefs).some(([id, brief]) => key === `${id}:${brief.seq}`)
        )
      );
      return {
        ...state,
        secretary: { on: frame.on, claudeFound: frame.claudeFound, briefs: frame.briefs },
        secretaryAt: at,
        secretaryLive: true,
        replies,
      };
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
