// The harness's only contact with the real RemoteServer (main/remote/ws-server.ts):
// the RemoteHost it is given, over the scripted world, and a Tailscale checker that
// says HTTPS is ready at the port itself, so no tailscale command ever runs. The
// server does protocol v3 itself (T-803): subscribe by turns, the PTY's size, the
// dialog in full, acks and their refusals, the last 200 clientMsgIds per device. The
// host below gates each frame the way the desktop's (main/remote/remote-host.ts)
// does, holding answers to the dialog with the secretary's checkChoice.
//
// Web Push is the server's own too (T-810): `auth-ok` carries the VAPID key it keeps
// in the harness's userData, and `push-subscribe` is stored on the device. Nothing
// here pushes: the host below never asks the server to, and with the harness's
// plain-http origin as the VAPID subject web-push would refuse to sign one anyway.
//
// What is still grafted onto the server's private members, by bracket access (which
// TypeScript still checks, so `pnpm type` fails here when the server reshapes them):
//   - the log of what phones sent, with each ack and whether it was a resend;
//   - sockets told to play dead (half-open), and the host name;
//   - the connection list, for `drop`, `half-open` and `sockets`.

import type { TailnetChecks } from "../../src/main/remote/tailscale";
import type { HostAck, RemoteServer } from "../../src/main/remote/ws-server";
import type { Dialog, checkChoice as CheckChoice } from "../../src/main/secretary/dialog";
import type { AckFrame, ClientFrame, RemoteChoice, RemoteDialog } from "../../src/shared/remote-protocol";
import type { World } from "./world.ts";

type Conn = Parameters<RemoteServer["send"]>[0];

// Everything a phone sent that the phone tickets check: what a key sent, which
// answer went out, whether a resent prompt was acted on once.
export interface LogEntry {
  at: number;
  device: string | null;
  frame: ClientFrame;
  ack?: AckFrame;
  // A resend of a clientMsgId already handled: answered again, not acted on.
  resent?: boolean;
}

const LOG_LIMIT = 500;
// Home and clear: a stopped session's screen, which has nothing on it.
const CLEAR_SCREEN = "\x1b[H\x1b[2J";
// As many as the server remembers, so `resent` says what the server did.
const IDS_PER_DEVICE = 200;

const refuse = (reason: Extract<HostAck, { ok: false }>["reason"], message: string): HostAck => ({
  ok: false,
  reason,
  message,
});

