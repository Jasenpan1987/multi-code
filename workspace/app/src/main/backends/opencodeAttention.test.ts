// Replays what OpenCode 2.0.32's service sent a subscriber (T-601 fixtures,
// __fixtures__/opencode-v2/) through OpencodeAttention and checks the exact activity
// each scenario raises. The service is a fake that keeps its own record of sessions,
// turns and dialogs from the frames it publishes, so a re-sync reads what the real
// one would have answered at that moment. The TUI plugin's route reports go through
// the real `/alert` parser. The fixtures are the evidence; a rule changed here
// without one to back it is a guess.

import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { OpencodeAttention } from "./opencodeAttention";
import { MULTI_QUESTION_TOOL_LABEL, PERMISSION_TOOL, QUESTION_TOOL_LABEL } from "./opencodePrompt";
import {
  toFormInfo,
  toPermissionRequest,
  type FormInfo,
  type OpencodeService,
  type PermissionRequest,
  type ServiceEvent,
  type ServiceListener,
  type ServiceSession,
  type ServiceStatus,
} from "./opencodeService";
import { parseAlertDelivery } from "../manager-mcp/server";
import type { HookTimers } from "./claudeHooks";
import type { AlertDelivery, AlertsDegradedReason, AnswerResult, PromptToolCall } from "./types";
import type { PromptDetail } from "../remote/promptExtract";

const FIXTURES = path.join(__dirname, "__fixtures__/opencode-v2");

interface FixtureFrame {
  t: number;
  stream?: "connect" | "disconnect";
  event?: { type: string; data?: Record<string, unknown>; location?: { directory: string } };
}

interface Fixture {
  scenario: string;
  frames: FixtureFrame[];
  pluginRoutes?: { t: number; route: { type: string; sessionID?: string } }[];
}

