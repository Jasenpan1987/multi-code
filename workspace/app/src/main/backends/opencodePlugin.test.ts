// The plugin runs inside the user's own OpenCode TUI, so the properties worth testing
// are the ones that protect it: inert outside Multi-Code, never throwing or waiting,
// reporting only what changed, never twice. It is loaded here the way OpenCode loads
// it, as an ES module from the generated file, with a fake `ctx` (the router and slot
// API of `packages/plugin/src/tui/context.ts`, v2.0.32), a fake `solid-js` beside it
// (OpenCode resolves the host's copy) and a fake `fetch`. One test posts into the real
// `/alert` endpoint, so the body shape is checked against the parser that reads it.
//
// The CLI config half is pure and reads `cli.json` only through the injected reader.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { pathToFileURL } from "url";
import { AlertServer } from "../alert-server/server";
import {
  OPENCODE_INIT_EVENT,
  OPENCODE_PLUGIN_ENTRY,
  OPENCODE_ROUTE_EVENT,
  opencodeCliConfig,
  opencodeCliConfigPath,
  opencodePluginSource,
} from "./opencodePlugin";
import type { AlertDelivery } from "./types";
import { OPENCODE_VIEW_KEYS } from "../../shared/replyStart";

type Route = { type: string; sessionID?: string; [key: string]: unknown };
type Claim = { append?: string; render: () => unknown };
type Plugin = { id: string; setup: (ctx: unknown) => unknown };

// A space in the path on purpose, as in the real userData.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "multicode tui-"));
const ENV_KEYS = ["MULTICODE_INSTANCE_ID", "MULTICODE_SPAWN_ID", "MULTICODE_ALERT_FILE"];

// The fake `solid-js`: createEffect runs its function now and keeps it, so a test can
// re-run every effect after changing the route, as Solid would.
fs.mkdirSync(path.join(dir, "node_modules", "solid-js"), { recursive: true });
fs.writeFileSync(
  path.join(dir, "node_modules", "solid-js", "package.json"),
  JSON.stringify({ name: "solid-js", type: "module", exports: "./index.js" })
);
fs.writeFileSync(
  path.join(dir, "node_modules", "solid-js", "index.js"),
  "export const createEffect = (fn) => globalThis.__fakeSolid.createEffect(fn);\n"
);

let effects: (() => void)[] = [];
let posts: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
let fetchImpl: (url: string, init: RequestInit) => Promise<Response>;
let loads = 0;

beforeEach(() => {
  effects = [];
  posts = [];
  fetchImpl = async () => new Response(null, { status: 204 });
  (globalThis as Record<string, unknown>).__fakeSolid = {
    createEffect: (fn: () => void) => {
      effects.push(fn);
      fn();
    },
  };
  vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
    posts.push({
      url,
      headers: init.headers as Record<string, string>,
      body: JSON.parse(init.body as string),
    });
    return fetchImpl(url, init);
  });
  delete (globalThis as Record<string, unknown>).__multicodeTui;
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const key of ENV_KEYS) delete process.env[key];
  // As a newer setup would: the test's plugin sends nothing more, so a retry still
  // in its queue can't land in the next test's posts.
  const state = (globalThis as Record<string, unknown>).__multicodeTui as { generation: number } | undefined;
  if (state) state.generation++;
  delete (globalThis as Record<string, unknown>).__multicodeTui;
});

// A fresh file per load: a module URL is imported once per process, and each test
// needs the plugin's setup to run against its own module state.
async function loadPlugin(): Promise<{ exports: Record<string, unknown>; plugin: Plugin }> {
  const file = path.join(dir, `tui-${loads++}.js`);
  fs.writeFileSync(file, opencodePluginSource());
  const exports = (await import(/* @vite-ignore */ pathToFileURL(file).href)) as Record<string, unknown>;
  return { exports, plugin: exports.default as Plugin };
}