export function attach(
  server: RemoteServer,
  world: World,
  checkChoice: typeof CheckChoice,
  options: { hostName: string; print?: (line: string) => void }
) {
  const print = options.print ?? (() => {});
  let port = 0;
  let offerUrl = "";
  const log: LogEntry[] = [];
  // Sockets told to play dead: nothing in, nothing out, pings included.
  const silent = new WeakSet<Conn>();
  // The clientMsgIds each device sent, for the log's `resent`.
  const sentIds = new Map<string, Set<string>>();
  // The seq each session's last prompt-state carried, to know when to clear it.
  const shownSeq = new Map<string, number>();
  for (const { id } of world.list()) {
    const d = world.dialogOf(id);
    if (d) shownSeq.set(id, d.seq);
  }

  // An accepted action changes the world at once, with the check it passed, so a
  // scenario reset or a tick can't slip in between; what it changed goes out after
  // the ack, as at the desk: the desktop acks once it has written the keys, and the
  // CLI reacts after.
  let held: { ids: Set<string>; reset: boolean } | null = null;
  const after = (change: () => void): HostAck => {
    if (!held) {
      held = { ids: new Set(), reset: false };
      setTimeout(release, 0);
    }
    change();
    return { ok: true };
  };
  function release() {
    const told = held;
    held = null;
    if (told && (told.ids.size > 0 || told.reset)) changed([...told.ids], told.reset);
  }

  server.setHost({
    listInstances: () => world.list(),
    liveDialog: (id) => world.dialogOf(id) ?? null,
    markSeen: (id) => world.markSeen(id),
    readTranscript: (id, turns) => world.transcript(id, turns),
    ptySize: (id) => {
      if (!world.has(id)) return null;
      const { cols, rows } = world.terminal(id);
      return { cols, rows };
    },
    // The world says what each session is doing itself.
    refreshPreview: () => {},
    writeToInstance: (id, data) => world.input(id, data),

    async sendPrompt(id, text) {
      const session = world.stateOf(id);
      if (!session?.running) return refuse("not-running", "This session isn't running.");
      if (session.state === "needs-you") {
        return refuse("dialog-open", "A dialog is open: answer it first, so the text doesn't land in it.");
      }
      if (!text.trim()) return refuse("failed", "Nothing to send");
      return after(() => world.prompt(id, text));
    },

    async interrupt(id) {
      const session = world.stateOf(id);
      if (!session?.running) return refuse("not-running", "This session isn't running.");
      if (session.state === "needs-you") {
        return refuse("dialog-open", "A dialog is open, and Esc would answer it. Answer it instead.");
      }
      if (session.state !== "working") return refuse("not-working", "Nothing to stop: the session isn't in a turn.");
      return after(() => world.interrupt(id));
    },

    async answer(id, seq, choice, confirmed) {
      const session = world.stateOf(id);
      const d = world.dialogOf(id);
      if (!session || !d || d.seq !== seq) {
        return refuse("gone", "That dialog was already answered, or replaced by a newer one.");
      }
      if (!d.dialog) return refuse("unsupported", "The phone can't answer this dialog. Use the terminal.");
      // As the desktop's choiceOf (remote-host.ts): read as one of the two shapes, and
      // what can't be is refused before the world changes.
      const parsed = choiceOf(choice);
      if (!parsed) return refuse("unsupported", "That isn't one of this dialog's options.");
      const checked = checkChoice(secretaryDialog(d.dialog, session.backend), explicit(parsed), confirmed);
      if (checked.ok) return after(() => world.answer(id, parsed));
      if ("refuse" in checked) return refuse("unsupported", "That answer doesn't fit this dialog. Use the terminal.");
      switch (checked.ask) {
        case "confirm-always":
        case "confirm-auto":
          return refuse("needs-confirm", "This lets the agent do more from now on: confirm it first.");
        case "what-to-change":
          return refuse("failed", "Say what the plan should change.");
        case "unanswered":
          return refuse("failed", "Answer every question first.");
        default:
          return refuse("failed", "Pick one of the dialog's options.");
      }
    },
  });
  server["hostName"] = () => `Multi-Code on ${options.hostName}`;
  // Tailscale is never asked: the harness says HTTPS is ready at the port itself,
  // which is what lets the server make a pairing offer for it.
  const ready = (port: number): TailnetChecks => ({
    tailscale: { state: "running", dnsName: "127.0.0.1" },
    https: { state: "ready", origin: `http://127.0.0.1:${port}` },
  });
  server.setChecker({
    check: async (port) => ready(port),
    setUpHttps: async (port) => ({ checks: ready(port) }),
  });

  const send = server["send"].bind(server);
  server["send"] = (conn, frame) => {
    if (silent.has(conn)) return;
    if (frame.type === "ack") noteAck(conn, frame);
    send(conn, frame);
  };

  const handle = server["handleClientFrame"].bind(server);
  server["handleClientFrame"] = (conn, frame) => {
    if (silent.has(conn)) return;
    if (!conn.authed || frame.type === "auth") return handle(conn, frame);
    switch (frame.type) {
      case "push-subscribe":
      case "prompt":
      case "answer":
      case "interrupt":
      case "input":
        record(conn, frame);
        return handle(conn, frame);
      default:
        return handle(conn, frame);
    }
  };

  // The screen each session starts at, streamed, so a phone's snapshot (the server
  // replays the tail of what was streamed) ends on it: every paint starts by
  // clearing the screen, and a stopped session's screen is just that.
  const repaintAll = () => {
    for (const { id } of world.list()) server.broadcastOutput(id, world.repaint(id) ?? CLEAR_SCREEN);
  };
  repaintAll();

  world.onChange = (ids, reset) => {
    if (!held) return changed(ids, reset);
    for (const id of ids) held.ids.add(id);
    held.reset ||= reset;
  };

  function changed(ids: string[], reset: boolean) {
    for (const id of ids) {
      const d = world.dialogOf(id);
      const shown = shownSeq.get(id);
      if (shown !== undefined && shown !== d?.seq) server.broadcastPromptCleared(id, shown);
      if (d && d.seq !== shown) server.broadcastPromptState(id);
      if (d) shownSeq.set(id, d.seq);
      else shownSeq.delete(id);
      server.broadcastTranscript(id);
      if (!reset) {
        const paint = world.repaint(id);
        if (paint) server.broadcastOutput(id, paint);
      }
    }
    if (reset) {
      // A new scenario is a new screen at the scenario's size.
      for (const { id } of world.list()) {
        const { cols, rows } = world.terminal(id);
        server.broadcastResize(id, cols, rows);
      }
      repaintAll();
      // Sessions the new scenario doesn't have take their dialogs with them.
      for (const [id, seq] of shownSeq) {
        if (world.has(id)) continue;
        server.broadcastPromptCleared(id, seq);
        shownSeq.delete(id);
      }
    }
    server.broadcastInstances();
  }

  function record(conn: Conn, frame: ClientFrame) {
    let resent = false;
    if ("clientMsgId" in frame && conn.deviceId) {
      let ids = sentIds.get(conn.deviceId);
      if (!ids) sentIds.set(conn.deviceId, (ids = new Set()));
      resent = ids.has(frame.clientMsgId);
      ids.add(frame.clientMsgId);
      if (ids.size > IDS_PER_DEVICE) ids.delete(ids.values().next().value!);
    }
    log.push({ at: Date.now(), device: conn.deviceId, frame, ...(resent ? { resent } : {}) });
    if (log.length > LOG_LIMIT) log.shift();
    if (frame.type === "input") print(line(frame));
  }

  // The ack goes on the newest entry for its clientMsgId that has none yet.
  function noteAck(conn: Conn, ack: AckFrame) {
    const entry = log.findLast(
      (e) => !e.ack && e.device === conn.deviceId && "clientMsgId" in e.frame && e.frame.clientMsgId === ack.clientMsgId
    );
    if (!entry) return;
    entry.ack = ack;
    print(line(entry.frame, ack, entry.resent));
  }

  function line(frame: ClientFrame, ack?: AckFrame, resent?: boolean): string {
    const { type, ...rest } = frame;
    const result = ack ? ` → ${ack.ok ? "ok" : ack.reason}` : "";
    return `${new Date().toTimeString().slice(0, 8)} ${type} ${JSON.stringify(rest)}${result}${resent ? " (resent)" : ""}`;
  }

  return {
    log,

    async start(wanted: number): Promise<number> {
      const status = await server.start(wanted);
      if (!status.port) throw new Error(status.error ?? "the server didn't start");
      port = status.port;
      const offer = server.createPairingOffer();
      if (!offer) throw new Error("the server made no pairing offer (its HTTPS check isn't ready)");
      // Encoded as ipc-handlers.ts encodes the QR's.
      offerUrl = `${offer.origin}/#pair=${Buffer.from(JSON.stringify(offer), "utf8").toString("base64url")}`;
      return port;
    },

    async stop() {
      world.stop();
      await server.stop();
    },

    pairingUrl: () => offerUrl,

    // The network went away: every socket is cut without a close frame.
    drop(): number {
      const all = [...server["connections"]];
      for (const conn of all) conn.socket.terminate();
      return all.length;
    },

    // The sockets open now stay open but go quiet, as iOS leaves them after a lock.
    halfOpen(): number {
      const all = [...server["connections"]];
      for (const conn of all) silent.add(conn);
      return all.length;
    },

    // The Mac is unreachable: nothing listens on the port until `online`.
    offline: () => server.stop(),
    async online() {
      if (server.isRunning()) return;
      const status = await server.start(port);
      if (!status.port) throw new Error(status.error ?? `the server didn't start on port ${port}`);
    },

    // The desktop resized that terminal: the server tells subscribers, the world
    // repaints at the new size.
    resize(id: string, cols: number, rows: number): boolean {
      if (!world.has(id)) return false;
      server.broadcastResize(id, cols, rows);
      return world.resize(id, cols, rows);
    },

    sockets() {
      return [...server["connections"]].map((c) => ({
        device: c.deviceId,
        authed: c.authed,
        subscriptions: [...c.subscriptions.keys()],
        halfOpen: silent.has(c),
      }));
    },

    isOnline: () => server.isRunning(),
  };
}