function load(name: string): Fixture {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.json`), "utf8")) as Fixture;
}

class VirtualTimers implements HookTimers {
  now = 0;
  private queue: { at: number; id: number; fn: () => void }[] = [];
  private nextId = 1;

  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.queue.push({ at: this.now + ms, id, fn });
    return id;
  }

  clearTimeout(handle: unknown) {
    this.queue = this.queue.filter((t) => t.id !== handle);
  }

  advanceTo(t: number) {
    for (;;) {
      const due = this.queue
        .filter((q) => q.at <= t)
        .sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      this.queue = this.queue.filter((q) => q !== due);
      this.now = due.at;
      due.fn();
    }
    this.now = Math.max(this.now, t);
  }
}

const ENDS = new Set([
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
]);

// The user's shared service as a subscriber sees it. `publish` is a frame on the
// stream; `record` is the service changing while nobody hears (a dropped stream).
class FakeService implements OpencodeService {
  readonly listeners = new Set<ServiceListener>();
  state: ServiceStatus = { state: "connecting" };
  reachable = true;
  readonly active = new Set<string>();
  readonly sessions = new Map<string, ServiceSession>();
  readonly permissions = new Map<string, PermissionRequest[]>();
  readonly forms = new Map<string, FormInfo[]>();
  // Sessions `GET /api/session/:id` answers 404 for.
  readonly unknown = new Set<string>();
  readonly reads: string[] = [];
  readonly replies: unknown[][] = [];
  replyResult: AnswerResult = { ok: true };
  // While set, snapshot answers (taken when asked) are held back until it resolves.
  gate: Promise<void> | null = null;

  subscribe(listener: ServiceListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  status(): ServiceStatus {
    return this.state;
  }

  private async answer<T>(label: string, value: () => T): Promise<T | null> {
    this.reads.push(label);
    const now = this.reachable ? value() : null;
    if (this.gate) await this.gate;
    return now;
  }

  activeSessions() {
    return this.answer("active", () => new Set(this.active));
  }

  session(id: string) {
    return this.answer(`session ${id}`, () =>
      this.unknown.has(id) ? null : (this.sessions.get(id) ?? { id })
    );
  }

  pendingPermissions(id: string) {
    return this.answer(`permissions ${id}`, () => [...(this.permissions.get(id) ?? [])]);
  }

  pendingForms(id: string) {
    return this.answer(`forms ${id}`, () => [...(this.forms.get(id) ?? [])]);
  }

  async replyPermission(...args: unknown[]): Promise<AnswerResult> {
    this.replies.push(["permission", ...args]);
    return this.replyResult;
  }

  async replyForm(...args: unknown[]): Promise<AnswerResult> {
    this.replies.push(["form", ...args]);
    return this.replyResult;
  }

  async cancelForm(...args: unknown[]): Promise<AnswerResult> {
    this.replies.push(["cancel", ...args]);
    return this.replyResult;
  }

  publish(event: ServiceEvent) {
    this.record(event);
    for (const listener of Array.from(this.listeners)) listener.onEvent(event);
  }

  record(event: ServiceEvent) {
    const data = event.data;
    const session = typeof data.sessionID === "string" ? data.sessionID : "";
    switch (event.type) {
      case "session.created":
        this.sessions.set(session, {
          id: session,
          ...(typeof data.parentID === "string" ? { parentID: data.parentID } : {}),
        });
        return;
      case "session.execution.started":
        this.active.add(session);
        return;
      case "permission.asked": {
        const request = toPermissionRequest(data);
        if (request) this.permissions.set(session, [...(this.permissions.get(session) ?? []), request]);
        return;
      }
      case "permission.replied":
        this.permissions.set(
          session,
          (this.permissions.get(session) ?? []).filter((r) => r.id !== data.requestID)
        );
        return;
      case "form.created": {
        const form = toFormInfo(data.form);
        if (form) this.forms.set(form.sessionID, [...(this.forms.get(form.sessionID) ?? []), form]);
        return;
      }
      case "form.replied":
      case "form.cancelled":
        this.forms.set(session, (this.forms.get(session) ?? []).filter((f) => f.id !== data.id));
        return;
    }
    if (ENDS.has(event.type)) {
      // A turn's end drops what it still had open (interrupt-pending-permission).
      this.active.delete(session);
      this.permissions.delete(session);
      this.forms.delete(session);
      const outcome = event.type.slice("session.execution.".length) as ServiceSession["outcome"];
      this.sessions.set(session, { ...(this.sessions.get(session) ?? { id: session }), outcome });
    }
  }

  setStatus(state: ServiceStatus) {
    this.state = state;
    for (const listener of Array.from(this.listeners)) listener.onStatus(state);
  }

  // A (re)connect: `server.connected`, which the client turns into a status and a
  // re-sync.
  connect() {
    this.setStatus({ state: "connected" });
    for (const listener of Array.from(this.listeners)) listener.onResync();
  }

  disconnect() {
    this.setStatus({ state: "connecting" });
  }
}

interface Raised {
  type: string;
  detail?: PromptDetail;
  toolCall?: PromptToolCall;
  restated?: boolean;
  endedSession?: string;
}

function harness(opts: { sessionId?: string; service?: FakeService } = {}) {
  const service = opts.service ?? new FakeService();
  const timers = new VirtualTimers();
  const raised: Raised[] = [];
  const health: [boolean, AlertsDegradedReason?][] = [];
  const shown: string[] = [];
  const working: boolean[] = [];
  const homes: boolean[] = [];
  // Both callbacks about the screen, in the order they came.
  const screen: string[] = [];
  const attention = new OpencodeAttention(
    (type, detail, toolCall, restated, endedSession) =>
      raised.push({
        type,
        detail,
        toolCall,
        ...(restated ? { restated } : {}),
        ...(endedSession ? { endedSession } : {}),
      }),
    (ok, reason) => health.push(reason === undefined ? [ok] : [ok, reason]),
    {
      instanceId: "inst-1",
      sessionId: opts.sessionId,
      onSessionShown: (id) => {
        shown.push(id);
        screen.push(`shown ${id}`);
      },
      onWorking: (w) => working.push(w),
      onHomeShown: (home) => {
        homes.push(home);
        screen.push(`home ${home}`);
      },
    },
    { service, timers }
  );
  // A restatement (a dialog reported before, live again) reads as "restated".
  const types = () => raised.map((r) => (r.restated ? "restated" : r.type));
  return { service, timers, raised, health, shown, working, homes, screen, attention, types };
}

// Every promise the fakes resolve at once has settled by then.
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

// What Multi-Code's TUI plugin posts, through the real `/alert` parser.
function plugin(body: Record<string, unknown>): AlertDelivery {
  const parsed = parseAlertDelivery("inst-1", JSON.stringify(body), "spawn-1");
  if (!parsed) throw new Error("unparseable delivery");
  return parsed;
}
const init = () => plugin({ hook_event_name: "multicode.init", pid: 4242 });
const route = (sessionID?: string) =>
  plugin({
    hook_event_name: "multicode.route",
    session_id: sessionID,
    route: sessionID ? { type: "session", sessionID } : { type: "home" },
  });

function toEvent(frame: FixtureFrame): ServiceEvent {
  const event = frame.event!;
  return { type: event.type, data: event.data ?? {}, ...(event.location ? { location: event.location } : {}) };
}

// The roots a fixture's frames create, oldest first.
function rootsOf(fixture: Fixture): string[] {
  return fixture.frames
    .filter((f) => f.event?.type === "session.created" && !f.event.data?.parentID)
    .map((f) => f.event!.data!.sessionID as string);
}

// Plays a fixture against a fresh contact. `owner: "spawn"` makes the first session
// the terminal showed (else the first root created) the spawn's own, as T-605's
// `--session` does; `"routes"` leaves the contact owning only what the route reports
// say, as after `/new`. The plugin posts its init at the start, and the stream is up.
async function replay(
  name: string,
  opts: { owner?: "spawn" | "routes"; sessionId?: string; atConnect?: (s: FakeService) => void; before?: (h: ReturnType<typeof harness>) => void } = {}
) {
  const fixture = load(name);
  const routes = fixture.pluginRoutes ?? [];
  const owner = opts.owner ?? "spawn";
  const sessionId =
    opts.sessionId ??
    (owner === "spawn" ? (routes.find((r) => r.route.sessionID)?.route.sessionID ?? rootsOf(fixture)[0]) : undefined);
  const h = harness({ sessionId });
  h.attention.handle(init());
  opts.before?.(h);
  h.service.connect();
  await flush();

  type Step = { t: number; frame?: FixtureFrame; route?: { sessionID?: string } };
  const steps: Step[] = [
    ...fixture.frames.map((frame) => ({ t: frame.t, frame })),
    ...routes.map((r) => ({ t: r.t, route: r.route })),
  ].sort((a, b) => a.t - b.t);
  for (const step of steps) {
    h.timers.advanceTo(step.t);
    if (step.route) h.attention.handle(route(step.route.sessionID));
    else if (step.frame?.stream === "disconnect") h.service.disconnect();
    else if (step.frame?.stream === "connect") opts.atConnect?.(h.service);
    else if (step.frame?.event?.type === "server.connected") h.service.connect();
    else if (step.frame?.event) h.service.publish(toEvent(step.frame));
    await flush();
  }
  return { ...h, fixture };
}

// Each fixture and what it must raise. A fixture added to the folder without a line
// here fails the coverage test below.
const SEQUENCES: [string, string[]][] = [
  // A turn ending normally, and on an API error (G-002 of attention-alerts).
  ["plain-finish", ["waiting"]],
  ["api-error", ["waiting"]],
  // Double Esc: `interrupted{user}`.
  ["interrupt-esc", []],
  // Answered in the terminal: Needs-you, cleared, then the turn goes on and finishes.
  ["permission-once", ["prompt", "prompt-cleared", "waiting"]],
  ["permission-always", ["prompt", "prompt-cleared", "waiting"]],
  // A Reject (or Esc) on a root ends the turn `interrupted{shutdown}`: cleared, silent.
  ["permission-reject", ["prompt", "prompt-cleared"]],
  ["permission-esc", ["prompt", "prompt-cleared"]],
  // A subagent's request rejected with a reason: the child carries on, the root
  // finishes.
  ["permission-reject-reason", ["prompt", "prompt-cleared", "waiting"]],
  // The question tool's own permission, then its form.
  ["permission-no-save", ["prompt", "prompt-cleared", "prompt", "prompt-cleared", "waiting"]],
  // Answered through the API.
  ["permission-api-once", ["prompt", "prompt-cleared", "waiting"]],
  ["permission-api-reject-reason", ["prompt", "prompt-cleared", "waiting"]],
  ["question-single", ["prompt", "prompt-cleared", "waiting"]],
  ["question-multi", ["prompt", "prompt-cleared", "waiting"]],
  ["question-two", ["prompt", "prompt-cleared", "waiting"]],
  ["question-api", ["prompt", "prompt-cleared", "waiting"]],
  ["question-api-custom", ["prompt", "prompt-cleared", "waiting"]],
  // A dismissed question ends the turn `interrupted{shutdown}`, `form.cancelled` first.
  ["question-dismiss", ["prompt", "prompt-cleared"]],
  ["question-api-dismiss", ["prompt", "prompt-cleared"]],
  // An interrupt drops the pending permission with no reply: the turn's end clears it.
  ["interrupt-pending-permission", ["prompt", "prompt-cleared"]],
  // The child asks; the child's end is silent, the root's is the finish.
  ["subagent-permission", ["prompt", "prompt-cleared", "waiting"]],
  // A plain Reject in a subagent ends only the child; the root asks again through a
  // second subagent and finishes (spike finding 3).
  ["subagent-reject-noreason", ["prompt", "prompt-cleared", "prompt", "prompt-cleared", "waiting"]],
  // B starts and ends inside A's turn: two finishes, B's first.
  ["two-roots", ["waiting", "waiting"]],
  // Stream EOF mid-turn, a new service resumes the turn: no event for the cut, one
  // finish for the resumed turn.
  ["service-restart", ["waiting"]],
];

describe("replaying OpenCode 2's own events", () => {
  it("covers every fixture", () => {
    const files = fs
      .readdirSync(FIXTURES)
      .filter((f) => f.endsWith(".json") && f !== "db-rows.json")
      .map((f) => f.replace(/\.json$/, ""))
      .sort();
    const tested = [...SEQUENCES.map(([name]) => name), "service-restart-resumes-rejected"].sort();
    expect(tested).toEqual(files);
  });

  it.each(SEQUENCES)("%s, the spawn's own session", async (name, expected) => {
    const { types, health } = await replay(name);
    expect(types()).toEqual(expected);
    expect(health).toEqual([]);
  });

  const routed = SEQUENCES.filter(([name]) => (load(name).pluginRoutes ?? []).length > 0);
  it.each(routed)("%s, a session only the terminal's route names", async (name, expected) => {
    const { types, shown, fixture } = await replay(name, { owner: "routes" });
    expect(types()).toEqual(expected);
    expect(shown).toEqual(fixture.pluginRoutes!.map((r) => r.route.sessionID));
  });

  it("permission-once: the prompt carries what is asked and the request to answer", async () => {
    const { raised, fixture } = await replay("permission-once");
    const request = fixture.frames.find((f) => f.event?.type === "permission.asked")!.event!.data!;
    const call: PromptToolCall = {
      toolName: "shell",
      toolInput: { resources: ["touch once.txt"], metadata: undefined, save: ["touch *"] },
      dialog: {
        kind: "permission",
        sessionId: request.sessionID as string,
        requestId: request.id as string,
      },
    };
    expect(raised[0]).toEqual({
      type: "prompt",
      detail: {
        tool: PERMISSION_TOOL,
        question: "Permission required: shell: touch once.txt",
        options: [
          expect.objectContaining({ label: "Allow once" }),
          expect.objectContaining({ label: "Always allow" }),
          expect.objectContaining({ label: "Reject" }),
        ],
      },
      toolCall: call,
    });
    // The clearing carries the closed request's call, for the secretary's waiters.
    expect(raised[1]).toEqual({ type: "prompt-cleared", detail: undefined, toolCall: call });
    // The turn's own root, the session the replayed TUI shows.
    expect(raised[2]).toEqual({
      type: "waiting",
      detail: undefined,
      toolCall: undefined,
      endedSession: expect.stringMatching(/^ses_/),
    });
  });

  it("permission-no-save: two options, then the question form with its own ref", async () => {
    const { raised } = await replay("permission-no-save");
    expect(raised[0].detail?.options.map((o) => o.label)).toEqual(["Allow once", "Reject"]);
    expect(raised[2].detail).toMatchObject({
      tool: QUESTION_TOOL_LABEL,
      question: "Which color do you pick?",
      options: [{ label: "Red" }, { label: "Green" }, { label: "Blue" }],
    });
    expect(raised[2].toolCall).toMatchObject({
      toolName: "question",
      dialog: { kind: "form", requestId: "frm_15540b134002hFO9n2uxWlQ50s" },
    });
  });

  it("question-multi and question-two are shown read-only", async () => {
    expect((await replay("question-multi")).raised[0].detail?.tool).toBe(MULTI_QUESTION_TOOL_LABEL);
    expect((await replay("question-two")).raised[0].detail?.tool).toBe(MULTI_QUESTION_TOOL_LABEL);
  });

  it("subagent-permission: the ref names the subagent's session, not the root's", async () => {
    const { raised, fixture } = await replay("subagent-permission");
    const child = fixture.frames.find(
      (f) => f.event?.type === "session.created" && f.event.data?.parentID
    )!.event!.data!.sessionID;
    expect(raised[0].toolCall?.dialog).toEqual({
      kind: "permission",
      sessionId: child,
      requestId: "per_15544b792001B1484uLFDySezd",
    });
  });

  it("service-restart: the re-sync after the new service connects raises nothing", async () => {
    const { raised, service } = await replay("service-restart");
    expect(raised.map((r) => r.type)).toEqual(["waiting"]);
    // It did read the snapshot: the resumed turn is known only from there.
    expect(service.reads.filter((r) => r === "active").length).toBe(2);
  });

  it("service-restart-resumes-rejected: a resumed turn asks again and is heard", async () => {
    // The contact owns two of the four roots the new service resumed (permission-reject's
    // and question-dismiss's); the other two are another owner's. Their resumes'
    // `execution.started` were never received (spike finding 1, 2).
    const fixture = load("service-restart-resumes-rejected");
    const resumed = [
      "ses_eaac25063ffeHZk9s9EjId37ur",
      "ses_eaac0c97effepaWWHLEWyIodfY",
      "ses_eaabda43ffferVuefVIwYoG51l",
      "ses_eaabc781fffeY75DO92M4bk0tN",
    ];
    const { types, raised, shown } = await replay("service-restart-resumes-rejected", {
      sessionId: resumed[0],
      before: (h) => h.attention.handle(route(resumed[2])),
      atConnect: (service) => {
        for (const id of resumed) service.active.add(id);
      },
    });
    expect(fixture.pluginRoutes).toBeUndefined();
    expect(shown).toEqual([resumed[2]]);
    // Its permission, its question, then the question cancelled by the interrupt that
    // cleaned up (the permission went with its own turn's end before it, silently: the
    // question was still open).
    expect(types()).toEqual(["prompt", "prompt", "prompt-cleared"]);
    expect(raised[0].toolCall?.dialog?.sessionId).toBe(resumed[0]);
    expect(raised[1].toolCall?.dialog?.sessionId).toBe(resumed[2]);
  });
});

// Hand-made events, shaped as the fixtures show them.
const ev = (type: string, data: Record<string, unknown>): ServiceEvent => ({ type, data });
const created = (sessionID: string, parentID?: string) =>
  ev("session.created", parentID ? { sessionID, parentID } : { sessionID });
const started = (sessionID: string) => ev("session.execution.started", { sessionID });
const succeeded = (sessionID: string) => ev("session.execution.succeeded", { sessionID });
const failed = (sessionID: string) =>
  ev("session.execution.failed", { sessionID, error: { type: "provider.no-route", message: "x" } });
const interrupted = (sessionID: string, reason: string) =>
  ev("session.execution.interrupted", { sessionID, reason });
const asked = (id: string, sessionID: string, extra: Record<string, unknown> = {}) =>
  ev("permission.asked", {
    id,
    sessionID,
    action: "shell",
    resources: ["touch a.txt"],
    save: ["touch *"],
    ...extra,
  });
const replied = (requestID: string, sessionID: string, reply = "once") =>
  ev("permission.replied", { sessionID, requestID, reply });
const questionForm = (id: string, sessionID: string) => ({
  id,
  sessionID,
  title: "Questions",
  metadata: { kind: "question" },
  fields: [
    {
      key: "q0",
      title: "Fruit",
      description: "Which fruit?",
      type: "string",
      options: [
        { value: "Apple", label: "Apple" },
        { value: "Pear", label: "Pear" },
      ],
      custom: true,
    },
  ],
});
const formCreated = (form: Record<string, unknown>) => ev("form.created", { form });
const formReplied = (id: string, sessionID: string) =>
  ev("form.replied", { id, sessionID, answer: { q0: "Apple" } });
const formCancelled = (id: string, sessionID: string) => ev("form.cancelled", { id, sessionID });

// A contact on `ses_root`, connected, the plugin heard.
async function live(opts: { sessionId?: string } = {}) {
  const h = harness({ sessionId: opts.sessionId ?? "ses_root" });
  h.attention.handle(init());
  h.service.connect();
  await flush();
  const publish = async (...events: ServiceEvent[]) => {
    for (const e of events) h.service.publish(e);
    await flush();
  };
  return { ...h, publish };
}

describe("turns", () => {
  it("a failed turn finishes, like a normal one", async () => {
    const h = await live();
    await h.publish(created("ses_root"), started("ses_root"), failed("ses_root"));
    expect(h.types()).toEqual(["waiting"]);
  });

  it("says which session is on screen, a subagent's included, and none at home", async () => {
    // A finish of the root while a subagent's session is shown must not move that
    // view (process-manager replySource): the contact's own session stays the root.
    const h = await live();
    await h.publish(created("ses_root"), created("ses_child", "ses_root"));
    h.attention.handle(route("ses_root"));
    await flush();
    expect(h.attention.shownSession()).toBe("ses_root");
    h.attention.handle(route("ses_child"));
    await flush();
    expect(h.attention.shownSession()).toBe("ses_child");
    h.attention.handle(route());
    await flush();
    expect(h.attention.shownSession()).toBeUndefined();
  });

  it("aims an interrupt at the session on screen, and only while it runs", async () => {
    // Esc Esc acts on the session the TUI's prompt shows, enabled only while that one
    // runs (a paired phone's Stop, mobile-v2 T-803).
    const h = await live();
    await h.publish(created("ses_root"), created("ses_child", "ses_root"), started("ses_child"));
    h.attention.handle(route("ses_root"));
    await flush();
    // The root is shown and idle while its subagent runs: the keys would stop nothing.
    expect(h.attention.interruptTarget()).toBeUndefined();
    await h.publish(started("ses_root"));
    expect(h.attention.interruptTarget()).toBe("ses_root");
    h.attention.handle(route());
    await flush();
    expect(h.attention.interruptTarget()).toBeUndefined();
  });

  it("a finish names the session whose turn ended", async () => {
    // The terminal may be showing another of the contact's sessions by then (a tab),
    // which a reply jump must not move (read-reply-conclusion).
    const h = await live();
    await h.publish(created("ses_root"), started("ses_root"), succeeded("ses_root"));
    expect(h.raised.map((r) => [r.type, r.endedSession])).toEqual([["waiting", "ses_root"]]);
  });

  it("an interrupt by the builder, a shutdown or a superseded runner raises nothing", async () => {
    const h = await live();
    for (const reason of ["user", "shutdown", "superseded", "something-new"]) {
      await h.publish(started("ses_root"), interrupted("ses_root", reason));
    }
    await h.publish(created("ses_root"));
    expect(h.types()).toEqual([]);
  });

  it("a turn evicted after 60 minutes of inactivity finishes", async () => {
    // PRD Story 3 assumption: the builder wants to hear that the turn died.
    const h = await live();
    await h.publish(created("ses_root"), started("ses_root"), interrupted("ses_root", "inactivity"));
    expect(h.types()).toEqual(["waiting"]);
  });

  it("a subagent finishing never finishes the contact", async () => {
    const h = await live();
    await h.publish(
      created("ses_root"),
      started("ses_root"),
      created("ses_child", "ses_root"),
      started("ses_child"),
      succeeded("ses_child"),
      started("ses_child"),
      failed("ses_child"),
      interrupted("ses_child", "inactivity")
    );
    expect(h.types()).toEqual([]);
    await h.publish(succeeded("ses_root"));
    expect(h.types()).toEqual(["waiting"]);
  });

  it("the spawn's own session finishes before any route names it", async () => {
    // A minted id: the TUI shows home until the first prompt (spike G-601), and the
    // route can land after the turn has started.
    const h = harness({ sessionId: "ses_minted" });
    h.service.connect();
    await flush();
    h.service.publish(created("ses_minted"));
    h.service.publish(started("ses_minted"));
    h.service.publish(succeeded("ses_minted"));
    await flush();
    expect(h.types()).toEqual(["waiting"]);
  });
});

describe("working", () => {
  it("from a turn's start to its end, however it ends", async () => {
    const h = await live();
    await h.publish(created("ses_root"), started("ses_root"));
    expect(h.working).toEqual([true]);
    await h.publish(interrupted("ses_root", "user"));
    expect(h.working).toEqual([true, false]);
    await h.publish(started("ses_root"), succeeded("ses_root"));
    expect(h.working).toEqual([true, false, true, false]);
  });

  it("not while a dialog waits on the builder, and again once it is answered", async () => {
    const h = await live();
    await h.publish(created("ses_root"), started("ses_root"), asked("per_1", "ses_root"));
    expect(h.working).toEqual([true, false]);
    await h.publish(replied("per_1", "ses_root"));
    expect(h.working).toEqual([true, false, true]);
  });

  it("a subagent running keeps the contact working until every turn has ended", async () => {
    const h = await live();
    await h.publish(
      created("ses_root"),
      started("ses_root"),
      created("ses_child", "ses_root"),
      started("ses_child"),
      succeeded("ses_root")
    );
    expect(h.working).toEqual([true]);
    await h.publish(succeeded("ses_child"));
    expect(h.working).toEqual([true, false]);
  });

  it("another client's turn on the service is not the contact's", async () => {
    const h = await live();
    await h.publish(created("ses_vscode"), started("ses_vscode"));
    expect(h.working).toEqual([]);
  });

  it("a session shown while its turn runs makes the contact working", async () => {
    const h = await live();
    await h.publish(created("ses_other"), started("ses_other"));
    expect(h.working).toEqual([]);
    h.attention.handle(route("ses_other"));
    await flush();
    expect(h.working).toEqual([true]);
  });

  it("a subagent whose creation was missed still keeps the contact working", async () => {
    // Made before this subscription and idle at the snapshot, so nothing said whose
    // it is; its start is the first word of it. The root ending first must not
    // read as the contact idle while the subagent works.
    const h = await live();
    h.service.sessions.set("ses_child", { id: "ses_child", parentID: "ses_root" });
    await h.publish(created("ses_root"), started("ses_root"), started("ses_child"));
    await h.publish(succeeded("ses_root"));
    expect(h.working).toEqual([true]);
    await h.publish(succeeded("ses_child"));
    expect(h.working).toEqual([true, false]);
  });

  it("a start whose family lookup fails leaves it to be asked again", async () => {
    // Not recorded as a root: the re-sync after the service is back finds whose it
    // is, and its dialog is the contact's.
    const h = await live();
    h.service.sessions.set("ses_child", { id: "ses_child", parentID: "ses_root" });
    await h.publish(created("ses_root"), started("ses_root"));
    h.service.reachable = false;
    await h.publish(started("ses_child"));
    h.service.reachable = true;
    await h.publish(succeeded("ses_root"));
    expect(h.working).toEqual([true, false]);
    h.service.connect();
    await flush();
    expect(h.working).toEqual([true, false, true]);
    await h.publish(asked("per_c", "ses_child"));
    expect(h.types()).toEqual(["waiting", "prompt"]);
  });
});

describe("dialogs", () => {
  it("a subagent's dialog raises Needs-you and is answered on its own session", async () => {
    const h = await live();
    await h.publish(created("ses_root"), started("ses_root"), created("ses_child", "ses_root"));
    await h.publish(started("ses_child"), asked("per_1", "ses_child"));
    expect(h.raised[0].toolCall?.dialog).toEqual({
      kind: "permission",
      sessionId: "ses_child",
      requestId: "per_1",
    });
    await h.publish(replied("per_1", "ses_child"), succeeded("ses_child"), succeeded("ses_root"));
    expect(h.types()).toEqual(["prompt", "prompt-cleared", "waiting"]);
  });

  it("a subagent's end clears its own open dialog, without a finish", async () => {
    const h = await live();
    await h.publish(created("ses_root"), started("ses_root"), created("ses_child", "ses_root"));
    await h.publish(started("ses_child"), asked("per_1", "ses_child"));
    await h.publish(interrupted("ses_child", "shutdown"));
    expect(h.types()).toEqual(["prompt", "prompt-cleared"]);
  });

  it("a root's end clears every dialog of its tree", async () => {
    const h = await live();
    await h.publish(
      created("ses_root"),
      started("ses_root"),
      created("ses_child", "ses_root"),
      created("ses_grandchild", "ses_child"),
      asked("per_1", "ses_grandchild"),
      formCreated(questionForm("frm_1", "ses_root"))
    );
    await h.publish(interrupted("ses_root", "user"));
    expect(h.types()).toEqual(["prompt", "prompt", "prompt-cleared"]);
  });

  it("two dialogs open at once stay Needs-you until both are closed", async () => {
    const h = await live();
    await h.publish(created("ses_root"), started("ses_root"), created("ses_child", "ses_root"));
    await h.publish(asked("per_1", "ses_root"), asked("per_2", "ses_child"));
    await h.publish(replied("per_2", "ses_child"));
    // The phone and the secretary move to the one still open, without a second chime.
    expect(h.types()).toEqual(["prompt", "prompt", "restated"]);
    expect(h.raised[2].toolCall?.dialog?.requestId).toBe("per_1");
    expect(h.raised[2].detail).toEqual(h.raised[0].detail);
    await h.publish(replied("per_1", "ses_root"));
    expect(h.types()).toEqual(["prompt", "prompt", "restated", "prompt-cleared"]);
    expect(h.raised[3].toolCall?.dialog?.requestId).toBe("per_1");
  });

  it("closing a dialog that isn't the live one leaves the live one as it is", async () => {
    const h = await live();
    await h.publish(created("ses_root"), started("ses_root"), created("ses_child", "ses_root"));
    await h.publish(asked("per_1", "ses_root"), asked("per_2", "ses_child"));
    await h.publish(replied("per_1", "ses_root"));
    expect(h.types()).toEqual(["prompt", "prompt"]);
  });

  it("a subagent ending with the live dialog moves the phone to its root's open one", async () => {
    const h = await live();
    await h.publish(created("ses_root"), started("ses_root"), created("ses_child", "ses_root"));
    await h.publish(asked("per_1", "ses_root"), started("ses_child"), asked("per_2", "ses_child"));
    await h.publish(interrupted("ses_child", "shutdown"));
    expect(h.types()).toEqual(["prompt", "prompt", "restated"]);
    expect(h.raised[2].toolCall?.dialog?.requestId).toBe("per_1");
  });

  it("two owned roots: one finishing while the other's dialog is open says it again", async () => {
    // two-roots, with A blocked when B ends: the finish alone would read as the whole
    // contact idle and open the write gate onto A's dialog.
    const h = await live({ sessionId: "ses_a" });
    await h.publish(created("ses_a"), created("ses_b"));
    h.attention.handle(route("ses_b"));
    await flush();
    await h.publish(started("ses_a"), started("ses_b"), asked("per_a", "ses_a"));
    await h.publish(succeeded("ses_b"));
    // Said again as a restatement: B's finish chimes, A's dialog had its chime.
    expect(h.types()).toEqual(["prompt", "waiting", "restated"]);
    expect(h.raised[2].toolCall?.dialog?.requestId).toBe("per_a");
    await h.publish(replied("per_a", "ses_a"), succeeded("ses_a"));
    expect(h.types()).toEqual(["prompt", "waiting", "restated", "prompt-cleared", "waiting"]);
  });

  it("a finish with nothing else open says nothing after it", async () => {
    const h = await live();
    await h.publish(created("ses_root"), started("ses_root"), asked("per_1", "ses_root"));
    await h.publish(replied("per_1", "ses_root"), succeeded("ses_root"));
    expect(h.types()).toEqual(["prompt", "prompt-cleared", "waiting"]);
  });

  it("a reply to a request the contact doesn't have open means nothing", async () => {
    const h = await live();
    await h.publish(created("ses_root"), replied("per_x", "ses_root"), formCancelled("frm_x", "ses_root"));
    expect(h.types()).toEqual([]);
  });

  it("the same request reported twice chimes once", async () => {
    const h = await live();
    await h.publish(created("ses_root"), asked("per_1", "ses_root"), asked("per_1", "ses_root"));
    expect(h.types()).toEqual(["prompt"]);
  });

  it("a form that isn't a question raises Needs-you with nothing to tap", async () => {
    const h = await live();
    const fields = [{ key: "token", type: "string", title: "API token" }];
    await h.publish(
      created("ses_root"),
      formCreated({ id: "frm_mcp", sessionID: "ses_root", title: "Log in to Foo", fields })
    );
    expect(h.raised).toEqual([
      {
        type: "prompt",
        detail: undefined,
        toolCall: {
          toolName: "form",
          toolInput: { title: "Log in to Foo", fields },
          dialog: { kind: "form", sessionId: "ses_root", requestId: "frm_mcp" },
        },
      },
    ]);
    await h.publish(formReplied("frm_mcp", "ses_root"));
    expect(h.types()).toEqual(["prompt", "prompt-cleared"]);
  });

  it("a form of the \"global\" session (MCP elicitation) is nobody's", async () => {
    const h = await live();
    await h.publish(formCreated({ ...questionForm("frm_g", "global") }));
    await h.publish(formCancelled("frm_g", "global"));
    expect(h.types()).toEqual([]);
    expect(h.service.reads.filter((r) => r.includes("global"))).toEqual([]);
  });

  it("a permission of a shape this version doesn't know still raises Needs-you", async () => {
    const h = await live();
    await h.publish(created("ses_root"), ev("permission.asked", { id: "per_odd", sessionID: "ses_root" }));
    expect(h.raised[0]).toMatchObject({ type: "prompt", detail: undefined, toolCall: { toolName: "permission" } });
    expect(h.raised[0].toolCall?.dialog).toBeUndefined();
    await h.publish(replied("per_odd", "ses_root"));
    expect(h.types()).toEqual(["prompt", "prompt-cleared"]);
  });
});

describe("whose sessions", () => {
  it("events of a session no contact owns are ignored", async () => {
    // VS Code or a plain terminal on the same service.
    const h = await live();
    await h.publish(
      created("ses_vscode"),
      started("ses_vscode"),
      asked("per_v", "ses_vscode"),
      formCreated(questionForm("frm_v", "ses_vscode")),
      created("ses_vchild", "ses_vscode"),
      asked("per_vc", "ses_vchild"),
      succeeded("ses_vscode")
    );
    expect(h.types()).toEqual([]);
  });

  it("a session never seen created is looked up once and owned through its parent", async () => {
    const h = await live();
    await h.publish(created("ses_root"), started("ses_root"));
    // A subagent created while the stream was down, say: no session.created seen.
    h.service.sessions.set("ses_child", { id: "ses_child", parentID: "ses_root" });
    // Both before the lookup answers: held, then applied in order.
    h.service.publish(asked("per_c", "ses_child"));
    h.service.publish(replied("per_c", "ses_child"));
    h.service.publish(asked("per_d", "ses_child"));
    await flush();
    expect(h.types()).toEqual(["prompt", "prompt-cleared", "prompt"]);
    expect(h.service.reads.filter((r) => r === "session ses_child")).toEqual(["session ses_child"]);
    await h.publish(succeeded("ses_child"));
    // The child's end: cleared, never a finish.
    expect(h.types()).toEqual(["prompt", "prompt-cleared", "prompt", "prompt-cleared"]);
  });

  it("a session looked up and found to be another's stays ignored, and is asked about once", async () => {
    const h = await live();
    h.service.sessions.set("ses_other", { id: "ses_other" });
    h.service.sessions.set("ses_other_child", { id: "ses_other_child", parentID: "ses_other" });
    await h.publish(asked("per_o", "ses_other"), started("ses_other"), succeeded("ses_other"));
    await h.publish(asked("per_oc", "ses_other_child"), succeeded("ses_other"));
    expect(h.types()).toEqual([]);
    expect(h.service.reads.filter((r) => r.includes("ses_other"))).toEqual([
      "session ses_other",
      "session ses_other_child",
    ]);
  });

  it("a session the service doesn't know is nobody's, unless the terminal shows it", async () => {
    const h = await live();
    h.service.unknown.add("ses_ghost");
    await h.publish(asked("per_g", "ses_ghost"));
    expect(h.types()).toEqual([]);
  });

  it("a shown session whose record can't be read is taken for a root", async () => {
    const service = new FakeService();
    service.unknown.add("ses_resumed");
    const h = harness({ service, sessionId: "ses_resumed" });
    service.connect();
    await flush();
    service.publish(started("ses_resumed"));
    service.publish(succeeded("ses_resumed"));
    await flush();
    expect(h.types()).toEqual(["waiting"]);
    expect(service.reads).toContain("session ses_resumed");
  });
});

describe("the session the terminal shows", () => {
  it("is reported when it changes; the home screen keeps it, and is said on its own", async () => {
    const h = await live({ sessionId: "ses_a" });
    for (const id of ["ses_a", "ses_a", undefined, "ses_b", undefined, undefined, "ses_b", "ses_a"]) {
      h.attention.handle(route(id));
      await flush();
    }
    expect(h.shown).toEqual(["ses_a", "ses_b", "ses_a"]);
    expect(h.homes).toEqual([true, false, true, false]);
  });

  it("leaving home for a new session says which session first", async () => {
    // So the caller reads the new session's figure, not the one it left.
    const h = await live({ sessionId: "ses_a" });
    h.attention.handle(route("ses_a"));
    h.attention.handle(route());
    await h.publish(created("ses_b"));
    h.attention.handle(route("ses_b"));
    await flush();
    expect(h.screen).toEqual(["shown ses_a", "home true", "shown ses_b", "home false"]);
  });

  it("leaving home for a subagent's session is said too, without taking it", async () => {
    const h = await live({ sessionId: "ses_root" });
    await h.publish(created("ses_child", "ses_root"));
    h.attention.handle(route("ses_root"));
    h.attention.handle(route());
    h.attention.handle(route("ses_child"));
    await flush();
    expect(h.shown).toEqual(["ses_root"]);
    expect(h.homes).toEqual([true, false]);
  });

  it("only the route it settles on is reported when they come faster than a lookup", async () => {
    const h = await live({ sessionId: "ses_a" });
    for (const id of ["ses_a", "ses_b", "ses_a"]) h.attention.handle(route(id));
    await flush();
    expect(h.shown).toEqual(["ses_a"]);
  });

  it("a subagent's session the terminal shows is not taken as the contact's own", async () => {
    // Its next start would otherwise reopen the middle of someone else's turn.
    const h = await live({ sessionId: "ses_root" });
    await h.publish(created("ses_child", "ses_root"));
    h.attention.handle(route("ses_child"));
    await flush();
    expect(h.shown).toEqual([]);
    h.attention.handle(route("ses_root"));
    await flush();
    expect(h.shown).toEqual(["ses_root"]);
  });

  it("a session shown for the first time is read: a turn under way finishes, a dialog open is raised", async () => {
    // `/sessions` into a session VS Code started: its start and its dialog were
    // somebody else's when they came.
    const h = await live();
    await h.publish(created("ses_vs"), started("ses_vs"), asked("per_vs", "ses_vs"));
    expect(h.types()).toEqual([]);
    h.attention.handle(route("ses_vs"));
    await flush();
    expect(h.types()).toEqual(["prompt"]);
    expect(h.raised[0].toolCall?.dialog?.requestId).toBe("per_vs");
    await h.publish(replied("per_vs", "ses_vs"), succeeded("ses_vs"));
    expect(h.types()).toEqual(["prompt", "prompt-cleared", "waiting"]);
  });

  it("showing it again reads nothing", async () => {
    const h = await live();
    h.attention.handle(route("ses_root"));
    h.attention.handle(route("ses_root"));
    await flush();
    // Only the connect's re-sync.
    expect(h.service.reads.filter((r) => r === "active")).toEqual(["active"]);
  });
});

describe("re-sync", () => {
  it("a dialog still open after a reconnect is not raised again", async () => {
    const h = await live();
    await h.publish(created("ses_root"), started("ses_root"), asked("per_1", "ses_root"));
    h.service.disconnect();
    h.service.connect();
    await flush();
    expect(h.types()).toEqual(["prompt"]);
    await h.publish(replied("per_1", "ses_root"), succeeded("ses_root"));
    expect(h.types()).toEqual(["prompt", "prompt-cleared", "waiting"]);
  });

  it("a dialog answered while disconnected is cleared by the re-sync", async () => {
    const h = await live();
    await h.publish(created("ses_root"), started("ses_root"), asked("per_1", "ses_root"));
    h.service.disconnect();
    h.service.record(replied("per_1", "ses_root"));
    h.service.connect();
    await flush();
    expect(h.types()).toEqual(["prompt", "prompt-cleared"]);
    expect(h.raised[1].toolCall?.dialog?.requestId).toBe("per_1");
  });

  it("a dialog asked while disconnected is raised by the re-sync", async () => {
    const h = await live();
    await h.publish(created("ses_root"), started("ses_root"));
    h.service.disconnect();
    h.service.record(formCreated(questionForm("frm_1", "ses_root")));
    h.service.connect();
    await flush();
    expect(h.raised).toEqual([
      expect.objectContaining({
        type: "prompt",
        detail: expect.objectContaining({ tool: QUESTION_TOOL_LABEL, question: "Which fruit?" }),
      }),
    ]);
  });

  it("a root busy before a disconnect that succeeded meanwhile finishes once", async () => {
    const h = await live();
    await h.publish(created("ses_root"), started("ses_root"));
    h.service.disconnect();
    h.service.record(succeeded("ses_root"));
    h.service.connect();
    await flush();
    expect(h.types()).toEqual(["waiting"]);
    // Another reconnect, and the end's own event turning up late: still one.
    h.service.disconnect();
    h.service.connect();
    await flush();
    await h.publish(succeeded("ses_root"));
    expect(h.types()).toEqual(["waiting"]);
    // The next turn finishes as usual.
    await h.publish(started("ses_root"), succeeded("ses_root"));
    expect(h.types()).toEqual(["waiting", "waiting"]);
  });

  it("a turn that ended while away clears its dialog and finishes, then says what is still open", async () => {
    const h = await live({ sessionId: "ses_a" });
    await h.publish(created("ses_a"), created("ses_b"));
    h.attention.handle(route("ses_b"));
    await flush();
    await h.publish(started("ses_a"), started("ses_b"), asked("per_a", "ses_a"), asked("per_b", "ses_b"));
    h.service.disconnect();
    h.service.record(replied("per_b", "ses_b"));
    h.service.record(succeeded("ses_b"));
    h.service.connect();
    await flush();
    expect(h.types()).toEqual(["prompt", "prompt", "waiting", "restated"]);
    expect(h.raised[3].toolCall?.dialog?.requestId).toBe("per_a");
  });

  it("a turn interrupted while away, or whose record can't be read, raises no finish", async () => {
    const h = await live({ sessionId: "ses_a" });
    await h.publish(created("ses_a"), created("ses_b"));
    h.attention.handle(route("ses_b"));
    await flush();
    await h.publish(started("ses_a"), started("ses_b"), asked("per_a", "ses_a"));
    h.service.disconnect();
    // The interrupt drops the permission without a reply, as it does live.
    h.service.record(interrupted("ses_a", "user"));
    h.service.record(succeeded("ses_b"));
    h.service.unknown.add("ses_b");
    h.service.connect();
    await flush();
    expect(h.types()).toEqual(["prompt", "prompt-cleared"]);
  });

  it("the service replaced mid-turn: nothing at the swap, one finish for the resumed turn", async () => {
    // What the source reading predicts for a version replacement: the old turn ends
    // `interrupted{shutdown}` (here heard), the new service resumes it and its
    // `execution.started` is never received (spike finding 2).
    const h = await live();
    await h.publish(created("ses_root"), started("ses_root"));
    await h.publish(interrupted("ses_root", "shutdown"));
    h.service.disconnect();
    h.service.record(started("ses_root"));
    h.service.connect();
    await flush();
    expect(h.types()).toEqual([]);
    await h.publish(succeeded("ses_root"));
    expect(h.types()).toEqual(["waiting"]);
  });

  it("a subagent created while away is found through the snapshot", async () => {
    const h = await live();
    await h.publish(created("ses_root"), started("ses_root"));
    h.service.disconnect();
    h.service.record(created("ses_child", "ses_root"));
    h.service.record(started("ses_child"));
    h.service.record(asked("per_c", "ses_child"));
    h.service.connect();
    await flush();
    expect(h.types()).toEqual(["prompt"]);
    expect(h.raised[0].toolCall?.dialog?.sessionId).toBe("ses_child");
  });

  it("an unreachable snapshot changes nothing", async () => {
    const h = await live();
    await h.publish(created("ses_root"), started("ses_root"), asked("per_1", "ses_root"));
    h.service.disconnect();
    h.service.reachable = false;
    h.service.connect();
    await flush();
    expect(h.types()).toEqual(["prompt"]);
    h.service.reachable = true;
    await h.publish(replied("per_1", "ses_root"), succeeded("ses_root"));
    expect(h.types()).toEqual(["prompt", "prompt-cleared", "waiting"]);
  });

  // Holds the snapshot's answers, each taken when it was asked for: `next()` lets the
  // ones asked so far through and holds whatever is asked after.
  function gated(service: FakeService) {
    let release = () => {};
    const hold = () => {
      service.gate = new Promise<void>((resolve) => (release = resolve));
    };
    hold();
    return {
      next: async () => {
        const go = release;
        hold();
        go();
        await flush();
      },
      open: async () => {
        const go = release;
        service.gate = null;
        go();
        await flush();
        await flush();
      },
    };
  }

  it("events that arrive while a re-sync is reading win over its snapshot", async () => {
    const h = await live();
    await h.publish(created("ses_root"), started("ses_root"), asked("per_1", "ses_root"));
    h.service.disconnect();
    const gate = gated(h.service);
    h.service.connect();
    await flush();
    // The active list answered; the dialog reads are asked for with per_1 pending and
    // nothing else, and held.
    await gate.next();
    expect(h.service.reads.slice(-2)).toEqual(["permissions ses_root", "forms ses_root"]);
    // Before they arrive, the dialog is answered and a new one opens.
    await h.publish(replied("per_1", "ses_root"), asked("per_2", "ses_root"));
    expect(h.types()).toEqual(["prompt", "prompt-cleared", "prompt"]);
    await gate.open();
    // per_1 isn't revived, per_2 isn't dropped.
    expect(h.types()).toEqual(["prompt", "prompt-cleared", "prompt"]);
    await h.publish(replied("per_2", "ses_root"));
    expect(h.types()).toEqual(["prompt", "prompt-cleared", "prompt", "prompt-cleared"]);
  });

  it("a dialog settled while away goes, even when the stream speaks for its session during the re-sync", async () => {
    const h = await live();
    await h.publish(created("ses_root"), started("ses_root"), asked("per_old", "ses_root"));
    h.service.disconnect();
    h.service.record(replied("per_old", "ses_root"));
    const gate = gated(h.service);
    h.service.connect();
    await flush();
    await gate.next();
    // The dialog reads are out, listing nothing; a new dialog opens before they land.
    await h.publish(asked("per_new", "ses_root"));
    await gate.open();
    expect(h.types()).toEqual(["prompt", "prompt"]);
    // per_old went with the snapshot, so answering per_new leaves nothing open.
    await h.publish(replied("per_new", "ses_root"));
    expect(h.types()).toEqual(["prompt", "prompt", "prompt-cleared"]);
  });

  it("a dialog asked while away is raised, even when the stream settles another of its session during the re-sync", async () => {
    const h = await live();
    await h.publish(created("ses_root"), started("ses_root"), asked("per_a", "ses_root"));
    h.service.disconnect();
    h.service.record(asked("per_b", "ses_root"));
    const gate = gated(h.service);
    h.service.connect();
    await flush();
    await gate.next();
    // The dialog reads are out and will list both; per_a is answered before they land.
    await h.publish(replied("per_a", "ses_root"));
    await gate.open();
    expect(h.types()).toEqual(["prompt", "prompt-cleared", "prompt"]);
    expect(h.raised[2].toolCall?.dialog?.requestId).toBe("per_b");
  });

  it("the live dialog settled while away moves the phone to the one still open", async () => {
    const h = await live();
    await h.publish(created("ses_root"), started("ses_root"), created("ses_child", "ses_root"));
    await h.publish(asked("per_1", "ses_root"), started("ses_child"), asked("per_2", "ses_child"));
    h.service.disconnect();
    h.service.record(replied("per_2", "ses_child"));
    h.service.connect();
    await flush();
    expect(h.types()).toEqual(["prompt", "prompt", "restated"]);
    expect(h.raised[2].toolCall?.dialog?.requestId).toBe("per_1");
  });

  it("an event in a subagent's root during a re-sync keeps the snapshot off the subagent", async () => {
    // The root's end closes the child's dialog; a snapshot read before it still lists
    // the dialog.
    const h = await live();
    await h.publish(created("ses_root"), started("ses_root"), created("ses_child", "ses_root"));
    await h.publish(started("ses_child"), asked("per_c", "ses_child"));
    h.service.disconnect();
    const gate = gated(h.service);
    h.service.connect();
    await flush();
    await gate.next();
    await h.publish(interrupted("ses_root", "user"));
    await gate.open();
    expect(h.types()).toEqual(["prompt", "prompt-cleared"]);
  });

  it("a turn that starts while a re-sync is reading is still known to be running", async () => {
    const h = await live();
    await h.publish(created("ses_root"));
    h.service.disconnect();
    const gate = gated(h.service);
    h.service.connect();
    await flush();
    // The active list was read empty; the turn starts before it arrives.
    await h.publish(started("ses_root"));
    await gate.open();
    // So when it ends during the next outage, the re-sync after it still finishes it.
    h.service.disconnect();
    h.service.record(succeeded("ses_root"));
    h.service.connect();
    await flush();
    expect(h.types()).toEqual(["waiting"]);
  });
});

describe("after stop()", () => {
  it("nothing at all", async () => {
    const h = await live();
    await h.publish(created("ses_root"), started("ses_root"));
    h.attention.stop();
    expect(h.service.listeners.size).toBe(0);
    // The stream, had it still been subscribed; the plugin; the timers.
    h.attention.handle(route("ses_new"));
    h.attention.handle(init());
    h.timers.advanceTo(60_000);
    expect(h.types()).toEqual([]);
    expect(h.shown).toEqual([]);
    expect(h.health).toEqual([]);
  });

  it("a re-sync or a lookup in flight when it stops reports nothing", async () => {
    const h = harness({ sessionId: "ses_root" });
    h.service.sessions.set("ses_child", { id: "ses_child", parentID: "ses_root" });
    h.service.active.add("ses_root");
    h.service.permissions.set("ses_root", [toPermissionRequest(asked("per_1", "ses_root").data)!]);
    let release = () => {};
    h.service.gate = new Promise<void>((resolve) => (release = resolve));
    h.service.connect();
    h.service.publish(asked("per_c", "ses_child"));
    await flush();
    h.attention.stop();
    h.service.gate = null;
    release();
    await flush();
    await flush();
    expect(h.types()).toEqual([]);
  });

  it("the spawn's session going on in the service is silent", async () => {
    // Stop closes the terminal; the turn runs on in the service (PRD Story 11).
    const service = new FakeService();
    const h = harness({ service, sessionId: "ses_root" });
    service.connect();
    await flush();
    service.publish(created("ses_root"));
    service.publish(started("ses_root"));
    h.attention.stop();
    service.publish(asked("per_1", "ses_root"));
    service.publish(succeeded("ses_root"));
    await flush();
    expect(h.types()).toEqual([]);
  });
});

describe("health", () => {
  it("says the plugin didn't load when nothing arrives within 10 s, and that it did when it's heard", async () => {
    const h = harness({ sessionId: "ses_root" });
    h.service.connect();
    h.timers.advanceTo(9_999);
    expect(h.health).toEqual([]);
    h.timers.advanceTo(10_000);
    expect(h.health).toEqual([[false, "plugin"]]);
    h.attention.handle(init());
    expect(h.health).toEqual([[false, "plugin"], [true]]);
  });

  it("a route report counts as hearing the plugin", () => {
    const h = harness();
    h.timers.advanceTo(2_000);
    h.attention.handle(route());
    h.timers.advanceTo(60_000);
    expect(h.health).toEqual([]);
  });

  it("a delivery that isn't the plugin's proves nothing", () => {
    const h = harness();
    h.attention.handle(plugin({ hook_event_name: "session.status", session_id: "ses_x" }));
    h.timers.advanceTo(10_000);
    expect(h.health).toEqual([[false, "plugin"]]);
  });

  it("says the service can't be reached as soon as the client says so, and when it's back", () => {
    const h = harness();
    h.attention.handle(init());
    h.service.setStatus({ state: "connecting" });
    expect(h.health).toEqual([]);
    h.service.setStatus({ state: "unreachable", reason: "no service registration" });
    expect(h.health).toEqual([[false, "service"]]);
    // Reconnecting isn't back yet; a new reason is the same bar.
    h.service.setStatus({ state: "connecting" });
    h.service.setStatus({ state: "unreachable", reason: "connection failed (ECONNREFUSED)" });
    expect(h.health).toEqual([[false, "service"]]);
    h.service.setStatus({ state: "connected" });
    expect(h.health).toEqual([[false, "service"], [true]]);
  });

  it("the service outranks the plugin, and the plugin shows once the service is back", () => {
    const h = harness();
    h.timers.advanceTo(10_000);
    h.service.setStatus({ state: "unreachable", reason: "x" });
    h.service.setStatus({ state: "connected" });
    h.attention.handle(init());
    expect(h.health).toEqual([[false, "plugin"], [false, "service"], [false, "plugin"], [true]]);
  });

  it("an unreachable service at the 10 s mark keeps its own bar", () => {
    const h = harness();
    h.service.setStatus({ state: "unreachable", reason: "x" });
    h.timers.advanceTo(10_000);
    expect(h.health).toEqual([[false, "service"]]);
    h.service.setStatus({ state: "connected" });
    expect(h.health).toEqual([[false, "service"], [false, "plugin"]]);
  });
});

describe("answer", () => {
  it("a permission is answered on the request's own session, a subagent's included", async () => {
    const h = harness();
    const result = await h.attention.answer(
      { kind: "permission", sessionId: "ses_child", requestId: "per_1" },
      { kind: "permission", decision: "reject", message: "Not that file" }
    );
    expect(result).toEqual({ ok: true });
    expect(h.service.replies).toEqual([["permission", "ses_child", "per_1", "reject", "Not that file"]]);
  });

  it("a form is answered with its answer map", async () => {
    const h = harness();
    await h.attention.answer(
      { kind: "form", sessionId: "ses_root", requestId: "frm_1" },
      { kind: "form", answer: { q0: "Apple", q1: ["A", "B"] } }
    );
    expect(h.service.replies).toEqual([["form", "ses_root", "frm_1", { q0: "Apple", q1: ["A", "B"] }]]);
  });

  it("passes the service's word on, `gone` included", async () => {
    const h = harness();
    h.service.replyResult = { ok: false, reason: "gone" };
    expect(
      await h.attention.answer(
        { kind: "permission", sessionId: "ses_root", requestId: "per_1" },
        { kind: "permission", decision: "once" }
      )
    ).toEqual({ ok: false, reason: "gone" });
  });

  it("refuses an answer of the other kind, asking nothing", async () => {
    const h = harness();
    expect(
      await h.attention.answer(
        { kind: "form", sessionId: "ses_root", requestId: "frm_1" },
        { kind: "permission", decision: "once" }
      )
    ).toEqual({ ok: false, reason: "failed" });
    expect(
      await h.attention.answer(
        { kind: "permission", sessionId: "ses_root", requestId: "per_1" },
        { kind: "form", answer: { q0: "x" } }
      )
    ).toEqual({ ok: false, reason: "failed" });
    expect(h.service.replies).toEqual([]);
  });
});
