// The harness's only contact with the real RemoteServer (main/remote/ws-server.ts):
// the RemoteHost it is given, over the scripted world; a Tailscale checker that says
// HTTPS is ready at the port itself, so no tailscale command ever runs; and the part
// of protocol v3 the server doesn't do yet, done here the way the kanban says the
// desktop will (mobile-v2 T-803, T-810):
//   - subscribe: the last `turns` turns with `hasEarlier`, the PTY's size, the
//     dialog in full, and a Finished session marked seen;
//   - acks for prompt / answer / interrupt / push-subscribe, refusals included, and
//     the last 200 clientMsgIds per device remembered so a resend gets the same ack
//     and isn't acted on twice;
//   - auth-ok with a VAPID key and whether the device subscribed to push.
// Those are grafted onto the server's private frame handler and `send`, reached by
// bracket access, which TypeScript still checks: when the server renames or
// reshapes them, `pnpm type` fails here instead of the harness drifting quietly.
// Adapting it then means deleting the graft for whatever the server now does
// itself, and implementing the new RemoteHost members over the world.

import crypto from "node:crypto";
import type { TailnetChecks } from "../../src/main/remote/tailscale";
import type { RemoteServer } from "../../src/main/remote/ws-server";
import type { Dialog, checkChoice as CheckChoice } from "../../src/main/secretary/dialog";
import type {
  AckFrame,
  AckRefusal,
  AnswerFrame,
  ClientFrame,
  InterruptFrame,
  PromptFrame,
  PushSubscribeFrame,
  RemoteChoice,
  RemoteDialog,
  ServerFrame,
} from "../../src/shared/remote-protocol";
import type { World } from "./world.ts";

