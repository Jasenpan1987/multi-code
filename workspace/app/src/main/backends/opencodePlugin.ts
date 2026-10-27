// Multi-Code's OpenCode TUI plugin: the source written into userData, the deliveries
// it makes, and the per-process TUI settings (OPENCODE_CLI_CONFIG_CONTENT) that load
// it.
//
// OpenCode 2 runs every turn in one shared service per user; a TUI is only a client
// (docs/knowledge/decisions.md, 2026-10-16 "OpenCode 2 runs the way its VS Code
// extension runs it"). Multi-Code reads state from the service's event stream, and
// nothing in that stream says which session a terminal shows: `/sessions` and
// `/clear` publish no frame at all. So this plugin runs inside the TUI and reports
// its route, and nothing else. It goes to the same `/alert` endpoint, under the same
// headers, as Claude's alert hooks; T-604's attention reads the deliveries.
//
// Loaded only by the TUIs Multi-Code starts, because the only thing naming it is
// OPENCODE_CLI_CONFIG_CONTENT in that process's env, which only the CLI/TUI process
// reads; plain `opencode` and the shared service never see it (PRD Story 10).
//
// Measured on OpenCode 2.0.32 (T-601, docs/timeline/2026-10-20_opencode-v2-spike.md,
// G-601): a directory entry loads `<dir>/tui.js` (`index.js` is the server entry and
// does not load as a TUI plugin); `ctx.ui.router.current()` is `{type:"home"}` until
// the first prompt creates the `--session` id, then `{type:"session", sessionID}`;
// an effect inside a `ui.slot` reported each change 11-18 ms after Enter, against
// 25-95 ms for 100 ms polling; `solid-js` imported from a plain file outside any
// node_modules resolves to the host's copy.

import fs from "fs";
import os from "os";
import path from "path";
import { ALERT_FILE_ENV, INSTANCE_ENV, SPAWN_ENV } from "./instance-env";
import { stripJsonc } from "./opencodeDb";
import { OPENCODE_VIEW_KEYS } from "../../shared/replyStart";
import type { OpencodeViewCommand } from "../../shared/replyStart";

// The plugin's directory in `<userData>/opencode/`, and its entry file in there.
export const OPENCODE_PLUGIN_DIR = "tui";
export const OPENCODE_PLUGIN_ENTRY = "tui.js";

// The plugin's deliveries. `multicode.init` once per setup, so a TUI whose plugin
// loaded can be told from one whose plugin never ran (PRD Story 9); `multicode.route`
// whenever the terminal's route changes, with `session_id` when it shows a session.
export const OPENCODE_INIT_EVENT = "multicode.init";
export const OPENCODE_ROUTE_EVENT = "multicode.route";

// Bounds on what the plugin queues and how long one post may take. Posts are
// localhost and answered with a 204 before Multi-Code does anything, so these only
// matter when Multi-Code is wedged: the queue drops instead of growing, and a hung
// post stops holding up the next one after 2s.
const MAX_QUEUED = 200;
const POST_TIMEOUT_MS = 2000;

// A route is said once, when it changes, so a lost post (a timeout while Multi-Code
// was busy, its server restarting) would leave the contact on the session before for
// good. A failed one is sent again after a wait that doubles up to the max, for as
// long as the terminal still shows that route and the plugin is live.
const ROUTE_RETRY_MIN_MS = 500;
const ROUTE_RETRY_MAX_MS = 30_000;