export type Bridge = ReturnType<typeof attach>;

// The secretary's dialog shape, which checkChoice holds a choice to.
function secretaryDialog(d: RemoteDialog, backend: string): Dialog {
  const name = backend === "opencode" ? "opencode" : "claude";
  if (d.kind === "permission") {
    return { kind: "permission", backend: name, toolName: d.tool, toolInput: {}, options: d.options };
  }
  if (d.kind === "plan") return d;
  return { kind: "questions", backend: name, questions: d.questions };
}

// A button the builder pressed is an explicit choice, so a widening one comes back
// as needs-confirm rather than as a question about which one was meant.
const EFFECTS: ReadonlySet<string> = new Set(["allow-once", "allow-always", "deny", "approve", "approve-auto", "revise"]);

// The phone's choice as the desktop reads it (remote-host.ts choiceOf): an effect
// wins over answers, and anything else in the frame is dropped; null for a shape it
// can't be.
function choiceOf(value: RemoteChoice): RemoteChoice | null {
  const c = value as unknown as Record<string, unknown> | null;
  if (!c || typeof c !== "object") return null;
  if (typeof c.effect === "string") {
    if (!EFFECTS.has(c.effect)) return null;
    if (c.feedback !== undefined && typeof c.feedback !== "string") return null;
    const effect = c.effect as Extract<RemoteChoice, { effect: unknown }>["effect"];
    return c.feedback === undefined ? { effect } : { effect, feedback: c.feedback };
  }
  if (!Array.isArray(c.answers)) return null;
  const answers: Extract<RemoteChoice, { answers: unknown }>["answers"] = [];
  for (const raw of c.answers as unknown[]) {
    const a = raw as Record<string, unknown> | null;
    if (!a || typeof a !== "object" || typeof a.question !== "number" || !Array.isArray(a.picks)) return null;
    if (!a.picks.every((p: unknown) => typeof p === "number")) return null;
    if (a.text !== undefined && typeof a.text !== "string") return null;
    answers.push({ question: a.question, picks: a.picks as number[], ...(a.text !== undefined ? { text: a.text } : {}) });
  }
  return { answers };
}

function explicit(choice: RemoteChoice) {
  return "effect" in choice ? { ...choice, explicit: true } : choice;
}