// The TUI's ctx, as far as the plugin touches it.
function fakeCtx(initial: Route) {
  const ctx = {
    route: initial,
    claims: [] as Claim[],
    disposed: 0,
    ui: {
      router: { current: () => ctx.route },
      slot: (claim: Claim) => {
        ctx.claims.push(claim);
        // The host renders the claim; the plugin's effect is created inside it.
        claim.render();
        return () => {
          ctx.disposed++;
        };
      },
    },
  };
  return ctx;
}

function navigate(ctx: ReturnType<typeof fakeCtx>, route: Route) {
  ctx.route = route;
  for (const effect of effects) effect();
}

function setMulticodeEnv(target = { endpoint: "http://127.0.0.1:9/alert", token: "tok_test" }) {
  const file = path.join(dir, "alert.json");
  fs.writeFileSync(file, JSON.stringify(target));
  process.env.MULTICODE_INSTANCE_ID = "inst-1";
  process.env.MULTICODE_SPAWN_ID = "spawn-1";
  process.env.MULTICODE_ALERT_FILE = file;
  return file;
}

async function flush(count: number, timeoutMs = 1000) {
  const end = Date.now() + timeoutMs;
  while (posts.length < count && Date.now() < end) await new Promise((r) => setTimeout(r, 5));
}

const settle = () => new Promise((r) => setTimeout(r, 50));