// The plugin's source. Plain JS, importing only `fs` and the host's `solid-js`,
// because OpenCode runs it inside the user's TUI and nothing here may need installing.
// Rules it keeps, each because it runs inside someone else's terminal:
//   - Report-only: it reads the route and posts it. It never navigates, prompts,
//     answers or registers anything but one empty slot.
//   - Inert unless Multi-Code started this process: no instance id, no reports.
//   - Setup does one small file read and returns. It holds up the TUI's start.
//   - Nothing awaits the network: posts go on a FIFO and the effect returns at once.
//     Every error is swallowed; nothing goes to stdout, which is the TUI's screen.
//   - The token comes from the 0600 file the env names, never from the env itself.
//   - The route is copied field by field: it is a store proxy, and a retained one
//     would change under the queue.
//
// After reading its ids it deletes them from `process.env`, so a service this TUI
// restarts (OpenCode respawns a dead one from an attached TUI) doesn't inherit them
// (measured in T-611: the respawned service had none). It can't take them out of the
// env the TUI has already pushed for its root session: the agent's shell there still
// sees them, as a Claude contact's Bash does (spike G-605, accepted). The ids are kept
// on globalThis for a later setup in the same process.
//
// The newest setup wins. OpenCode reloads a local plugin when its file changes (a
// second Multi-Code sharing userData rewrites it on start), and the old copy's effect
// must not be the one left talking. Every setup posts through the one FIFO on
// globalThis, so what the old copy had queued still goes out first.
export function opencodePluginSource(): string {
  return `// Multi-Code's OpenCode TUI plugin. Written by Multi-Code into its own data folder on
// every start and loaded only by the OpenCode terminals it launches. Report-only:
// tells Multi-Code which session this terminal shows, changes nothing.
import fs from "fs";
import { createEffect } from "solid-js";

export default {
  id: "multicode",
  setup(ctx) {
    try {
      const state = (globalThis.__multicodeTui ??= {
        instance: process.env.${INSTANCE_ENV},
        spawn: process.env.${SPAWN_ENV},
        file: process.env.${ALERT_FILE_ENV},
        generation: 0,
        queue: Promise.resolve(),
        queued: 0,
      });
      delete process.env.${INSTANCE_ENV};
      delete process.env.${SPAWN_ENV};
      delete process.env.${ALERT_FILE_ENV};
      if (!state.instance || !state.spawn || !state.file) return;

      const target = JSON.parse(fs.readFileSync(state.file, "utf8"));
      if (typeof target?.endpoint !== "string" || typeof target?.token !== "string") return;
      const headers = {
        "Authorization": "Bearer " + target.token,
        "Content-Type": "application/json",
        "X-Multicode-Instance": state.instance,
        "X-Multicode-Spawn": state.spawn,
      };

      const generation = ++state.generation;
      let disposed = false;
      // Resolves true once Multi-Code took it, false when it didn't. A newer setup's
      // own posts speak for this TUI, and a disposed one says nothing more, so their
      // posts are dropped and count as done.
      const post = (body) => {
        if (disposed || generation !== state.generation) return Promise.resolve(true);
        if (state.queued >= ${MAX_QUEUED}) return Promise.resolve(false);
        const payload = JSON.stringify(body);
        state.queued++;
        const sent = state.queue
          .then(() => fetch(target.endpoint, {
            method: "POST",
            headers,
            body: payload,
            signal: AbortSignal.timeout(${POST_TIMEOUT_MS}),
          }))
          .then((res) => Promise.resolve(res.body?.cancel()).then(() => res.ok, () => res.ok))
          .catch(() => false)
          .finally(() => { state.queued--; });
        state.queue = sent;
        return sent;
      };

      post({ hook_event_name: ${JSON.stringify(OPENCODE_INIT_EVENT)}, pid: process.pid });

      let last;
      let retry;
      const report = () => {
        try {
          const current = ctx.ui.router.current();
          const type = current?.type;
          const sessionID = current?.sessionID;
          if (typeof type !== "string") return;
          const route = { type };
          if (typeof sessionID === "string") route.sessionID = sessionID;
          const key = type + "\\n" + (route.sessionID ?? "");
          if (key === last) return;
          last = key;
          clearTimeout(retry);
          const body = { hook_event_name: ${JSON.stringify(OPENCODE_ROUTE_EVENT)}, route };
          if (type === "session" && route.sessionID) body.session_id = route.sessionID;
          const send = (wait) =>
            post(body).then((ok) => {
              if (ok || disposed || last !== key) return;
              retry = setTimeout(() => {
                if (last === key) send(Math.min(wait * 2, ${ROUTE_RETRY_MAX_MS}));
              }, wait);
            });
          send(${ROUTE_RETRY_MIN_MS});
        } catch {}
      };

      // The built-in stats plugin's pattern: an effect owned by a slot that renders
      // nothing, so it lives exactly as long as this plugin's setup.
      const dispose = ctx.ui.slot({
        append: "app",
        render() {
          createEffect(() => report());
          return null;
        },
      });
      return () => {
        disposed = true;
        clearTimeout(retry);
        try {
          if (typeof dispose === "function") dispose();
        } catch {}
      };
    } catch {
      return;
    }
  },
};
`;
}

