// The plugin runs inside the user's own OpenCode, so the properties worth testing
// are the ones that protect it: inert outside Multi-Code, never throwing or
// waiting, never reporting twice. It is loaded here the way OpenCode loads it, as
// an ES module from the generated file, and posts into the real `/alert` endpoint,
// so the body shape is checked against the parser that will read it.
//
// The forwarding test replays a T-409 fixture (OpenCode 1.18.35) with the noise
// OpenCode interleaves put back in.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import http from "http";
import net from "net";
import os from "os";
import path from "path";
import { pathToFileURL } from "url";
import { ManagerMcpServer } from "../manager-mcp/server";
import {
  OPENCODE_INIT_EVENT,
  OPENCODE_PLUGIN_EVENTS,
  opencodePluginSource,
  withMulticodePlugin,
} from "./opencodePlugin";
import type { AlertDelivery } from "./types";

type Hooks = { event?: (input: { event: unknown }) => Promise<void> };
type PluginFn = (input: unknown) => Promise<Hooks>;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "multicode plugin-"));
const ENV_KEYS = ["MULTICODE_INSTANCE_ID", "MULTICODE_SPAWN_ID", "MULTICODE_ALERT_FILE"];
let server: ManagerMcpServer | null = null;
let received: AlertDelivery[] = [];
let loads = 0;

beforeEach(() => {
  received = [];
  delete (globalThis as Record<string, unknown>).__multicodeAlerts;
});

afterEach(async () => {
  for (const key of ENV_KEYS) delete process.env[key];
  delete (globalThis as Record<string, unknown>).__multicodeAlerts;
  await server?.stop();
  server = null;
});

// A fresh file per load: a module URL is imported once per process, and each test
// needs the plugin's init to run again.
async function loadPlugin(): Promise<{ exports: Record<string, unknown>; plugin: PluginFn }> {
  const file = path.join(dir, `multicode-plugin-${loads++}.js`);
  fs.writeFileSync(file, opencodePluginSource());
  const exports = (await import(/* @vite-ignore */ pathToFileURL(file).href)) as Record<string, unknown>;
  return { exports, plugin: Object.values(exports)[0] as PluginFn };
}

// Starts the real server and sets the env Multi-Code gives an OpenCode spawn.
async function startMulticode(target?: { endpoint: string; token: string }) {
  server = new ManagerMcpServer();
  server.onAlertDelivery((delivery) => received.push(delivery));
  await server.start();
  const targetPath = path.join(dir, "alert.json");
  fs.writeFileSync(
    targetPath,
    JSON.stringify(target ?? { endpoint: server.getAlertEndpoint(), token: server.getAlertToken() })
  );
  process.env.MULTICODE_INSTANCE_ID = "inst-1";
  process.env.MULTICODE_SPAWN_ID = "spawn-1";
  process.env.MULTICODE_ALERT_FILE = targetPath;
}

async function waitFor(count: number, timeoutMs = 2000) {
  const end = Date.now() + timeoutMs;
  while (received.length < count && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 10));
  }
}

const settle = () => new Promise((r) => setTimeout(r, 150));

describe("withMulticodePlugin", () => {
  const ours = "file:///Users/x/Library/Application%20Support/multi-code/opencode/multicode-plugin.js";

  it("names only our plugin when nothing was inherited", () => {
    expect(JSON.parse(withMulticodePlugin(undefined, ours)!)).toEqual({ plugin: [ours] });
    expect(JSON.parse(withMulticodePlugin("  ", ours)!)).toEqual({ plugin: [ours] });
  });

  it("keeps the user's own config and plugins, adding ours last", () => {
    const inherited = JSON.stringify({
      model: "anthropic/claude-sonnet",
      plugin: ["opencode-wakatime", ["some-plugin", { opt: 1 }]],
    });
    expect(JSON.parse(withMulticodePlugin(inherited, ours)!)).toEqual({
      model: "anthropic/claude-sonnet",
      plugin: ["opencode-wakatime", ["some-plugin", { opt: 1 }], ours],
    });
  });

  it("lists ours once when the inherited value already names it", () => {
    const inherited = JSON.stringify({ plugin: [ours, "opencode-wakatime"] });
    expect(JSON.parse(withMulticodePlugin(inherited, ours)!).plugin).toEqual([
      "opencode-wakatime",
      ours,
    ]);
  });

  it("never removes another entry, even one with our file name", () => {
    // A path can't tell a user's same-named plugin from a parent Multi-Code's, so
    // both stay; the plugin's newest-init guard handles a parent copy loading too.
    const theirs = [
      "file:///Users/x/plugins/multicode-plugin.js",
      "file:///Users/x/.config/opencode/multicode-plugin.js",
      "file:///Users/x/Library/Application%20Support/Multi-Code/opencode/multicode-plugin.js",
    ];
    expect(JSON.parse(withMulticodePlugin(JSON.stringify({ plugin: theirs }), ours)!).plugin).toEqual([
      ...theirs,
      ours,
    ]);
  });

  it("refuses a value it can't read rather than rewrite it", () => {
    expect(withMulticodePlugin('{ // jsonc\n "model": "x" }', ours)).toBeNull();
    expect(withMulticodePlugin("[1]", ours)).toBeNull();
    expect(withMulticodePlugin('"text"', ours)).toBeNull();
    expect(withMulticodePlugin(JSON.stringify({ plugin: "one" }), ours)).toBeNull();
  });
});