type Conn = Parameters<RemoteServer["send"]>[0];
type AckedFrame = PromptFrame | AnswerFrame | InterruptFrame | PushSubscribeFrame;

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
const ACKS_PER_DEVICE = 200;
const DEFAULT_TURNS = 10;

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
  const turnsOf = new WeakMap<Conn, Map<string, number>>();
  const acks = new Map<string, Map<string, AckFrame>>();
  const pushDevices = new Set<string>();
  // A real P-256 key, so a browser's pushManager.subscribe accepts it.
  const vapidPublicKey = crypto.createECDH("prime256v1").generateKeys().toString("base64url");
  // The seq each session's last prompt-state carried, to know when to clear it.
  const shownSeq = new Map<string, number>();
  for (const { id } of world.list()) {
    const d = world.dialogOf(id);
    if (d) shownSeq.set(id, d.seq);
  }

  server.setHost({
    listInstances: () => world.list(),
    writeToInstance: (id, data) => world.input(id, data),
    // Never called: `prompt` frames are handled below, with their acks.
    sendPrompt: () => {},
    // Transcripts go out below, by turns; the server's own fixed-size read finds nothing.
    readTranscript: () => [],
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
    send(
      conn,
      frame.type === "auth-ok"
        ? { ...frame, vapidPublicKey, pushEnabled: pushDevices.has(conn.deviceId ?? "") }
        : frame
    );
  };
  const out = (conn: Conn, frame: ServerFrame) => server["send"](conn, frame);

  const handle = server["handleClientFrame"].bind(server);
  server["handleClientFrame"] = (conn, frame) => {
    if (silent.has(conn)) return;
    if (!conn.authed || frame.type === "auth") return handle(conn, frame);
    switch (frame.type) {
      case "subscribe":
        return subscribe(conn, frame.instanceId, frame.turns ?? DEFAULT_TURNS);
      case "prompt":
      case "answer":
      case "interrupt":
      case "push-subscribe":
        return acked(conn, frame);
      case "input":
        record(conn, frame);
        return handle(conn, frame);
      default:
        return handle(conn, frame);
    }
  };

  world.onChange = (ids, reset) => {
    for (const id of ids) {
      const d = world.dialogOf(id);
      const shown = shownSeq.get(id);
      if (shown !== undefined && shown !== d?.seq) {
        server["broadcast"]({ type: "prompt-cleared", instanceId: id, seq: shown });
      }
      if (d && d.seq !== shown) server["broadcast"](promptState(id));
      if (d) shownSeq.set(id, d.seq);
      else shownSeq.delete(id);

      for (const conn of subscribers(id)) {
        sendTranscript(conn, id);
        // A new scenario is a new screen at the scenario's size.
        if (reset) out(conn, { type: "snapshot", instanceId: id, ...world.terminal(id) });
      }
      const paint = reset ? null : world.repaint(id);
      if (paint) server.broadcastOutput(id, paint);
    }
    if (reset) {
      // Sessions the new scenario doesn't have take their dialogs with them.
      for (const [id, seq] of shownSeq) {
        if (world.has(id)) continue;
        server["broadcast"]({ type: "prompt-cleared", instanceId: id, seq });
        shownSeq.delete(id);
      }
    }
    server.broadcastInstances();
  };

  function subscribers(id: string): Conn[] {
    return [...server["connections"]].filter((c) => c.authed && c.subscriptions.has(id));
  }

  function promptState(id: string): ServerFrame {
    const d = world.dialogOf(id)!;
    return {
      type: "prompt-state",
      instanceId: id,
      seq: d.seq,
      summary: d.summary,
      ...(d.dialog ? { dialog: d.dialog } : {}),
    };
  }

  function sendTranscript(conn: Conn, id: string) {
    const turns = turnsOf.get(conn)?.get(id) ?? DEFAULT_TURNS;
    out(conn, { type: "transcript", instanceId: id, ...world.transcript(id, turns) });
  }

  function subscribe(conn: Conn, id: string, turns: number) {
    // Opening a Finished session marks it seen (the contract's SubscribeFrame).
    // Before subscribing, so this phone gets one transcript, not two.
    world.markSeen(id);
    conn.subscriptions.add(id);
    let turnsById = turnsOf.get(conn);
    if (!turnsById) turnsOf.set(conn, (turnsById = new Map()));
    turnsById.set(id, Math.max(1, turns));
    sendTranscript(conn, id);
    out(conn, { type: "snapshot", instanceId: id, ...world.terminal(id) });
    if (world.dialogOf(id)) out(conn, promptState(id));
  }

  function acked(conn: Conn, frame: AckedFrame) {
    const device = conn.deviceId ?? "";
    let seen = acks.get(device);
    if (!seen) acks.set(device, (seen = new Map()));
    const earlier = seen.get(frame.clientMsgId);
    if (earlier) {
      record(conn, frame, earlier, true);
      out(conn, earlier);
      return;
    }
    const checked = check(device, frame);
    const ack: AckFrame =
      typeof checked === "function"
        ? { type: "ack", clientMsgId: frame.clientMsgId, ok: true }
        : { type: "ack", clientMsgId: frame.clientMsgId, ok: false, reason: checked[0], message: checked[1] };
    seen.set(frame.clientMsgId, ack);
    if (seen.size > ACKS_PER_DEVICE) seen.delete(seen.keys().next().value!);
    record(conn, frame, ack);
    // The ack first, then what the action changed, as the desktop answers once it
    // has handled the frame and the CLI reacts after.
    out(conn, ack);
    if (typeof checked === "function") checked();
  }

  // The desktop's gating, as T-803 specifies it: a refusal, or the action to take.
  function check(device: string, frame: AckedFrame): [AckRefusal, string] | (() => void) {
    if (frame.type === "push-subscribe") {
      return () => {
        if (frame.subscription) pushDevices.add(device);
        else pushDevices.delete(device);
      };
    }
    const id = frame.instanceId;
    const session = world.stateOf(id);

    if (frame.type === "prompt") {
      if (!session?.running) return ["not-running", "This session isn't running."];
      if (session.state === "needs-you") {
        return ["dialog-open", "A dialog is open: answer it first, so the text doesn't land in it."];
      }
      return () => world.prompt(id, frame.text);
    }

    if (frame.type === "interrupt") {
      if (session?.state === "needs-you") {
        return ["dialog-open", "A dialog is open, and Esc would answer it. Answer it instead."];
      }
      if (session?.state !== "working") return ["not-working", "Nothing to stop: the session isn't in a turn."];
      // Until G-303 measures which keys stop an OpenCode 2 turn.
      if (session.backend === "opencode") return ["unsupported", "Stopping an OpenCode turn isn't supported yet."];
      return () => world.interrupt(id);
    }

    const d = world.dialogOf(id);
    if (!session || !d || d.seq !== frame.seq) {
      return ["gone", "That dialog was already answered, or replaced by a newer one."];
    }
    if (!d.dialog) return ["unsupported", "The phone can't answer this dialog. Use the terminal."];
    const checked = checkChoice(secretaryDialog(d.dialog, session.backend), explicit(frame.choice), frame.confirmed === true);
    if (checked.ok) return () => world.answer(id, frame.choice);
    if ("refuse" in checked) return ["unsupported", "That answer doesn't fit this dialog. Use the terminal."];
    switch (checked.ask) {
      case "confirm-always":
      case "confirm-auto":
        return ["needs-confirm", "This lets the agent do more from now on: confirm it first."];
      case "what-to-change":
        return ["failed", "Say what the plan should change."];
      case "unanswered":
        return ["failed", "Answer every question first."];
      default:
        return ["failed", "Pick one of the dialog's options."];
    }
  }

  function record(conn: Conn, frame: ClientFrame, ack?: AckFrame, resent = false) {
    log.push({ at: Date.now(), device: conn.deviceId, frame, ...(ack ? { ack } : {}), ...(resent ? { resent } : {}) });
    if (log.length > LOG_LIMIT) log.shift();
    const { type, ...rest } = frame;
    const result = ack ? ` → ${ack.ok ? "ok" : ack.reason}` : "";
    print(`${new Date().toTimeString().slice(0, 8)} ${type} ${JSON.stringify(rest)}${result}${resent ? " (resent)" : ""}`);
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

    resize(id: string, cols: number, rows: number): boolean {
      if (!world.has(id)) return false;
      for (const conn of subscribers(id)) out(conn, { type: "resize", instanceId: id, cols, rows });
      return world.resize(id, cols, rows);
    },

    sockets() {
      return [...server["connections"]].map((c) => ({
        device: c.deviceId,
        authed: c.authed,
        subscriptions: [...c.subscriptions],
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
function explicit(choice: RemoteChoice) {
  return "effect" in choice ? { ...choice, explicit: true } : choice;
}
