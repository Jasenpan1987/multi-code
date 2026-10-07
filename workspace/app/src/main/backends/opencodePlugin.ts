// Multi-Code's OpenCode plugin: the source written into userData, the events it
// forwards, and how an OpenCode spawn is told to load it.
//
// OpenCode's counterpart of the alert hooks every Claude instance runs
// (manager-mcp/config.ts): it posts what OpenCode reports about its own sessions to
// the same `/alert` endpoint, under the same headers, in a body parseAlertDelivery
// already reads. Loaded only by the OpenCode processes Multi-Code starts, because
// the only thing naming it is OPENCODE_CONFIG_CONTENT in that process's env; plain
// `opencode` in a terminal never sees it (PRD Story 7).
//
// Behaviour measured on OpenCode 1.18.35 with this seam (T-409,
// docs/timeline/2026-10-06_attention-alerts-investigation.md, "OpenCode plugin
// spike"): one init per process, the instance env visible, a broken sibling plugin
// harmless, `--pure` loading no plugin at all.

import { ALERT_FILE_ENV, INSTANCE_ENV, SPAWN_ENV } from "./instance-env";

// The plugin's file name in `<userData>/opencode/`.
export const OPENCODE_PLUGIN_FILE = "multicode-plugin.js";

// The one delivery the plugin makes by itself, from its init, so an instance whose
// plugin loaded can be told from one whose plugin never ran (PRD Story 6).
export const OPENCODE_INIT_EVENT = "multicode.init";

// The OpenCode events the plugin forwards: the ones attention logic acts on (T-411),
// under both their current names and the v2 ones OpenCode is moving to (both are in
// the 1.18.35 binary). An allowlist, not a denylist: OpenCode publishes an event per
// streamed token, and a new noisy event in some later version must not become a POST
// per token from inside the user's agent.
//
// `session.created`/`session.updated` are here for `info.parentID`, the only place a
// child (subagent) session is marked. `session.idle` is not: it duplicates
// `session.status {type:"idle"}`, which is what Finished keys on.
export const OPENCODE_PLUGIN_EVENTS = [
  "session.status",
  "session.created",
  "session.updated",
  "session.error",
  "permission.asked",
  "permission.replied",
  "permission.v2.asked",
  "permission.v2.replied",
  "question.asked",
  "question.replied",
  "question.rejected",
  "question.v2.asked",
  "question.v2.replied",
  "question.v2.rejected",
] as const;

// Bounds on what the plugin queues and how long one post may take. Posts are
// localhost and answered with a 204 before Multi-Code does anything, so these only
// matter when Multi-Code is wedged: the queue drops instead of growing, and a hung
// post stops holding up the next one after 2s.
const MAX_QUEUED = 200;
const POST_TIMEOUT_MS = 2000;

// The plugin's source. Plain JS, imports only `fs`, because OpenCode runs it in a
// Bun worker inside the user's TUI and nothing here may need installing or depend
// on Bun. Rules it keeps, each because it runs inside someone else's agent:
//   - Exactly one export, the plugin function: OpenCode calls every export as one.
//   - Inert unless Multi-Code started this process: no instance id, no reports.
//   - Init does one small file read and returns. It blocks OpenCode's bootstrap.
//   - The event hook never awaits the network: posts go on a FIFO and the hook
//     returns at once. Every error is swallowed; nothing goes to stdout, which is
//     the TUI's screen.
//   - The token comes from the 0600 file the env names, never from the env itself.
//
// After reading its ids it deletes them from `process.env`. The agent's bash tool
// inherits this env, so an `opencode` the agent runs would otherwise load this
// plugin with the same ids and report its sessions as this instance's. The ids are
// kept on globalThis for a later init in the same process.
//
// The newest init wins. A second init in one process would otherwise report every
// event twice, and OpenCode drops a plugin's old hooks when it re-initialises, so
// the old copy must not be the one left talking. `opencode run` initialises twice
// (measured 2026-10-07). Every init posts through the one FIFO on globalThis, so
// what the old copy had queued still goes out before anything the new one sends.
export function opencodePluginSource(): string {
  return `// Multi-Code's OpenCode plugin. Written by Multi-Code into its own data folder on
// every start and loaded only by the OpenCode instances it launches. Report-only:
// forwards session, permission and question events to Multi-Code, changes nothing.
import fs from "fs";

const EVENTS = new Set(${JSON.stringify(OPENCODE_PLUGIN_EVENTS)});

export const MulticodeAlerts = async () => {
  try {
    const state = (globalThis.__multicodeAlerts ??= {
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
    if (!state.instance || !state.spawn || !state.file) return {};

    const target = JSON.parse(fs.readFileSync(state.file, "utf8"));
    if (typeof target?.endpoint !== "string" || typeof target?.token !== "string") return {};
    const headers = {
      "Authorization": "Bearer " + target.token,
      "Content-Type": "application/json",
      "X-Multicode-Instance": state.instance,
      "X-Multicode-Spawn": state.spawn,
    };

    const generation = ++state.generation;
    const post = (body) => {
      if (generation !== state.generation || state.queued >= ${MAX_QUEUED}) return;
      const payload = JSON.stringify(body);
      state.queued++;
      state.queue = state.queue
        .then(() => fetch(target.endpoint, {
          method: "POST",
          headers,
          body: payload,
          signal: AbortSignal.timeout(${POST_TIMEOUT_MS}),
        }))
        .then((res) => res.body?.cancel())
        .catch(() => {})
        .finally(() => { state.queued--; });
    };

    post({ hook_event_name: ${JSON.stringify(OPENCODE_INIT_EVENT)}, pid: process.pid });
    return {
      event: async ({ event }) => {
        try {
          if (!EVENTS.has(event?.type)) return;
          const properties = event.properties ?? {};
          post({
            hook_event_name: event.type,
            session_id: properties.sessionID ?? properties.info?.id,
            pid: process.pid,
            properties,
          });
        } catch {}
      },
    };
  } catch {
    return {};
  }
};
`;
}

// The OPENCODE_CONFIG_CONTENT an instance spawns with: the inherited value, if any,
// with Multi-Code's plugin added to its `plugin` list. OpenCode deep-merges this
// value over the user's config files and unions `plugin` across sources, so one
// added entry leaves the rest of their config in force, their own plugins included.
//
// Only an entry identical to ours is dropped, so nothing of the user's is ever
// removed. A parent Multi-Code's entry (a dev build launched from inside an OpenCode
// session inherits that env) can't be told from a user's plugin by its path, and is
// left in: both copies then load in one process, share the plugin's globalThis
// state, and only the newest init reports.
//
// Null when the inherited value isn't a JSON object whose `plugin` is a list or
// absent. Rewriting a value this can't read could change the user's config, so the
// caller spawns with it untouched and without the plugin instead.
export function withMulticodePlugin(
  inherited: string | undefined,
  pluginUrl: string
): string | null {
  let config: Record<string, unknown> = {};
  if (inherited !== undefined && inherited.trim() !== "") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(inherited);
    } catch {
      return null;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    config = parsed as Record<string, unknown>;
  }
  const existing = config.plugin ?? [];
  if (!Array.isArray(existing)) return null;
  const others = existing.filter((entry) => entry !== pluginUrl);
  return JSON.stringify({ ...config, plugin: [...others, pluginUrl] });
}