describe("the TUI plugin", () => {
  it("has the shape OpenCode loads: one default export with an id and a setup", async () => {
    const { exports, plugin } = await loadPlugin();
    expect(Object.keys(exports)).toEqual(["default"]);
    expect(plugin.id).toBe("multicode");
    expect(typeof plugin.setup).toBe("function");
    expect(OPENCODE_PLUGIN_ENTRY).toBe("tui.js");
  });

  it("does nothing in a TUI Multi-Code didn't start", async () => {
    setMulticodeEnv();
    delete process.env.MULTICODE_INSTANCE_ID;
    const { plugin } = await loadPlugin();
    const ctx = fakeCtx({ type: "home" });
    expect(plugin.setup(ctx)).toBeUndefined();
    navigate(ctx, { type: "session", sessionID: "ses_x" });
    await settle();
    expect(posts).toEqual([]);
    // Not even a slot: nothing of it in the user's TUI.
    expect(ctx.claims).toEqual([]);
  });

  it("posts its init and the starting route, under the instance's own ids", async () => {
    setMulticodeEnv();
    const { plugin } = await loadPlugin();
    plugin.setup(fakeCtx({ type: "home" }));
    await flush(2);
    expect(posts.map((p) => p.body)).toEqual([
      { hook_event_name: OPENCODE_INIT_EVENT, pid: process.pid },
      { hook_event_name: OPENCODE_ROUTE_EVENT, route: { type: "home" } },
    ]);
    for (const post of posts) {
      expect(post.url).toBe("http://127.0.0.1:9/alert");
      expect(post.headers).toEqual({
        Authorization: "Bearer tok_test",
        "Content-Type": "application/json",
        "X-Multicode-Instance": "inst-1",
        "X-Multicode-Spawn": "spawn-1",
      });
    }
  });

  it("reports each route change, the session's id on session routes only", async () => {
    // The spike's sequence (G-601): home with a minted id, the first prompt, `/new`
    // (home with a location), a prompt there, a plugin page, back to a session.
    setMulticodeEnv();
    const { plugin } = await loadPlugin();
    const ctx = fakeCtx({ type: "home" });
    plugin.setup(ctx);
    navigate(ctx, { type: "session", sessionID: "ses_minted" });
    navigate(ctx, { type: "home", location: { directory: "/private/tmp/p" } });
    navigate(ctx, { type: "session", sessionID: "ses_new" });
    navigate(ctx, { type: "plugin", id: "opencode.stats", name: "stats" });
    navigate(ctx, { type: "session", sessionID: "ses_new" });
    await flush(7);
    expect(posts.slice(1).map((p) => p.body)).toEqual([
      { hook_event_name: OPENCODE_ROUTE_EVENT, route: { type: "home" } },
      { hook_event_name: OPENCODE_ROUTE_EVENT, session_id: "ses_minted", route: { type: "session", sessionID: "ses_minted" } },
      { hook_event_name: OPENCODE_ROUTE_EVENT, route: { type: "home" } },
      { hook_event_name: OPENCODE_ROUTE_EVENT, session_id: "ses_new", route: { type: "session", sessionID: "ses_new" } },
      { hook_event_name: OPENCODE_ROUTE_EVENT, route: { type: "plugin" } },
      { hook_event_name: OPENCODE_ROUTE_EVENT, session_id: "ses_new", route: { type: "session", sessionID: "ses_new" } },
    ]);
  });

  it("says nothing when an effect re-runs on the same route", async () => {
    setMulticodeEnv();
    const { plugin } = await loadPlugin();
    const ctx = fakeCtx({ type: "session", sessionID: "ses_a" });
    plugin.setup(ctx);
    navigate(ctx, { type: "session", sessionID: "ses_a", other: 1 });
    navigate(ctx, { type: "session", sessionID: "ses_a" });
    await settle();
    expect(posts.map((p) => p.body.hook_event_name)).toEqual([OPENCODE_INIT_EVENT, OPENCODE_ROUTE_EVENT]);
  });

  it("copies the route rather than keeping the store's object", async () => {
    // The route is a store proxy that changes in place; a queued post must carry what
    // the route was when it was read.
    setMulticodeEnv();
    let release = () => {};
    fetchImpl = () => new Promise((resolve) => (release = () => resolve(new Response(null, { status: 204 }))));
    const { plugin } = await loadPlugin();
    const route: Route = { type: "session", sessionID: "ses_a" };
    const ctx = fakeCtx(route);
    plugin.setup(ctx);
    // The init post is in flight and the route's is queued behind it.
    await flush(1);
    route.sessionID = "ses_b";
    release();
    await flush(2);
    expect(posts[1].body).toEqual({
      hook_event_name: OPENCODE_ROUTE_EVENT,
      session_id: "ses_a",
      route: { type: "session", sessionID: "ses_a" },
    });
  });

  it("takes its ids out of the env the agent's tools and a restarted service inherit", async () => {
    setMulticodeEnv();
    const { plugin } = await loadPlugin();
    plugin.setup(fakeCtx({ type: "home" }));
    for (const key of ENV_KEYS) expect(process.env[key]).toBeUndefined();
  });

  it("disposes its slot when OpenCode runs its cleanup", async () => {
    setMulticodeEnv();
    const { plugin } = await loadPlugin();
    const ctx = fakeCtx({ type: "home" });
    const cleanup = plugin.setup(ctx) as () => void;
    expect(ctx.claims).toHaveLength(1);
    expect(ctx.claims[0].append).toBe("app");
    cleanup();
    expect(ctx.disposed).toBe(1);
  });

  it("sends nothing more once OpenCode has run its cleanup", async () => {
    setMulticodeEnv();
    const { plugin } = await loadPlugin();
    const ctx = fakeCtx({ type: "home" });
    const cleanup = plugin.setup(ctx) as () => void;
    await flush(2);
    cleanup();
    navigate(ctx, { type: "session", sessionID: "ses_after" });
    await settle();
    expect(posts).toHaveLength(2);
  });

  it("neither throws nor waits when Multi-Code is wedged or gone", async () => {
    setMulticodeEnv();
    const hung: (() => void)[] = [];
    fetchImpl = () => new Promise((_resolve, reject) => hung.push(() => reject(new Error("refused"))));
    const { plugin } = await loadPlugin();
    const ctx = fakeCtx({ type: "home" });
    const started = Date.now();
    plugin.setup(ctx);
    for (let i = 0; i < 100; i++) navigate(ctx, { type: "session", sessionID: `ses_${i}` });
    expect(Date.now() - started).toBeLessThan(200);

    // A broken router is swallowed too.
    ctx.ui.router.current = () => {
      throw new Error("router gone");
    };
    expect(() => navigate(ctx, { type: "home" })).not.toThrow();

    // Refusals drain the queue in order, each swallowed.
    fetchImpl = () => Promise.reject(new Error("refused"));
    for (const reject of hung) reject();
    const state = (globalThis as Record<string, unknown>).__multicodeTui as { queued: number };
    const end = Date.now() + 2000;
    while (state.queued > 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 5));
    expect(state.queued).toBe(0);
    // init, home and 100 routes. The last one, still shown, waits for its retry.
    expect(posts).toHaveLength(102);
  });

  it("sends a route again when its post fails, while it is still the route shown", async () => {
    setMulticodeEnv();
    const { plugin } = await loadPlugin();
    const ctx = fakeCtx({ type: "session", sessionID: "ses_a" });
    plugin.setup(ctx);
    await flush(2);
    // B's first post is lost (Multi-Code busy past the timeout); the next one lands.
    let failures = 1;
    fetchImpl = async () => {
      if (failures-- > 0) throw new Error("timeout");
      return new Response(null, { status: 204 });
    };
    navigate(ctx, { type: "session", sessionID: "ses_b" });
    await flush(4);
    await settle();
    expect(posts.map((p) => p.body.session_id ?? null)).toEqual([null, "ses_a", "ses_b", "ses_b"]);
  });

  it("keeps sending a failing route, further apart each time, and stops once the terminal leaves it", async () => {
    setMulticodeEnv();
    const sentA: number[] = [];
    fetchImpl = async (_url, init) => {
      if (JSON.parse(init.body as string).session_id !== "ses_a") return new Response(null, { status: 204 });
      sentA.push(Date.now());
      return new Response(null, { status: 503 });
    };
    const { plugin } = await loadPlugin();
    const ctx = fakeCtx({ type: "session", sessionID: "ses_a" });
    plugin.setup(ctx);
    await flush(4, 3000);
    expect(sentA).toHaveLength(3);
    // About 500 ms, then about 1000 ms.
    expect(sentA[1] - sentA[0]).toBeGreaterThanOrEqual(450);
    expect(sentA[2] - sentA[1]).toBeGreaterThanOrEqual(950);

    navigate(ctx, { type: "session", sessionID: "ses_b" });
    await flush(5);
    // Past the 2000 ms A's next try would have waited.
    await new Promise((r) => setTimeout(r, 2200));
    expect(sentA).toHaveLength(3);
    expect(posts.map((p) => p.body.session_id ?? null)).toEqual([null, "ses_a", "ses_a", "ses_a", "ses_b"]);
  });

  it("gives every post an abort signal, so a hung one stops holding up the next", async () => {
    setMulticodeEnv();
    const signals: (AbortSignal | null | undefined)[] = [];
    fetchImpl = async (_url, init) => {
      signals.push(init.signal);
      return new Response(null, { status: 204 });
    };
    const { plugin } = await loadPlugin();
    plugin.setup(fakeCtx({ type: "home" }));
    await flush(2);
    expect(signals).toHaveLength(2);
    for (const signal of signals) expect(signal).toBeInstanceOf(AbortSignal);
    expect(opencodePluginSource()).toContain("AbortSignal.timeout(2000)");
  });

  it("caps what it queues while a post hangs", async () => {
    setMulticodeEnv();
    fetchImpl = () => new Promise(() => {});
    const { plugin } = await loadPlugin();
    const ctx = fakeCtx({ type: "home" });
    plugin.setup(ctx);
    for (let i = 0; i < 500; i++) navigate(ctx, { type: "session", sessionID: `ses_${i}` });
    const state = (globalThis as Record<string, unknown>).__multicodeTui as { queued: number };
    expect(state.queued).toBe(200);
  });

  it("returns nothing when its target file is missing or unreadable", async () => {
    setMulticodeEnv();
    process.env.MULTICODE_ALERT_FILE = path.join(dir, "missing.json");
    const ctx = fakeCtx({ type: "home" });
    expect((await loadPlugin()).plugin.setup(ctx)).toBeUndefined();

    delete (globalThis as Record<string, unknown>).__multicodeTui;
    setMulticodeEnv();
    const broken = path.join(dir, "broken.json");
    fs.writeFileSync(broken, "{not json");
    process.env.MULTICODE_ALERT_FILE = broken;
    expect((await loadPlugin()).plugin.setup(ctx)).toBeUndefined();
    await settle();
    expect(posts).toEqual([]);
    expect(ctx.claims).toEqual([]);
  });

  it("lets only the newest setup in a process report", async () => {
    // OpenCode reloads a local plugin whose file changed; the old copy's effect may
    // run once more before its slot goes.
    setMulticodeEnv();
    const old = fakeCtx({ type: "home" });
    (await loadPlugin()).plugin.setup(old);
    const oldEffects = effects;
    effects = [];
    const current = fakeCtx({ type: "home" });
    (await loadPlugin()).plugin.setup(current);
    await flush(4);
    expect(posts.map((p) => p.body.hook_event_name)).toEqual([
      OPENCODE_INIT_EVENT,
      OPENCODE_ROUTE_EVENT,
      OPENCODE_INIT_EVENT,
      OPENCODE_ROUTE_EVENT,
    ]);

    old.route = { type: "session", sessionID: "ses_old" };
    for (const effect of oldEffects) effect();
    navigate(current, { type: "session", sessionID: "ses_new" });
    await flush(5);
    await settle();
    expect(posts.slice(4).map((p) => p.body.session_id)).toEqual(["ses_new"]);
  });

  it("is read by the real /alert endpoint as the delivery T-604 consumes", async () => {
    const server = new AlertServer();
    const received: AlertDelivery[] = [];
    server.onAlertDelivery((delivery) => received.push(delivery));
    await server.start();
    try {
      vi.unstubAllGlobals();
      setMulticodeEnv({ endpoint: server.getAlertEndpoint()!, token: server.getAlertToken()! });
      const { plugin } = await loadPlugin();
      const ctx = fakeCtx({ type: "home" });
      plugin.setup(ctx);
      navigate(ctx, { type: "session", sessionID: "ses_abc" });
      const end = Date.now() + 2000;
      while (received.length < 3 && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
      expect(received.map((d) => [d.event, d.sessionId])).toEqual([
        [OPENCODE_INIT_EVENT, undefined],
        [OPENCODE_ROUTE_EVENT, undefined],
        [OPENCODE_ROUTE_EVENT, "ses_abc"],
      ]);
      expect(received[2]).toMatchObject({
        instanceId: "inst-1",
        spawnId: "spawn-1",
        payload: { route: { type: "session", sessionID: "ses_abc" } },
      });
    } finally {
      await server.stop();
    }
  });
});

