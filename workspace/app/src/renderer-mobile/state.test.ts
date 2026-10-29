// The reducer, frame by frame: what each server frame and link change does to the
// state the screens draw, and the ages the offline banner shows.

import { describe, expect, it } from "vitest";
import type { AuthOkFrame, RemoteInstance, ServerFrame } from "../shared/remote-protocol";
import type { StoredPairing } from "./pairing";
import { EMPTY_SESSION, TURNS_PAGE, initialState, reduce, sessionOf, type Action, type AppState } from "./state";
import type { LinkStatus } from "./transport";

const pairing: StoredPairing = {
  origin: "https://mac.tailnet.ts.net",
  hostPublicKey: "key",
  deviceToken: "token",
  hostName: "Multi-Code on MacBook Air",
};
const authOk: AuthOkFrame = {
  type: "auth-ok",
  hostName: "Multi-Code on MacBook Air",
  vapidPublicKey: "vapid",
  pushEnabled: false,
};
const instance = (id: string, state: RemoteInstance["state"], extra: Partial<RemoteInstance> = {}): RemoteInstance => ({
  id,
  name: id,
  cwd: `/code/${id}`,
  backend: "claude",
  status: "running",
  state,
  ...extra,
});

const link = (status: LinkStatus, at: number, lastSeenAt: number | null = null): Action => ({
  type: "link",
  status,
  at,
  lastSeenAt,
});
const frame = (f: ServerFrame, at = 1000): Action => ({ type: "frame", frame: f, at });
const run = (state: AppState, ...actions: Action[]) => actions.reduce(reduce, state);
const connected = (at = 100) => run(initialState(pairing), link({ state: "connected", authOk }, at));

