# 2026-10-16 — Backend expansion research: OpenCode 2 and Pi

Research only; no code changed. Two questions from the builder: what moving to OpenCode 2 costs (and whether 1.x and 2.x could both be supported), and what adding Pi as a third backend costs. Outcome: OpenCode moves to 2.x only, run the way OpenCode's VS Code extension runs it (docs/knowledge/decisions.md, both 2026-10-16 entries); Pi goes to the backlog with DeepSeek Harness and Codex (docs/knowledge/business-overview.md, "Backend roadmap"). The two hazards below were found while `--standalone` plus a ported plugin was still the plan; the chosen design avoids the first by putting nothing into the server.

Sources: OpenCode cloned at tags `v1.19.0` and `v2.0.29` (`git clone --depth 1 --branch <tag> https://github.com/anomalyco/opencode.git`); Pi cloned at `eddebae` (`https://github.com/earendil-works/pi`, v1.2.0). Neither CLI was run. Paths below are inside those clones.

## OpenCode 2: where it comes from

- V1 is npm `opencode-ai` (last: 1.19.0, 2026-10-11, whose notes add `opencode upgrade --major` and `/update`). V2 is npm `@opencode/cli` (2.0.0 on 2026-09-11, 2.0.29 on 2026-10-14). The tags live in the same repo; V2 has no GitHub Releases.
- `curl -fsSL https://opencode.ai/v2/install | bash` installs to `~/.opencode/bin/opencode`, replacing V1. The two cannot be installed side by side (`services/www/src/docs/content/migrate-v1.mdx`).
- The builder's machine had 1.18.35 on this date, and its 7.6 GB `~/.local/share/opencode/opencode.db` had no V2 tables.
- To try V2 without touching the V1 install: install with `npm install --prefix <scratch> @opencode/cli` and point `XDG_DATA_HOME`, `XDG_CONFIG_HOME` and `OPENCODE_DB` at scratch paths (`packages/util/src/global-roots.ts`, `packages/cli/src/database-path.ts`).

## OpenCode 2: what changes for Multi-Code

| Surface | V1 (what Multi-Code uses today) | V2 | Evidence |
|---|---|---|---|
| Process model | The TUI process runs the agent | One shared background server per user owns sessions, config, permissions and tool execution; TUIs are clients. `--standalone` gives a TUI a private server child | `cli/index.mdx` "Background service"; `packages/cli/src/services/standalone.ts` |
| Plugin | Named export function returning `{ event }` | `export default { id, setup(ctx) }`; events from `ctx.event.subscribe()`. "V1 plugin implementations do not run in V2" | `build/plugins/migrate-v1.mdx`; `packages/plugin/src/promise/plugin.ts` |
| Plugin config | `plugin: [url]` in `OPENCODE_CONFIG_CONTENT` | Still read; V2 key is `plugins`, V1 `plugin` is normalized | `packages/cli/src/server-process.ts` (`content: process.env.OPENCODE_CONFIG_CONTENT`); `packages/core/src/v1/config/plugin.ts` |
| Permission event | `permission.asked {permission, patterns, always, metadata}` | `permission.asked {id, sessionID, action, resources, save, metadata, source, message}`; `permission.replied {requestID, reply}` unchanged | `packages/schema/src/permission.ts` |
| Question event | `question.asked/replied/rejected` | `form.created {form}`, `form.replied`, `form.cancelled`; the question tool asks through a form with `metadata.kind: "question"`, fields `q0..qN` | `packages/schema/src/form.ts`; `packages/core/src/tool/plugin/question.ts` |
| Turn end | `session.status idle`; abort seen as `session.error MessageAbortedError` | `session.status` unchanged; also `session.execution.succeeded/failed/interrupted {reason: user\|shutdown\|superseded\|inactivity}` | `packages/schema/src/session-status-event.ts`, `session-event.ts` |
| Subagent marking | `info.parentID` on `session.created/updated` | `parentID` at the top level of `session.created` | `packages/schema/src/session-event.ts` |
| Database | `session`, `message`, `part` | `session_v2`, `session_message` (typed rows: `user`, `synthetic`, `assistant` with `content[]`, `idle`, …). Same `opencode.db`; on first start V2 copies V1 sessions into the new tables and leaves the V1 tables in place | `packages/core/src/session/sql.ts`; `packages/schema/src/session-message.ts`; `packages/core/src/database/v1-migration.bun.ts` |
| Tool names | `bash`, `task`, input `filePath` | `shell`, `subagent`, input `path` | `packages/core/src/tool/plugin/*.ts`; `migrate-v1.mdx` "Permissions and tools" |
| Token usage | `data.tokens {input, cache{read,write}}` | `tokens {input, output, reasoning, cache{read,write}}` on assistant messages, model as `{id, providerID, variant}` | `packages/schema/src/token-usage.ts` |
| CLI flags | `--continue`, `--session <id>`, `opencode tui --session <id>` | `--continue`, `--session <id>` ("continue, or create if it does not exist"), `--standalone`, `--server <url>`, `--auto`; no `tui` subcommand | `packages/cli/src/commands/commands.ts` |
| Permission dialog | Allow once / Allow always / Reject, always three; Allow always opens a confirm screen | Allow always shown only when `save` is non-empty; no confirm screen; Reject in a subagent session opens a reason step | `packages/tui/src/routes/session/permission.tsx` |
| Slash commands | `/rename` opens a dialog | `/rename <name>` takes the name inline, or opens a dialog without one; `/clear`, `/new`, `/compact` exist | `packages/tui/src/routes/session/index.tsx` |

