// The harness against the real RemoteServer (from source, electron mocked) over a
// real socket: every scenario reaches an authenticated phone, the acks the phone
// tickets build on behave as protocol v3 says, and the control commands break the
// connection the ways they promise. Also the first thing to fail when the server
// changes under the harness.

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "fs";
import net from "net";
import os from "os";
import path from "path";
import { HarnessClient } from "./client.ts";
import { startControl } from "./control.ts";
import { SCENARIOS, type ScenarioName } from "./scenarios.ts";
import { World } from "./world.ts";
import { attach, type Bridge } from "./bridge.ts";
import type { RemoteInstance, RemoteSessionState } from "../../src/shared/remote-protocol";

const userData = fs.mkdtempSync(path.join(os.tmpdir(), "mc-harness-test-"));

vi.mock("electron", () => ({
  app: {
    getPath: () => userData,
    getName: () => "Multi-Code",
  },
}));

const { RemoteServer } = await import("../../src/main/remote/ws-server");
const { checkChoice } = await import("../../src/main/secretary/dialog");

let world: World;
let bridge: Bridge;
let control: { url: string; close: () => Promise<void> };
const clients: HarnessClient[] = [];

beforeAll(async () => {
  world = new World("home", false);
  bridge = attach(new RemoteServer(), world, checkChoice, { hostName: "MacBook Air" });
  await bridge.start(0);
  control = await startControl(world, bridge, 0);
});

afterEach(() => {
  for (const c of clients.splice(0)) c.close();
});

afterAll(async () => {
  await control.close();
  await bridge.stop();
  fs.rmSync(userData, { recursive: true, force: true });
});

async function connect(): Promise<HarnessClient> {
  const client = await HarnessClient.connect(bridge.pairingUrl());
  clients.push(client);
  await client.next("instances");
  return client;
}