describe("state reducer", () => {
  it("starts unpaired without a pairing, connecting with one", () => {
    expect(initialState(null).connection.state).toBe("unpaired");
    expect(initialState(pairing).connection).toMatchObject({ state: "connecting", hostName: pairing.hostName });
    // A status from a link has no say while there is no pairing.
    expect(reduce(initialState(null), link({ state: "offline", reason: null, retrying: false }, 1)).connection.state).toBe(
      "unpaired"
    );
  });

  it("takes the host name and push state from auth-ok", () => {
    const state = run(
      initialState(pairing),
      link({ state: "connected", authOk: { ...authOk, hostName: "Multi-Code on Studio", pushEnabled: true } }, 5)
    );
    expect(state.connection).toEqual({ state: "connected", hostName: "Multi-Code on Studio", lastSeenAt: 5 });
    expect(state.push).toEqual({ vapidPublicKey: "vapid", enabled: true });
  });

  it("dates what was live to the last frame when the link drops", () => {
    let state = run(
      connected(100),
      frame({ type: "instances", instances: [instance("a", "working")] }, 200),
      { type: "open", id: "a", at: 210 },
      frame({ type: "transcript", instanceId: "a", entries: [], hasEarlier: false }, 220)
    );
    state = reduce(state, link({ state: "offline", reason: "mac-unreachable", retrying: false }, 9000, 8000));
    expect(state.connection).toMatchObject({ state: "offline", offline: "mac-unreachable", lastSeenAt: 8000 });
    expect(state.instancesAt).toBe(8000);
    expect(sessionOf(state, "a").refreshedAt).toBe(8000);
    // Later failures don't move the ages: nothing new arrived.
    state = reduce(state, link({ state: "offline", reason: "mac-unreachable", retrying: true }, 12_000, 8000));
    expect(state.instancesAt).toBe(8000);
    expect(state.connection.retrying).toBe(true);
  });

  it("marks what was on the socket when the link drops, and a hidden page counts as a drop", () => {
    let state = run(connected(), { type: "outbox-add", frame: { type: "interrupt", instanceId: "a", clientMsgId: "i1" }, at: 1, sent: true });
    state = reduce(state, link({ state: "paused" }, 50, 40));
    expect(state.connection.state).toBe("connecting");
    expect(state.outbox[0].status).toBe("unknown");
  });

  it("returns the same state for a status that changes nothing", () => {
    const state = run(initialState(pairing), link({ state: "offline", reason: null, retrying: false }, 1, null));
    expect(reduce(state, link({ state: "offline", reason: null, retrying: false }, 2, null))).toBe(state);
  });

  it("says why the Mac refused the phone", () => {
    const state = reduce(connected(), link({ state: "refused", reason: "revoked" }, 5, 4));
    expect(state.connection).toMatchObject({ state: "refused", refused: "revoked" });
  });

  it("keeps the instance list, and drops the dialog of a session that isn't needs-you any more", () => {
    let state = run(
      connected(),
      frame({ type: "prompt-state", instanceId: "a", seq: 3, summary: "Bash: ls" }),
      frame({ type: "prompt-state", instanceId: "b", seq: 4, summary: "Question" })
    );
    // The prompt-cleared for "a" went out while the phone was away.
    state = reduce(
      state,
      frame({ type: "instances", instances: [instance("a", "working"), instance("b", "needs-you")] }, 2000)
    );
    expect(state.instances?.map((i) => i.id)).toEqual(["a", "b"]);
    expect(state.instancesAt).toBe(2000);
    expect(sessionOf(state, "a").dialog).toBeNull();
    expect(sessionOf(state, "b").dialog).toEqual({ seq: 4, summary: "Question" });
  });

  it("forgets the saved session of a contact removed at the desk, but not the open one", () => {
    let state = run(
      connected(),
      frame({ type: "transcript", instanceId: "gone", entries: [], hasEarlier: false }),
      frame({ type: "transcript", instanceId: "open", entries: [], hasEarlier: false }),
      { type: "open", id: "open", at: 1 }
    );
    state = reduce(state, frame({ type: "instances", instances: [instance("kept", "idle")] }));
    expect(Object.keys(state.sessions).sort()).toEqual(["open"]);
  });

  it("replaces the transcript and settles the prompts it now shows", () => {
    let state = run(
      connected(),
      { type: "outbox-add", frame: { type: "prompt", instanceId: "a", text: "go on", clientMsgId: "p1" }, at: 500, sent: true },
      frame({ type: "ack", clientMsgId: "p1", ok: true }, 600)
    );
    expect(state.outbox[0].status).toBe("acked");
    state = reduce(
      state,
      frame(
        {
          type: "transcript",
          instanceId: "a",
          entries: [{ kind: "user", text: "go on", at: 700 }, { kind: "assistant", text: "On it." }],
          hasEarlier: true,
        },
        800
      )
    );
    expect(sessionOf(state, "a")).toMatchObject({ hasEarlier: true, refreshedAt: 800 });
    expect(sessionOf(state, "a").transcript).toHaveLength(2);
    expect(state.outbox).toEqual([]);
  });

  it("settles a resent prompt whose transcript came before its ack", () => {
    let state = run(
      connected(),
      { type: "outbox-add", frame: { type: "prompt", instanceId: "a", text: "go on", clientMsgId: "p1" }, at: 500, sent: true },
      // The socket dropped before the ack; on the new one the resubscribe's
      // transcript, which already shows the message, comes before the resend's ack.
      link({ state: "connecting" }, 550, 540),
      link({ state: "connected", authOk }, 560),
      { type: "outbox-sent", ids: new Set(["p1"]) },
      frame({ type: "transcript", instanceId: "a", entries: [{ kind: "user", text: "go on", at: 520 }], hasEarlier: false }, 570)
    );
    expect(state.outbox.map((i) => i.status)).toEqual(["sent"]);
    state = reduce(state, frame({ type: "ack", clientMsgId: "p1", ok: true }, 580));
    expect(state.outbox).toEqual([]);
  });

  it("settles one of two identical resent prompts when the transcript before their acks shows one", () => {
    const go = (id: string, at: number): Action => ({
      type: "outbox-add",
      frame: { type: "prompt", instanceId: "a", text: "go", clientMsgId: id },
      at,
      sent: true,
    });
    let state = run(
      connected(),
      go("p1", 500),
      go("p2", 510),
      frame({ type: "transcript", instanceId: "a", entries: [{ kind: "user", id: "u1", text: "go", at: 520 }], hasEarlier: false }, 570),
      frame({ type: "ack", clientMsgId: "p1", ok: true }, 580),
      frame({ type: "ack", clientMsgId: "p2", ok: true }, 590)
    );
    // u1 delivered p1; p2 is still on its way through the CLI.
    expect(state.outbox.map((i) => [i.frame.clientMsgId, i.status])).toEqual([["p2", "acked"]]);
    state = reduce(state, frame({ type: "transcript", instanceId: "a", entries: [{ kind: "user", id: "u1", text: "go", at: 520 }], hasEarlier: false }, 600));
    expect(state.outbox).toHaveLength(1);
    state = reduce(
      state,
      frame(
        {
          type: "transcript",
          instanceId: "a",
          entries: [
            { kind: "user", id: "u1", text: "go", at: 520 },
            { kind: "user", id: "u2", text: "go", at: 610 },
          ],
          hasEarlier: false,
        },
        620
      )
    );
    expect(state.outbox).toEqual([]);
  });

  it("clears a dialog only for its own seq", () => {
    const dialog = { kind: "plan" as const, plan: "# Plan", options: [] };
    let state = reduce(connected(), frame({ type: "prompt-state", instanceId: "a", seq: 9, summary: "Plan", dialog }));
    expect(sessionOf(state, "a").dialog).toEqual({ seq: 9, summary: "Plan", dialog });
    expect(reduce(state, frame({ type: "prompt-cleared", instanceId: "a", seq: 8 }))).toBe(state);
    state = reduce(state, frame({ type: "prompt-cleared", instanceId: "a", seq: 9 }));
    expect(sessionOf(state, "a").dialog).toBeNull();
    // Without a seq, whatever is open closes.
    state = run(
      state,
      frame({ type: "prompt-state", instanceId: "a", seq: 10, summary: "Plan" }),
      frame({ type: "prompt-cleared", instanceId: "a" })
    );
    expect(sessionOf(state, "a").dialog).toBeNull();
  });

  it("keeps the PTY size from snapshots and resizes, and ignores output", () => {
    let state = reduce(connected(), frame({ type: "snapshot", instanceId: "a", data: "x", cols: 120, rows: 36 }));
    expect(sessionOf(state, "a").terminal).toEqual({ cols: 120, rows: 36 });
    expect(reduce(state, frame({ type: "snapshot", instanceId: "a", data: "y", cols: 120, rows: 36 }))).toBe(state);
    expect(reduce(state, frame({ type: "output", instanceId: "a", data: "z" }))).toBe(state);
    state = reduce(state, frame({ type: "resize", instanceId: "a", cols: 100, rows: 30 }));
    expect(sessionOf(state, "a").terminal).toEqual({ cols: 100, rows: 30 });
  });

  it("notes an exit and closes the dialog with it", () => {
    let state = reduce(connected(), frame({ type: "prompt-state", instanceId: "a", seq: 1, summary: "x" }));
    state = reduce(state, frame({ type: "exit", instanceId: "a", code: 0 }, 3000));
    expect(sessionOf(state, "a")).toMatchObject({ exit: { code: 0, at: 3000 }, dialog: null });
  });

  it("follows the push subscription's acks", () => {
    let state = run(connected(), {
      type: "outbox-add",
      frame: { type: "push-subscribe", subscription: { endpoint: "e", keys: { p256dh: "p", auth: "a" } }, clientMsgId: "s1" },
      at: 1,
      sent: true,
    });
    state = reduce(state, frame({ type: "ack", clientMsgId: "s1", ok: true }));
    expect(state.push?.enabled).toBe(true);
    expect(state.outbox).toEqual([]);
    state = run(
      state,
      { type: "outbox-add", frame: { type: "push-subscribe", subscription: null, clientMsgId: "s2" }, at: 2, sent: true },
      frame({ type: "ack", clientMsgId: "s2", ok: true })
    );
    expect(state.push?.enabled).toBe(false);
  });

  it("opens a session at the last page of turns, and dates the one it leaves", () => {
    let state = run(connected(), { type: "open", id: "a", at: 10 }, { type: "earlier", id: "a" });
    expect(sessionOf(state, "a").turns).toBe(2 * TURNS_PAGE);
    state = run(state, { type: "open", id: "b", at: 20 });
    expect(state.openId).toBe("b");
    expect(sessionOf(state, "a").refreshedAt).toBe(20);
    state = reduce(state, { type: "open", id: "a", at: 30 });
    expect(sessionOf(state, "a").turns).toBe(TURNS_PAGE);
    expect(reduce(state, { type: "open", id: "a", at: 40 })).toBe(state);
  });

  it("ignores frames that change nothing, and answers an unknown session with the empty one", () => {
    const state = connected();
    expect(reduce(state, frame({ type: "pong", at: 1 }))).toBe(state);
    expect(reduce(state, frame({ type: "error", message: "x" }))).toBe(state);
    expect(sessionOf(state, "nobody")).toBe(EMPTY_SESSION);
  });

  it("forgets everything when unpaired", () => {
    const state = run(connected(), frame({ type: "instances", instances: [instance("a", "idle")] }), { type: "unpaired" });
    expect(state).toEqual(initialState(null));
  });
});