### Hazard: the shared service inherits the environment of whoever starts it

The shared service is spawned detached with `{ ...process.env, ...env }` (`packages/client/src/service-contender.ts`). If a TUI that Multi-Code started is the one to start it, Multi-Code's `OPENCODE_CONFIG_CONTENT`, plugin and instance ids live on in a service that every later OpenCode client uses, including plain `opencode` in a terminal. That breaks the zero-residue principle. Multi-Code must not start V2 TUIs in the default mode with its plugin in their env.

### Hazard: an interrupted turn resumes later in the shared service

Execution writes a claim (`session_v2.time_suspended`) when a turn starts. Success, failure and user interruption release it; graceful shutdown and process death keep it. The managed shared service resumes every top-level session that still holds a claim when it boots, with the instruction "The server restarted while you were working…" (`packages/core/src/session/execution/restart.ts`; `packages/server/src/process.ts` `installRestartContinuity`, run only when service lifecycle options are set). Standalone servers never sweep. So a Multi-Code instance stopped mid-turn under `--standalone` leaves a claim that the next shared-service boot picks up and runs with no TUI attached.

## OpenCode 2: process, session and tab model

The builder's first picture was "each `opencode` started in a directory is its own server, holding several sessions shown as tabs". The source says otherwise:

- **One server per user, for every project.** By default each `opencode` finds or starts one shared background service (per release channel), registered in `~/.local/state/opencode/service.json` (`{id, version, url, pid, password}`, 0600) on `127.0.0.1:49374` with HTTP Basic auth (`opencode:<password>`). It is detached, outlives every TUI, has no idle shutdown, and runs with its home directory as cwd; a session's directory is its "location". A client of another version replaces the service, interrupting its turns. (`packages/cli/src/services/service-config.ts`, `service-registration.ts`, `packages/client/src/effect/service.ts`, `packages/server/src/auth.ts`)
- **Two TUIs in one directory are two clients of the same server.** They see the same sessions and, by default, the same tabs. Nothing stops both from driving one session; on a dialog, the first reply wins.
- **A tab is one root session** (subagents fold into it). Sessions in several tabs run at the same time on the server. Tabs persist in `<state>/<channel>/tui/tabs.json`, keyed by the TUI's exact cwd and live-reloaded across processes, so two TUIs in one directory open and close each other's tabs. A dialog renders only for the selected tab; a background tab shows `!` or `?` and writes nothing to the PTY. `/new`, `/sessions`, `/open` and `/cd` move a TUI between sessions and directories. (`packages/tui/src/context/session-tabs.tsx`, `session-tabs-model.ts`, `routes/session/index.tsx`)
- **Tabs can be switched off per process** without touching the user's `cli.json`: `OPENCODE_CLI_CONFIG_CONTENT='{"tabs":{"mode":"off"}}'` (`packages/cli/src/config/config.ts:32`; docs `cli/config.mdx`). `/new` and `/sessions` still work.
- **Terminal facts for an xterm.js host:** alternate screen, mouse capture on by default, kitty keyboard protocol when offered (xterm.js 5.5 does not offer it, so Ctrl+Tab and Ctrl+1..0 likely arrive indistinguishable), OSC 0 title `OC | <title>` with no session id, no BEL, OS notifications off by default. Ctrl+Z sends SIGTSTP and probably freezes under node-pty; bind `terminal.suspend` to `none`.
- **Event stream:** `GET /api/event` (SSE), global across locations with no server-side filter, first frame `server.connected`, heartbeat every 15 s, no replay. After a reconnect a client re-fetches `GET /api/session/active` and each session's pending permissions and forms. `session.status` is declared but nothing in core, server or CLI publishes it; running and idle come from `session.execution.*`. Dialogs can be answered with `POST /api/session/:id/permission/:requestID/reply {decision}` and `POST /api/session/:id/form/:formID/reply {answer}`. (`packages/protocol/src/groups/*.ts`; `V2_HTTP_API_AUDIT.md` marks these Keep or Change; the OpenAPI document still says version 0.0.1, "Experimental".)
- **An external process can run its own server:** `opencode serve --port <p>` with `OPENCODE_PASSWORD` set, and TUIs attach with `opencode --server <url>`. Such a server does not sweep claims. In `--server` mode the TUI does not push its environment to sessions, so tools run with the server's environment.
- **Inactivity:** a location with no session events for 60 minutes is evicted, and its running turns are interrupted with reason `inactivity` (`packages/core/src/location-activity.ts`). A turn waiting on an unanswered permission emits no session events, so it can be interrupted after an hour.