// ------------------------------------------------------------ TUI settings

// Multi-Code's per-process TUI settings. Tabs are not among them: they follow the
// builder's own settings, as in any terminal (builder, 2026-10-20; decisions.md). Ctrl+Z
// off: by default it suspends the renderer, and in a pty child the frozen TUI can't be
// told from a busy one (spike, G-601: `ps` still showed it running).
const TUI_SETTINGS = { keybinds: { "terminal.suspend": "none" } } as const;

// The two commands that show a finished turn's conclusion get one more key each
// (shared/replyStart.ts, OPENCODE_VIEW_KEYS). A value here replaces the builder's for
// that command rather than merging with it, so theirs is copied in first: from the
// inherited value, else cli.json, else OpenCode's default
// (packages/tui/src/config/keybind.ts, 2.0.32).
const VIEW_KEY_DEFAULTS: Record<OpencodeViewCommand, string> = {
  "session.last": "ctrl+alt+g,end",
  "session.message.previous": "none",
};

// A binding value with one more stroke: `false` and "none" have no keys, a string
// lists them comma-separated, an array lists them, a stroke or binding object is one.
function withStroke(value: unknown, stroke: object): unknown[] | null {
  if (value === false || value === "none") return [stroke];
  if (typeof value === "string") {
    return [...value.split(",").map((key) => key.trim()).filter(Boolean), stroke];
  }
  if (Array.isArray(value)) return [...value, stroke];
  if (isRecord(value)) return [value, stroke];
  return null;
}

function viewKeybinds(
  own: Record<string, unknown>,
  fromCliJson: () => Record<string, unknown>
): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  for (const [command, { stroke }] of Object.entries(OPENCODE_VIEW_KEYS)) {
    const name = command as OpencodeViewCommand;
    const theirs = name in own ? own[name] : (fromCliJson()[name] ?? VIEW_KEY_DEFAULTS[name]);
    // One OpenCode wouldn't accept either: the default, so the command keeps its keys.
    out[name] = withStroke(theirs, stroke) ?? withStroke(VIEW_KEY_DEFAULTS[name], stroke)!;
  }
  return out;
}

// The CLI config file OpenCode merges OPENCODE_CLI_CONFIG_CONTENT over:
// `$OPENCODE_CONFIG_DIR` (when set), else `<XDG_CONFIG_HOME or ~/.config>/opencode`,
// then `cli.json` (`packages/cli/src/index.ts`, `packages/util/src/global-roots.ts`).
// Read only, never written.
export function opencodeCliConfigPath(env: Record<string, string | undefined>): string {
  const dir =
    env.OPENCODE_CONFIG_DIR ||
    path.join(env.XDG_CONFIG_HOME || path.join(env.HOME || os.homedir(), ".config"), "opencode");
  return path.join(dir, "cli.json");
}

type PluginEntry = string | { package: string; options?: Record<string, unknown> };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// An entry as OpenCode resolves it: a `file://` URL as it is, a `./`, `../` or
// absolute path against the CLI config's own directory, anything else (an npm spec,
// `-id` to disable a plugin, `*`) untouched (`localSource` in
// `packages/plugin/src/source.ts`, called with `dirname(cli.json)` from
// `packages/tui/src/plugin/context.tsx`). Null for a shape OpenCode's schema rejects
// (`Plugin` in `packages/tui/src/config/index.tsx`).
function resolveEntry(entry: unknown, dir: string): PluginEntry | null {
  const resolve = (spec: string) =>
    !spec.startsWith("file://") && (spec.startsWith("./") || spec.startsWith("../") || path.isAbsolute(spec))
      ? path.resolve(dir, spec)
      : spec;
  if (typeof entry === "string") return resolve(entry);
  if (!isRecord(entry) || typeof entry.package !== "string") return null;
  if (entry.options !== undefined && !isRecord(entry.options)) return null;
  return { ...entry, package: resolve(entry.package) } as PluginEntry;
}

// A JSON object from JSONC text (comments and trailing commas, as OpenCode's
// jsonc-parser accepts), or null.
function parseObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(stripJsonc(text));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export interface CliConfigResult {
  // The value for OPENCODE_CLI_CONFIG_CONTENT.
  content: string;
  // Whether Multi-Code's plugin is in it. False when there was none to add, or when
  // the builder's own settings couldn't be read safely.
  plugin: boolean;
}