async function post(command: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${control.url}/${command}`, { method: "POST" });
  return (await res.json()) as Record<string, unknown>;
}

// A scenario started over, paused, with the phone caught up on it.
async function scenario(client: HarnessClient, name: ScenarioName) {
  client.drain();
  await post(`scenario/${name}?live=0`);
  return (await client.next("instances")).instances;
}

const stateOf = (instances: RemoteInstance[], id: string) => instances.find((i) => i.id === id)?.state;
const hasState = (id: string, state: RemoteSessionState) => (f: { instances: RemoteInstance[] }) =>
  stateOf(f.instances, id) === state;

let msg = 0;
const id = () => `m${++msg}`;

describe("phone dev harness", () => {
  it("authenticates a phone paired from its URL, with a VAPID key", async () => {
    const client = await HarnessClient.connect(bridge.pairingUrl());
    clients.push(client);
    expect(client.offer.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(client.authOk).toMatchObject({ hostName: "Multi-Code on MacBook Air", pushEnabled: false });
    // 65 bytes of P-256 point, base64url.
    expect(client.authOk?.vapidPublicKey).toHaveLength(87);
  });

  it("refuses a desktop whose key isn't the paired one, and closes the socket", async () => {
    const pairUrl = bridge.pairingUrl();
    const offer = JSON.parse(Buffer.from(new URL(pairUrl).hash.slice("#pair=".length), "base64url").toString());
    const forged = { ...offer, hostPublicKey: Buffer.alloc(32, 7).toString("base64") };
    const url = `${offer.origin}/#pair=${Buffer.from(JSON.stringify(forged)).toString("base64url")}`;
    await expect(HarnessClient.connect(url)).rejects.toThrow(/isn't the paired one/);
    // Every other socket here has authenticated; the refused one is gone.
    await vi.waitFor(() => expect(bridge.sockets().filter((s) => !s.authed)).toEqual([]));
  });

  it("sends the instances of every scenario", async () => {
    const client = await connect();
    const focus: Record<ScenarioName, RemoteSessionState | undefined> = {
      home: "needs-you",
      finished: "finished",
      permission: "needs-you",
      questions: "needs-you",
      plan: "needs-you",
      terminal: "needs-you",
      empty: undefined,
    };
    for (const name of SCENARIOS) {
      const instances = await scenario(client, name);
      if (name === "empty") {
        expect(instances).toEqual([]);
        continue;
      }
      expect(instances.map((i) => i.id)).toEqual([
        "multi-code",
        "data-pipeline",
        "apra-portal",
        "infra-terraform",
        "docs-site",
        "multi-code-review",
      ]);
      expect(stateOf(instances, "multi-code")).toBe(focus[name]);
      expect(stateOf(instances, "data-pipeline")).toBe("needs-you");
      expect(stateOf(instances, "apra-portal")).toBe("working");
      expect(stateOf(instances, "infra-terraform")).toBe("finished");
      expect(stateOf(instances, "docs-site")).toBe(name === "permission" ? "needs-you" : "idle");
      expect(instances.find((i) => i.id === "multi-code-review")).toMatchObject({ state: "idle", status: "stopped" });
      for (const i of instances) {
        expect(i.preview).toBeTruthy();
        expect(i.since).toBeLessThanOrEqual(Date.now());
      }
    }
  });

  it("subscribes by turns, with the terminal's size and the dialog in full", async () => {
    const client = await connect();
    await scenario(client, "questions");
    client.send({ type: "subscribe", instanceId: "multi-code" });
    const transcript = await client.next("transcript");
    expect(transcript.hasEarlier).toBe(true);
    expect(transcript.entries.filter((e) => e.kind === "user")).toHaveLength(10);
    expect(transcript.entries.at(-1)).toMatchObject({ kind: "tool", tool: "AskUserQuestion", pending: true });
    const snapshot = await client.next("snapshot");
    expect(snapshot).toMatchObject({ cols: 120, rows: 36 });
    expect(snapshot.data).toContain("Type something.");
    const state = await client.next("prompt-state");
    expect(state.dialog?.kind).toBe("questions");
    if (state.dialog?.kind === "questions") {
      expect(state.dialog.questions.map((q) => q.multiSelect)).toEqual([false, true]);
    }

    client.send({ type: "subscribe", instanceId: "multi-code", turns: 20 });
    expect((await client.next("transcript")).hasEarlier).toBe(false);
  });

  it("holds an answer to the dialog it names, and moves the session on", async () => {
    const client = await connect();
    await scenario(client, "permission");
    client.send({ type: "subscribe", instanceId: "multi-code" });
    const { seq } = await client.next("prompt-state");

    client.send({ type: "prompt", instanceId: "multi-code", text: "hi", clientMsgId: id() });
    expect(await client.next("ack")).toMatchObject({ ok: false, reason: "dialog-open" });
    client.send({ type: "answer", instanceId: "multi-code", seq: seq - 1, choice: { effect: "allow-once" }, clientMsgId: id() });
    expect(await client.next("ack")).toMatchObject({ ok: false, reason: "gone" });
    client.send({ type: "answer", instanceId: "multi-code", seq, choice: { effect: "allow-always" }, clientMsgId: id() });
    expect(await client.next("ack")).toMatchObject({ ok: false, reason: "needs-confirm" });

    const yes = id();
    bridge.log.length = 0;
    client.send({ type: "answer", instanceId: "multi-code", seq, choice: { effect: "allow-once" }, clientMsgId: yes });
    expect(await client.next("ack")).toEqual({ type: "ack", clientMsgId: yes, ok: true });
    expect(await client.next("prompt-cleared")).toMatchObject({ instanceId: "multi-code", seq });
    await client.next("instances", hasState("multi-code", "working"));

    // The world moved when the answer was taken, before its ack went out.
    expect(world.dialogOf("multi-code")).toBeUndefined();

    // Resent after a lost ack: the same ack, and nothing done twice.
    client.send({ type: "answer", instanceId: "multi-code", seq, choice: { effect: "allow-once" }, clientMsgId: yes });
    expect(await client.next("ack")).toEqual({ type: "ack", clientMsgId: yes, ok: true });
    expect(bridge.log.map((e) => e.resent ?? false)).toEqual([false, true]);

    await post("tick");
    await post("tick");
    await client.next("instances", hasState("multi-code", "finished"));
  });

  it("takes every question of a box in one answer", async () => {
    const client = await connect();
    await scenario(client, "questions");
    client.send({ type: "subscribe", instanceId: "multi-code" });
    const { seq } = await client.next("prompt-state");

    const partial = { answers: [{ question: 1, picks: [1] }] };
    client.send({ type: "answer", instanceId: "multi-code", seq, choice: partial, clientMsgId: id() });
    expect(await client.next("ack")).toMatchObject({ ok: false, reason: "failed" });

    const answers = [
      { question: 1, picks: [1] },
      { question: 2, picks: [1, 2], text: "桌面端" },
    ];
    client.send({ type: "answer", instanceId: "multi-code", seq, choice: { answers }, clientMsgId: id() });
    expect(await client.next("ack")).toMatchObject({ ok: true });
    await post("tick");
    await post("tick");
    const done = await client.next("transcript", (t) => t.entries.at(-1)?.kind === "assistant");
    expect(done.entries.at(-1)?.text).toContain("**Clients**: Web, iOS, 桌面端");
  });

  it("sends a revised plan back under a new seq", async () => {
    const client = await connect();
    await scenario(client, "plan");
    client.send({ type: "subscribe", instanceId: "multi-code" });
    const { seq } = await client.next("prompt-state");

    client.send({ type: "answer", instanceId: "multi-code", seq, choice: { effect: "revise" }, clientMsgId: id() });
    expect(await client.next("ack")).toMatchObject({ ok: false, reason: "failed" });
    client.send({ type: "answer", instanceId: "multi-code", seq, choice: { effect: "revise", feedback: "先不删旧分支" }, clientMsgId: id() });
    expect(await client.next("ack")).toMatchObject({ ok: true });
    await post("tick");
    const revised = await client.next("prompt-state");
    expect(revised.seq).toBeGreaterThan(seq);
    expect(revised.dialog?.kind === "plan" && revised.dialog.plan).toContain("先不删旧分支");
  });

  it("stops only a working turn, OpenCode's too", async () => {
    const client = await connect();
    await scenario(client, "home");
    const interrupt = async (instanceId: string) => {
      client.send({ type: "interrupt", instanceId, clientMsgId: id() });
      return client.next("ack");
    };
    expect(await interrupt("multi-code")).toMatchObject({ ok: false, reason: "dialog-open" });
    expect(await interrupt("docs-site")).toMatchObject({ ok: false, reason: "not-working" });
    expect(await interrupt("apra-portal")).toMatchObject({ ok: true });
    await client.next("instances", hasState("apra-portal", "idle"));

    client.send({ type: "prompt", instanceId: "multi-code-review", text: "hi", clientMsgId: id() });
    expect(await client.next("ack")).toMatchObject({ ok: false, reason: "not-running" });
    client.send({ type: "prompt", instanceId: "docs-site", text: "再改一下标题", clientMsgId: id() });
    expect(await client.next("ack")).toMatchObject({ ok: true });
    await client.next("instances", hasState("docs-site", "working"));
    expect(await interrupt("docs-site")).toMatchObject({ ok: true });
    await client.next("instances", hasState("docs-site", "idle"));
  });

  it("takes prompts queued during a turn once it stops, oldest first", async () => {
    const client = await connect();
    await scenario(client, "home");
    client.send({ type: "subscribe", instanceId: "apra-portal" });
    client.send({ type: "prompt", instanceId: "apra-portal", text: "queued first", clientMsgId: id() });
    expect(await client.next("ack")).toMatchObject({ ok: true });
    client.send({ type: "interrupt", instanceId: "apra-portal", clientMsgId: id() });
    expect(await client.next("ack")).toMatchObject({ ok: true });
    await client.next("instances", hasState("apra-portal", "working"));
    client.send({ type: "prompt", instanceId: "apra-portal", text: "sent after Stop", clientMsgId: id() });
    expect(await client.next("ack")).toMatchObject({ ok: true });
    for (let i = 0; i < 6; i++) await post("tick");
    const done = await client.next("transcript", (t) =>
      t.entries.filter((e) => e.kind === "user").some((e) => e.text === "sent after Stop")
    );
    expect(done.entries.filter((e) => e.kind === "user").slice(-2).map((e) => e.text)).toEqual([
      "queued first",
      "sent after Stop",
    ]);
  });

  it("gives each scenario's entries their own ids", async () => {
    const client = await connect();
    const ids = async (name: ScenarioName) => {
      await scenario(client, name);
      client.send({ type: "subscribe", instanceId: "multi-code", turns: 100 });
      return new Set((await client.next("transcript")).entries.map((e) => e.id));
    };
    const before = await ids("home");
    const after = await ids("permission");
    expect([...after].filter((x) => before.has(x))).toEqual([]);
  });

  it("marks a Finished session seen when a phone opens it", async () => {
    const client = await connect();
    await scenario(client, "finished");
    client.send({ type: "subscribe", instanceId: "multi-code" });
    await client.next("instances", hasState("multi-code", "idle"));
  });

  it("records keys from the terminal as sent, and remembers push", async () => {
    const client = await connect();
    await scenario(client, "home");
    bridge.log.length = 0;
    client.send({ type: "input", instanceId: "docs-site", data: "\x1b[A" });
    client.send({ type: "push-subscribe", subscription: { endpoint: "https://push.example/x", keys: { p256dh: "p", auth: "a" } }, clientMsgId: id() });
    expect(await client.next("ack")).toMatchObject({ ok: true });
    expect(bridge.log[0].frame).toEqual({ type: "input", instanceId: "docs-site", data: "\x1b[A" });

    const again = await HarnessClient.connect(bridge.pairingUrl());
    clients.push(again);
    expect(again.authOk?.pushEnabled).toBe(true);
  });

  it("doesn't let an old push-subscribe resent after a newer unsubscribe turn push back on", async () => {
    const client = await connect();
    const on = id();
    const subscription = { endpoint: "https://push.example/y", keys: { p256dh: "p", auth: "a" } };
    client.send({ type: "push-subscribe", subscription, clientMsgId: on });
    expect(await client.next("ack")).toMatchObject({ clientMsgId: on, ok: true });
    client.send({ type: "push-subscribe", subscription: null, clientMsgId: id() });
    expect(await client.next("ack")).toMatchObject({ ok: true });
    client.send({ type: "push-subscribe", subscription, clientMsgId: on });
    expect(await client.next("ack")).toMatchObject({ clientMsgId: on, ok: true });

    const again = await HarnessClient.connect(bridge.pairingUrl());
    clients.push(again);
    expect(again.authOk?.pushEnabled).toBe(false);
  });

  it("drops sockets, plays dead, and goes offline on command", async () => {
    const dropped = await connect();
    await post("drop");
    expect(await dropped.closed).toBe(1006);

    const quiet = await connect();
    await post("half-open");
    quiet.send({ type: "ping", at: 1 });
    await expect(quiet.next("pong", undefined, 300)).rejects.toThrow(/timed out/);
    const fresh = await connect();
    fresh.send({ type: "ping", at: 2 });
    expect(await fresh.next("pong")).toEqual({ type: "pong", at: 2 });

    await post("offline");
    await expect(HarnessClient.connect(bridge.pairingUrl())).rejects.toThrow();
    await post("online");
    await connect();
  });

  it("refuses a terminal size it can't paint", async () => {
    const client = await connect();
    await scenario(client, "home");
    for (const size of ["cols=1&rows=36", "cols=80.5&rows=36", "cols=Infinity&rows=36", "cols=100000&rows=36", "rows=36"]) {
      expect((await fetch(`${control.url}/resize/multi-code?${size}`, { method: "POST" })).status).toBe(400);
    }
    client.send({ type: "subscribe", instanceId: "multi-code" });
    expect(await client.next("snapshot")).toMatchObject({ cols: 120, rows: 36 });
    expect((await post("resize/multi-code?cols=100&rows=30")).ok).toBe(true);
    expect(await client.next("resize")).toMatchObject({ cols: 100, rows: 30 });
  });

  it("says so when the server can't come back online", async () => {
    const port = Number(new URL(bridge.pairingUrl()).port);
    await post("offline");
    const squatter = net.createServer();
    await new Promise<void>((resolve) => squatter.listen(port, "127.0.0.1", resolve));
    try {
      const res = await fetch(`${control.url}/online`, { method: "POST" });
      expect(res.status).toBe(500);
      expect(bridge.isOnline()).toBe(false);
    } finally {
      await new Promise((resolve) => squatter.close(resolve));
    }
    expect((await post("online")).ok).toBe(true);
    await connect();
  });
});