## Pi

Read from source at v1.2.0 (MIT, 1.0 shipped 2026-10-01). The builder's installed copy is 0.84.2 under nvm (`~/.nvm/versions/node/v26.5.0/bin/pi`); the features below need 0.99 or later.

- **Spawn:** `--session-id <id>` opens that session or creates it under that id; `-c` continues the latest. The binary is a Node script, so Node ≥ 22.19 must be on the spawn PATH. `PI_CODING_AGENT_DIR` relocates its data for isolated tests.
- **Report-only injection:** `-e <path>` loads an extension named only in argv; no config is touched. Events include `agent_settled {aborted}` (an exact Finished), `tool_execution_start/end`, `session_start {reason}`, `ui_prompt_start/end {kind, title}`. The extension runtime is rebuilt on every `/new`, `/resume`, `/fork` and `/reload`, so its state must live on `globalThis`, as Multi-Code's OpenCode plugin already does.
- **Dialogs:** Pi has no built-in permission prompts and no question tool; every dialog comes from an extension. Needs-you can be detected through `ui_prompt_*`, but the event carries no options, so a phone can answer only a Yes/No confirm until Pi adds the options (about a three-line change at `src/core/extensions/runner.ts:579`).
- **Sessions:** JSONL under `~/.pi/agent/sessions/--<cwd>--/<ts>_<id>.jsonl`, entries form a tree (`/tree` branches in one file). Per-turn `usage {input, output, cacheRead, cacheWrite}`. The context window is not in the file; the extension can report `ctx.getContextUsage().contextWindow`.
- **Manager:** built-in MCP since 0.99, tool names `mcp__<server>__<tool>` as in Claude, nothing to pre-approve. The builder's pi-mcp-adapter extension replaces built-in MCP; a manager spawn would use `-ne` plus explicit `-e`.
- **Churn:** 79 releases between 2026-04-16 and 2026-10-12, nine with breaking changes since July.
- **Doesn't map:** answering built-in permission dialogs, a built-in question tool, plan approval, built-in subagents, a per-pid session registry.

Estimate at this project's pace: about 5–7 days for a full backend (basic backend 2–3, alerts 1–1.5, phone answers 0.5–1, manager 1–1.5).