// OPENCODE_CLI_CONFIG_CONTENT for one TUI: Multi-Code's settings merged into the
// inherited value, if any, plus a `plugins` list that keeps the builder's own TUI
// plugins and adds Multi-Code's last.
//
// The list has to be copied in: OpenCode deep-merges this value over `cli.json`, but
// arrays replace (measured, spike G-601: env `plugins:[probe]` dropped a `cli.json`
// plugin, `[dummy, probe]` loaded both). An inherited value's own `plugins` already
// replaces the file's, so it is the one extended then. Plugins OpenCode discovers in
// `<config>/plugins/` and `<project>/.opencode/plugins/` load whatever this says.
//
// When `cli.json` exists but can't be read or doesn't have the shape OpenCode accepts,
// the list is not overridden and the plugin not added: the builder's TUI plugins keep
// loading as in any terminal, and the contact shows "plugin didn't load" (T-604's
// degraded state) instead. An inherited value that doesn't parse is left exactly as
// it was, settings and all, for the same reason: a value this can't read can't be
// rewritten without the risk of changing it. Never writes `cli.json`.
//
// A missing `cli.json` (a 1.x `tui.json` the TUI hasn't migrated yet included) has no
// plugins to keep; the TUI's own migration then writes one for the next start.
export function opencodeCliConfig(input: {
  inherited: string | undefined;
  cliJsonPath: string;
  // The plugin directory, when this spawn should load it.
  pluginDir?: string;
  readFile?: (file: string) => string;
}): CliConfigResult | null {
  const readFile = input.readFile ?? ((file: string) => fs.readFileSync(file, "utf8"));

  let config: Record<string, unknown> = {};
  if (input.inherited !== undefined && input.inherited.trim() !== "") {
    const parsed = parseObject(input.inherited);
    if (!parsed) return null;
    config = parsed;
  }
  // cli.json, read at most once: null when there is none, "bad" when there is one
  // that can't be read safely.
  let cliJson: Record<string, unknown> | null | "bad" | undefined;
  const readCliJson = () => {
    if (cliJson !== undefined) return cliJson;
    let text: string;
    try {
      text = readFile(input.cliJsonPath);
    } catch (err) {
      cliJson = (err as NodeJS.ErrnoException)?.code === "ENOENT" ? null : "bad";
      return cliJson;
    }
    cliJson = parseObject(text) ?? "bad";
    return cliJson;
  };
  const cliJsonKeybinds = () => {
    const file = readCliJson();
    return file && file !== "bad" && isRecord(file.keybinds) ? file.keybinds : {};
  };

  const own = isRecord(config.keybinds) ? config.keybinds : {};
  const merged: Record<string, unknown> = {
    ...config,
    keybinds: { ...own, ...TUI_SETTINGS.keybinds, ...viewKeybinds(own, cliJsonKeybinds) },
  };
  if (!input.pluginDir) return { content: JSON.stringify(merged), plugin: false };

  const without = { content: JSON.stringify(merged), plugin: false };
  const dir = path.dirname(input.cliJsonPath);
  let theirs: unknown[] = [];
  if (config.plugins !== undefined) {
    if (!Array.isArray(config.plugins)) return without;
    theirs = config.plugins;
  } else {
    const file = readCliJson();
    if (file === "bad") return without;
    if (file) {
      if (file.plugins !== undefined && !Array.isArray(file.plugins)) return without;
      theirs = (file.plugins as unknown[] | undefined) ?? [];
    }
  }

  const resolved: PluginEntry[] = [];
  for (const entry of theirs) {
    const next = resolveEntry(entry, dir);
    if (!next) return without;
    resolved.push(next);
  }
  // Only an entry identical to ours is dropped, so nothing of the builder's is
  // removed. A parent Multi-Code's (a dev build started from inside an OpenCode
  // contact inherits its env) has another path and stays; both copies then share the
  // plugin's globalThis state, and only the newest setup reports.
  const ours = path.resolve(input.pluginDir);
  const others = resolved.filter(
    (entry) => (typeof entry === "string" ? entry : entry.package) !== ours
  );
  return {
    content: JSON.stringify({ ...merged, plugins: [...others, { package: ours }] }),
    plugin: true,
  };
}