describe("opencodeCliConfig", () => {
  const pluginDir = "/Users/x/Library/Application Support/multi-code/opencode/tui";
  const cliJsonPath = "/Users/x/.config/opencode/cli.json";
  const ours = { package: pluginDir };
  // Ctrl+Z off and the two view keys, after OpenCode's defaults for those commands:
  // tabs follow the builder's own settings (2026-10-20).
  const last = OPENCODE_VIEW_KEYS["session.last"].stroke;
  const previous = OPENCODE_VIEW_KEYS["session.message.previous"].stroke;
  const viewKeys = {
    "session.last": ["ctrl+alt+g", "end", last],
    "session.message.previous": [previous],
  };
  const settings = { keybinds: { "terminal.suspend": "none", ...viewKeys } };
  const missing = () => {
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  };
  const file = (text: string) => (p: string) => {
    expect(p).toBe(cliJsonPath);
    return text;
  };
  const parse = (result: ReturnType<typeof opencodeCliConfig>) => JSON.parse(result!.content);

  it("names only Multi-Code's plugin when there is no cli.json", () => {
    const result = opencodeCliConfig({ inherited: undefined, cliJsonPath, pluginDir, readFile: missing });
    expect(result!.plugin).toBe(true);
    expect(parse(result)).toEqual({ ...settings, plugins: [ours] });
  });

  it("keeps the builder's own plugins first, relative ones resolved against cli.json's folder", () => {
    // `localSource` (packages/plugin/src/source.ts): file URLs as they are, ./ ../ and
    // absolute paths against the config's directory, anything else an npm spec or a
    // selector, untouched.
    const text = `{
      // their TUI plugins
      "theme": { "name": "nord" },
      "plugins": [
        "./plugins/mine",
        "../shared/theirs",
        "/abs/plugin",
        "file:///Users/x/url-plugin",
        "opencode-wakatime@1.2.0",
        "-opencode.stats",
        { "package": "./opts-plugin", "options": { "a": 1 } },
        { "package": "@scope/pkg" },
      ],
    }`;
    const result = opencodeCliConfig({ inherited: undefined, cliJsonPath, pluginDir, readFile: file(text) });
    expect(result!.plugin).toBe(true);
    // Only the list is copied: the rest of cli.json applies by itself, under this value.
    expect(parse(result)).toEqual({
      ...settings,
      plugins: [
        "/Users/x/.config/opencode/plugins/mine",
        "/Users/x/.config/shared/theirs",
        "/abs/plugin",
        "file:///Users/x/url-plugin",
        "opencode-wakatime@1.2.0",
        "-opencode.stats",
        { package: "/Users/x/.config/opencode/opts-plugin", options: { a: 1 } },
        { package: "@scope/pkg" },
        ours,
      ],
    });
  });

  it("adds the plugin to a cli.json without a plugins key", () => {
    const result = opencodeCliConfig({
      inherited: undefined,
      cliJsonPath,
      pluginDir,
      readFile: file(JSON.stringify({ $schema: "https://opencode.ai/v2/cli.json", theme: { name: "x" } })),
    });
    expect(parse(result)).toEqual({ ...settings, plugins: [ours] });
  });

  it("leaves the plugins alone and adds none when cli.json can't be read safely", () => {
    for (const readFile of [
      file("{ not json"),
      file("[1, 2]"),
      file(JSON.stringify({ plugins: "one" })),
      file(JSON.stringify({ plugins: [42] })),
      file(JSON.stringify({ plugins: [{ package: "./x", options: "bad" }] })),
      () => {
        throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      },
    ]) {
      const result = opencodeCliConfig({ inherited: undefined, cliJsonPath, pluginDir, readFile });
      expect(result!.plugin).toBe(false);
      // Still Multi-Code's own settings, but no `plugins`, so the builder's load as in
      // any terminal.
      expect(parse(result)).toEqual(settings);
    }
  });

  it("merges into an inherited OPENCODE_CLI_CONFIG_CONTENT, extending its own plugins", () => {
    // Its `plugins` already replaces cli.json's, so it is the list to keep.
    const inherited = JSON.stringify({
      theme: { name: "nord" },
      tabs: { scope: "global", mode: "on" },
      keybinds: { "app.exit": "ctrl+q" },
      plugins: ["./env-plugin"],
    });
    const result = opencodeCliConfig({
      inherited,
      cliJsonPath,
      pluginDir,
      readFile: file(JSON.stringify({ plugins: ["not-these"] })),
    });
    expect(parse(result)).toEqual({
      theme: { name: "nord" },
      // The builder's tab settings pass through untouched.
      tabs: { scope: "global", mode: "on" },
      keybinds: { "app.exit": "ctrl+q", "terminal.suspend": "none", ...viewKeys },
      plugins: ["/Users/x/.config/opencode/env-plugin", ours],
    });
  });

  it("adds each view key after the builder's own keys for that command, from cli.json", () => {
    const result = opencodeCliConfig({
      inherited: undefined,
      cliJsonPath,
      pluginDir,
      readFile: file(
        JSON.stringify({
          keybinds: { "session.last": "ctrl+e, end", "session.message.previous": ["alt+up"], "app.exit": "x" },
        })
      ),
    });
    // Only the two commands are copied: cli.json's other keys apply by themselves.
    expect(parse(result).keybinds).toEqual({
      "terminal.suspend": "none",
      "session.last": ["ctrl+e", "end", last],
      "session.message.previous": ["alt+up", previous],
    });
  });

  it("takes the inherited value's keys for a command over cli.json's", () => {
    const result = opencodeCliConfig({
      inherited: JSON.stringify({ keybinds: { "session.last": false, "session.message.previous": "none" } }),
      cliJsonPath,
      pluginDir,
      readFile: file(JSON.stringify({ keybinds: { "session.last": "ctrl+e" } })),
    });
    expect(parse(result).keybinds).toEqual({
      "terminal.suspend": "none",
      "session.last": [last],
      "session.message.previous": [previous],
    });
  });

  it("keeps a binding object as one key, and falls back to the default for a value OpenCode rejects", () => {
    const result = opencodeCliConfig({
      inherited: undefined,
      cliJsonPath,
      pluginDir,
      readFile: file(
        JSON.stringify({ keybinds: { "session.last": 42, "session.message.previous": { key: "alt+p" } } })
      ),
    });
    expect(parse(result).keybinds).toEqual({
      "terminal.suspend": "none",
      "session.last": ["ctrl+alt+g", "end", last],
      "session.message.previous": [{ key: "alt+p" }, previous],
    });
  });

  it("uses OpenCode's defaults for the view commands when cli.json can't be read", () => {
    const result = opencodeCliConfig({ inherited: undefined, cliJsonPath, pluginDir, readFile: file("{ bad") });
    expect(parse(result).keybinds).toEqual(settings.keybinds);
  });

  it("copies cli.json's plugins under an inherited value that has none", () => {
    const result = opencodeCliConfig({
      inherited: JSON.stringify({ theme: { name: "nord" } }),
      cliJsonPath,
      pluginDir,
      readFile: file(JSON.stringify({ plugins: ["theirs"] })),
    });
    expect(parse(result)).toEqual({ theme: { name: "nord" }, ...settings, plugins: ["theirs", ours] });
  });

  it("refuses an inherited value it can't read rather than rewrite it", () => {
    for (const inherited of ["{ broken", "[1]", '"text"']) {
      expect(opencodeCliConfig({ inherited, cliJsonPath, pluginDir, readFile: missing })).toBeNull();
    }
    // And an inherited list that isn't one: settings merged, no plugin.
    const result = opencodeCliConfig({
      inherited: JSON.stringify({ plugins: "x" }),
      cliJsonPath,
      pluginDir,
      readFile: missing,
    });
    expect(result!.plugin).toBe(false);
    expect(parse(result).plugins).toBe("x");
  });

  it("lists Multi-Code's plugin once", () => {
    const result = opencodeCliConfig({
      inherited: JSON.stringify({ plugins: [pluginDir, "theirs", { package: pluginDir }] }),
      cliJsonPath,
      pluginDir,
      readFile: missing,
    });
    expect(parse(result).plugins).toEqual(["theirs", ours]);
  });

  it("sets only Multi-Code's settings when there is no plugin to load", () => {
    const result = opencodeCliConfig({ inherited: undefined, cliJsonPath, readFile: file('{"plugins":["theirs"]}') });
    expect(result!.plugin).toBe(false);
    expect(parse(result)).toEqual(settings);
  });
});

describe("opencodeCliConfigPath", () => {
  it("follows OpenCode's own lookup", () => {
    expect(opencodeCliConfigPath({ HOME: "/h" })).toBe("/h/.config/opencode/cli.json");
    expect(opencodeCliConfigPath({ HOME: "/h", XDG_CONFIG_HOME: "/x" })).toBe("/x/opencode/cli.json");
    expect(opencodeCliConfigPath({ HOME: "/h", XDG_CONFIG_HOME: "/x", OPENCODE_CONFIG_DIR: "/c" })).toBe(
      "/c/cli.json"
    );
    // Empty counts as unset, as OpenCode's truthiness checks do.
    expect(opencodeCliConfigPath({ HOME: "/h", XDG_CONFIG_HOME: "", OPENCODE_CONFIG_DIR: "" })).toBe(
      "/h/.config/opencode/cli.json"
    );
  });
});