describe("the plugin", () => {
  it("exports exactly one thing, the plugin function", async () => {
    // OpenCode calls every export as a plugin.
    const { exports } = await loadPlugin();
    expect(Object.keys(exports)).toEqual(["MulticodeAlerts"]);
    expect(typeof exports.MulticodeAlerts).toBe("function");
  });

  it("does nothing in an OpenCode Multi-Code didn't start", async () => {
    await startMulticode();
    delete process.env.MULTICODE_INSTANCE_ID;
    const { plugin } = await loadPlugin();
    const hooks = await plugin({});
    expect(hooks).toEqual({});
    await settle();
    expect(received).toEqual([]);
  });

  it("reports its init under the instance's own ids", async () => {
    await startMulticode();
    const { plugin } = await loadPlugin();
    await plugin({});
    await waitFor(1);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      instanceId: "inst-1",
      spawnId: "spawn-1",
      event: OPENCODE_INIT_EVENT,
      payload: { pid: process.pid },
    });
  });

  it("forwards the events attention needs, in order, and nothing else", async () => {
    await startMulticode();
    const { plugin } = await loadPlugin();
    const hooks = await plugin({});
    const fixture = JSON.parse(
      fs.readFileSync(path.join(__dirname, "__fixtures__/opencode-plugin/subagent-permission.json"), "utf8")
    ) as { events: { type: string; properties: Record<string, unknown> }[] };

    const noise = ["message.part.delta", "message.part.updated", "session.idle", "plugin.added", "session.diff"];
    for (const [i, e] of fixture.events.entries()) {
      await hooks.event!({ event: { type: e.type, properties: e.properties } });
      await hooks.event!({ event: { type: noise[i % noise.length], properties: { sessionID: "x" } } });
    }

    const expected = fixture.events.filter((e) =>
      (OPENCODE_PLUGIN_EVENTS as readonly string[]).includes(e.type)
    );
    // The fixture has every kind the subagent path needs: a child session, its
    // permission, and the root's busy/idle.
    expect(new Set(expected.map((e) => e.type))).toEqual(
      new Set(["session.created", "session.updated", "session.status", "permission.asked", "permission.replied"])
    );
    await waitFor(expected.length + 1);
    await settle();
    const forwarded = received.slice(1);
    expect(forwarded.map((d) => d.event)).toEqual(expected.map((e) => e.type));
    for (const [i, delivery] of forwarded.entries()) {
      const props = expected[i].properties as { sessionID?: string; info?: { id?: string } };
      expect(delivery.sessionId).toBe(props.sessionID ?? props.info?.id);
      expect(delivery.payload.properties).toEqual(expected[i].properties);
    }
  });

  it("names a session event by its info id when it carries no sessionID", async () => {
    await startMulticode();
    const { plugin } = await loadPlugin();
    const hooks = await plugin({});
    await hooks.event!({ event: { type: "session.created", properties: { info: { id: "ses_child", parentID: "ses_root" } } } });
    await waitFor(2);
    expect(received[1]).toMatchObject({ event: "session.created", sessionId: "ses_child" });
  });

  it("takes its ids out of the env the agent's tools inherit", async () => {
    // Otherwise an `opencode` the agent runs loads this plugin with the same ids and
    // reports its sessions as this instance's.
    await startMulticode();
    const { plugin } = await loadPlugin();
    await plugin({});
    for (const key of ENV_KEYS) expect(process.env[key]).toBeUndefined();
  });

  it("neither throws nor waits when Multi-Code is wedged or gone", async () => {
    // Accepts the connection and never answers: the worst case for anything that
    // awaits a post.
    const sockets: net.Socket[] = [];
    const hung = net.createServer((socket) => sockets.push(socket));
    await new Promise<void>((r) => hung.listen(0, "127.0.0.1", r));
    const { port } = hung.address() as net.AddressInfo;
    try {
      for (const endpoint of [`http://127.0.0.1:${port}/alert`, "http://127.0.0.1:1/alert"]) {
        delete (globalThis as Record<string, unknown>).__multicodeAlerts;
        await server?.stop();
        await startMulticode({ endpoint, token: "t" });
        const { plugin } = await loadPlugin();
        const started = Date.now();
        const hooks = await plugin({});
        for (let i = 0; i < 50; i++) {
          await hooks.event!({ event: { type: "session.status", properties: { sessionID: "s", status: { type: "busy" } } } });
        }
        expect(Date.now() - started).toBeLessThan(100);
      }
    } finally {
      // Drains the queued posts, which would otherwise time out one by one.
      hung.close();
      for (const socket of sockets) socket.destroy();
    }
    await settle();
    expect(received).toEqual([]);
  });

  it("returns no hooks when its target file is missing or unreadable", async () => {
    await startMulticode();
    process.env.MULTICODE_ALERT_FILE = path.join(dir, "missing.json");
    expect(await (await loadPlugin()).plugin({})).toEqual({});

    delete (globalThis as Record<string, unknown>).__multicodeAlerts;
    process.env.MULTICODE_INSTANCE_ID = "inst-1";
    process.env.MULTICODE_SPAWN_ID = "spawn-1";
    const broken = path.join(dir, "broken.json");
    fs.writeFileSync(broken, "{not json");
    process.env.MULTICODE_ALERT_FILE = broken;
    expect(await (await loadPlugin()).plugin({})).toEqual({});
  });

  it("lets only the newest init in a process report", async () => {
    await startMulticode();
    const { plugin } = await loadPlugin();
    const first = await plugin({});
    const second = await plugin({});
    await waitFor(2);
    expect(received.map((d) => d.event)).toEqual([OPENCODE_INIT_EVENT, OPENCODE_INIT_EVENT]);

    const busy = { type: "session.status", properties: { sessionID: "s", status: { type: "busy" } } };
    await first.event!({ event: busy });
    await second.event!({ event: busy });
    await waitFor(3);
    await settle();
    expect(received.map((d) => d.event)).toEqual([
      OPENCODE_INIT_EVENT,
      OPENCODE_INIT_EVENT,
      "session.status",
    ]);
  });

  it("reports once when a second copy of the file loads too", async () => {
    // A parent Multi-Code's entry left in an inherited OPENCODE_CONFIG_CONTENT.
    await startMulticode();
    const parentCopy = await (await loadPlugin()).plugin({});
    const ours = await (await loadPlugin()).plugin({});
    const busy = { type: "session.status", properties: { sessionID: "s", status: { type: "busy" } } };
    await parentCopy.event!({ event: busy });
    await ours.event!({ event: busy });
    await waitFor(3);
    await settle();
    expect(received.map((d) => d.event)).toEqual([
      OPENCODE_INIT_EVENT,
      OPENCODE_INIT_EVENT,
      "session.status",
    ]);
  });

  it("keeps posting in order across a re-init while a post is stuck", async () => {
    // What the old copy queued happened first, so it must arrive first: an old
    // idle landing after the new copy's busy would read as the turn ending.
    const arrived: string[] = [];
    let release = () => {};
    const slow = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const p = JSON.parse(body) as { hook_event_name: string; session_id?: string };
        arrived.push(p.session_id ? `${p.hook_event_name}:${p.session_id}` : p.hook_event_name);
        if (arrived.length === 1) release = () => res.writeHead(204).end();
        else res.writeHead(204).end();
      });
    });
    await new Promise<void>((r) => slow.listen(0, "127.0.0.1", r));
    try {
      const { port } = slow.address() as net.AddressInfo;
      await startMulticode({ endpoint: `http://127.0.0.1:${port}/alert`, token: "t" });
      const { plugin } = await loadPlugin();
      const status = (sessionID: string, type: string) => ({
        event: { type: "session.status", properties: { sessionID, status: { type } } },
      });

      const old = await plugin({});
      await old.event!(status("old", "idle"));
      const end = Date.now() + 1000;
      while (arrived.length === 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 5));
      const current = await plugin({});
      await current.event!(status("new", "busy"));
      await settle();
      release();
      const done = Date.now() + 1000;
      while (arrived.length < 4 && Date.now() < done) await new Promise((r) => setTimeout(r, 5));

      expect(arrived).toEqual([
        OPENCODE_INIT_EVENT,
        "session.status:old",
        OPENCODE_INIT_EVENT,
        "session.status:new",
      ]);
    } finally {
      slow.close();
    }
  });
});
