# Skills and MCP, Milestone 1: completed work

**Date:** 2026-10-13
**Type:** completed-work record
**Branch:** `skills-mcp` (T-602..T-604 in `1c383e0`, T-605 in `c0fd69e`)
**QA:** `docs/specs/skills-mcp/test-plan.md#milestone-1-qa-pass-t-605`
**Outcome:** a "Skills and MCP" toolbox section shows what a Claude Code session started now
in an instance's cwd loads. Every M1 "Done when" line passed.

The task entries below are as they stood when M1 closed, moved here from
`docs/specs/skills-mcp/kanban.md` so the live task list holds only open work. Each "Done"
line records where the code deliberately differs from the task text, and what was measured.

## Review

- **Planned vs done:** T-602..T-605 as planned. Added during the work: a stopped instance
  can open this one section (PRD Story 1 edge case, `App.tsx`); a fifth group, Other.
- **Found by a two-round cross-model review (gpt-6.1-sol) before the commit:** a project's
  `"disableAllHooks": true` let the probe's prompt reach the API. Fixed with
  `disableAllHooks: false` in the probe's own settings and a model no provider has as a
  backstop. Nine smaller findings fixed; one rejected (MCP waits for `plugin list`).
- **Measured and worth keeping** (for PRD Technical Constraints): `--mcp-config` takes
  every argument up to the next flag; `--bare` drops MCP servers and most skills and
  ignores the hook; `CLAUDE_CONFIG_DIR` moves `.claude.json` too; a `--plugin-dir`
  plugin's MCP server does not appear in the init message.
- **Debt taken on deliberately:** none. `refresh.ts` returns null for OpenCode until M2.
- **Restructuring wanted:** none before M2. M2 adds OpenCode sources beside the Claude
  ones in `refresh.ts`, which its dependency injection already allows.

## Milestone 1 tasks: See what a Claude Code session loads

**Status:** done 2026-10-13 (T-605 QA passed, branch `skills-mcp`). M2 to M4 are to be re-planned now, as the overview says.

**Goal:** the builder opens "Skills and MCP" on a Claude Code instance and sees its MCP
servers, skills and plugins, this project apart from global, with overrides and duplicates
marked.

**Tasks:** T-602, T-603, T-604, T-605

**Done when:**
- In `multi-code`, the section shows `sentry` (`needs-auth`, `user`) under Global, omt 3.5.0 under This project, and seven duplicate pairs between the old project skills and `omt:` skills (digest, guide, kanban, prd, qa, teach, work)
- In `apra-amcos-admin-dolce`, the local-scope ralph-loop and ralph-wiggum plugins show as enabled under This project
- A manager instance shows its `--mcp-config` server under This session, marked "Multi-Code"
- Ten refreshes leave the number of `.jsonl` files in each project's `~/.claude/projects/` folder unchanged, spend no tokens, and raise no chime or red dot
- Nothing refreshes while the section stays open and nobody presses Refresh

---

### T-602: Claude probe and the Skills and MCP section

- **Type:** feature
- **Status:** done
- **Requirement:** `docs/specs/skills-mcp/prd.md#story-1-the-skills-and-mcp-section`, `docs/specs/skills-mcp/prd.md#story-4-a-claude-code-instance`
- **Knowledge:** `docs/specs/skills-mcp/prd.md#technical-constraints` ("How the probe stops the prompt", "No SSO browser", "No alerts from the probe")
- **Code:** new `workspace/app/src/main/skills-mcp/`; `workspace/app/src/main/backends/claude.ts` (`claudeCliCommand`); `workspace/app/src/main/secretary/cli.ts` (spawn, timeout and kill pattern); `workspace/app/src/main/process-manager.ts` (`managerSpawnOptions`); `workspace/app/src/main/ipc-handlers.ts`; `workspace/app/src/main/preload.ts`; `workspace/app/src/shared/types.ts`; `workspace/app/src/renderer/components/Toolbox.tsx`; new `workspace/app/src/renderer/components/SkillsMcpSection.tsx`
- **Description:** The first path through every layer. In main, `skills-mcp/claudeProbe.ts` exports `probeClaude(cwd, mcpConfigPath?)`. It spawns `claudeCliCommand()` in `cwd` with `-p --no-session-persistence --output-format stream-json --verbose --settings <PROBE_SETTINGS> [--mcp-config <path>] probe` and stdin closed. `PROBE_SETTINGS` is `{"awsAuthRefresh":"false","hooks":{"UserPromptSubmit":[{"hooks":[{"type":"command","command":"echo probe >&2; exit 2"}]}]}}`, the hook command measured on 2026-10-13. It reads stdout lines until `{"type":"system","subtype":"init"}`, then the `result` line, with a 30 s timeout and the SIGTERM-then-SIGKILL stop that `secretary/cli.ts` uses. A pure `parseInit(line)` returns `{ mcpServers: { name, status, source }[], plugins: { name, version, source, path }[], skills: string[], version }`. When the `result` line reports any input or output tokens, the refresh fails with "the probe reached the model": this guards against a CLI change that stops honouring the hook. `ProcessManager` gains `probeTargetOf(id): { cwd, backend, mcpConfigPath? }`, where only the manager has an `mcpConfigPath`. IPC: `refresh-skills-mcp` (instance id) starts a refresh and returns at once. A second call for the same instance while one runs joins it. Main pushes `skills-mcp-update` with `{ instanceId, refreshedAt, running, mcp, skills, plugins }`, where each part is `{ items, error? }`. Renderer: a "Skills and MCP" section (id `skills-mcp`) in the Toolbox accordion, after Quick Actions. It has three parts with counts, a Refresh button, "Refreshed <time>", a running state, per-part errors, and the Story 4 note line. It refreshes when it expands and when the instance changes while it is expanded, and never on a timer. In this task items are flat: name, scope label, status or version. An OpenCode instance shows "OpenCode comes in M2".
- **Acceptance:** Unit tests: `parseInit` on a fixture captured from the real 2.1.296 run (`__fixtures__/claude-init-2.1.296.json`); no init line → an error part; a `result` with tokens > 0 → error; a joined refresh spawns once; the args always contain `--no-session-persistence` and never the instance's `--settings`. A live test (skipped in CI) runs the probe in the repo: init parses, 0 tokens, and the `.jsonl` count in `~/.claude/projects/<encoded cwd>/` is unchanged. In the app on a `multi-code` instance: the counts match a hand-run probe (1 MCP, 7 plugins, 40 skills on 2026-10-13), in about 3 s.
- **Blocks:** T-603 · **Blocked by:** none · **Parallel with:** T-601, T-609
- **Notes:** Keep the env from `claudeCliCommand()`. It already strips `MULTICODE_INSTANCE_ID` and `MULTICODE_SPAWN_ID`, which keeps the probe away from `/alert`. Do not pass `--bare`: it skips plugins and would hide what the section exists to show (check this assumption in the live test).
- **Done 2026-10-13:** On branch `skills-mcp`. `workspace/app/src/main/skills-mcp/` holds `claudeProbe.ts` (`probeClaude`, `parseInit`, `reachedModel`), `refresh.ts` (the join logic, Electron-free) and `index.ts`. Two corrections to the description, both measured: `--mcp-config` takes every argument up to the next flag, so it goes before `--settings` (`--mcp-config <file> probe` failed with "MCP config file not found: <cwd>/probe"); and `--bare` dropped every MCP server and 24 of 40 skills and ignored the hook, so no result came. `refresh-skills-mcp` returns the snapshot as it stands rather than nothing, so a joined refresh still shows its running state. `App.tsx` now lets a stopped instance open this one section (PRD Story 1 edge case); every other section stays closed while stopped. The guard counts cache tokens and cost too, and fails closed when the counts are missing. In the app (dev build, isolated userData) on `multi-code`: 1 MCP (`sentry` `user` `connected`), 40 skills, 7 plugins in 4.0 s; the `.jsonl` count stayed 29. Live test: `MULTICODE_LIVE=1 npx vitest run src/main/skills-mcp/claudeProbe.live.test.ts`, 3.5 s. The accordion remembers its open section per instance, so selecting another instance refreshes only when that instance also has this section open. Cross-model review (gpt-6.1-sol, two rounds) found that a project or local `"disableAllHooks": true` skips the probe's hook and sends the prompt to the API (measured, then fixed): the probe's settings now set `disableAllHooks: false` (measured: it overrides both), it passes `--model multicode-probe-no-model` so a skipped hook gets a 400 with 0 tokens (init lists measured identical), and an error result fails the refresh. CLI stderr is masked by `clipReason` before it reaches the section.

### T-603: Claude plugins: install records, enable switches, overrides

- **Type:** feature
- **Status:** done
- **Requirement:** `docs/specs/skills-mcp/prd.md#story-3-overrides-and-duplicates`, `docs/specs/skills-mcp/prd.md#story-4-a-claude-code-instance`
- **Knowledge:** `docs/timeline/2026-10-12_skills-mcp-inventory-investigation.md` ("Override and the enable switch", "Scope of each kind")
- **Code:** `workspace/app/src/main/skills-mcp/` (new `claudePlugins.ts`); `workspace/app/src/renderer/components/SkillsMcpSection.tsx`
- **Description:** The Plugins part shows every install record and why each one loads or not. Run `claude plugin list --json` in the instance's cwd, in parallel with the probe. Keep rows with `scope: "user"`, or with a `projectPath` equal to the cwd (compare real paths). Read the enable switches from the `enabledPlugins` key only, in `~/.claude/settings.json`, `<cwd>/.claude/settings.json` and `<cwd>/.claude/settings.local.json`. Merge with the probe's `plugins`. The record whose version matches the loaded plugin is the winner. Each other record of the same id shows "overridden by <group>'s <version>", and the winner shows "overrides <scope> <version>". A record with no switch that applies shows "installed, not enabled". A switch with no record shows "enabled, not installed". `@builtin`, `@inline` and `@skills-dir` sources have no record and pass through as loaded.
- **Acceptance:** Unit tests from fixtures: the real `multi-code` list output; the `apra-amcos-admin-dolce` state before 2026-10-12 from the investigation table (omt 3.4.1 project and 3.5.0 user, switch in user only, 3.4.1 loaded → 3.5.0 shows overridden by this project's 3.4.1); a record without a switch; a switch without a record. In the app on `apra-amcos-admin-dolce`: ralph-loop and ralph-wiggum show `local` and enabled.
- **Blocks:** T-604 · **Blocked by:** T-602
- **Done 2026-10-13:** `workspace/app/src/main/skills-mcp/claudePlugins.ts` (`readPluginState`, `parsePluginList`, `readEnableSwitches`, `mergePlugins`); runs beside the probe in `refresh.ts`. A failed `plugin list` fails the Plugins part alone. Two cases the description did not cover, both shown rather than guessed: two records of the loaded version (the install path is keyed by version, so it cannot tell them apart) show "which of these records loaded is not stated by Claude Code"; a loaded marketplace plugin with no record here shows "no install record for this project". A record with a switch that is on but not loaded shows "enabled, not loaded". A global winner reads "overridden by global <version>". The row shows where the switch that applies sits, as in "enabled (local)". In the app (dev build, isolated userData): `multi-code` 8 rows, `apra-ai-ba` greyed "installed, not enabled"; `apra-amcos-admin-dolce` ralph-loop and ralph-wiggum `local`, "enabled (local)". After review: a `project` or `local` record without `projectPath` fails the parse; user settings follow `CLAUDE_CONFIG_DIR` (measured: it moves `.claude.json` too), relative to the cwd; a settings file that exists but cannot be read fails the part.

### T-604: Groups, skill scopes, MCP overrides and duplicates

- **Type:** feature
- **Status:** done
- **Requirement:** `docs/specs/skills-mcp/prd.md#story-2-global-and-this-project-apart`, `docs/specs/skills-mcp/prd.md#story-3-overrides-and-duplicates`
- **Knowledge:** `docs/specs/skills-mcp/prd.md#definitions`
- **Code:** `workspace/app/src/main/skills-mcp/`; `workspace/app/src/shared/types.ts`; `workspace/app/src/renderer/components/SkillsMcpSection.tsx`
- **Description:** Every item gets `group: "project" | "global" | "session" | "builtin"` beside its exact scope label, and the section lists the groups in that order with empty ones hidden. Skill scope: a `<plugin>:` prefix takes the plugin's scope from T-603; a folder `<cwd>/.claude/skills/<name>/` means `project`; `~/.claude/skills/<name>/` means `user`; anything else is built-in. When both folders exist for one name, show both copies with "not stated by Claude Code". An unprefixed skill `x` and a plugin skill `p:x` both carry a duplicate mark naming the other. MCP overrides: the probe's `source` names the winner's scope. Find other definitions of the same name by key only, in `~/.claude.json` (`mcpServers` for user, `projects[<cwd>].mcpServers` for local) and `<cwd>/.mcp.json` (project), and show them as overridden. The `--mcp-config` server sits under This session, marked "Multi-Code". Main never puts `env`, `headers` or any config value other than the name and scope into the IPC payload.
- **Acceptance:** Unit tests with temp folders and a fake home: each skill scope; two copies of one name; the duplicate pair; one MCP name at user and local scope with local winning per the probe; a test that the payload object has no `env` or `headers` key at any depth. In the app on `multi-code`: seven duplicate pairs (digest, guide, kanban, prd, qa, teach, work), `sentry` under Global.
- **Blocks:** T-605, T-606 · **Blocked by:** T-603
- **Done 2026-10-13:** `workspace/app/src/main/skills-mcp/claudeScopes.ts` (`readLocalConfig`, `mcpItems`, `skillItems`, `groupOf`, `pluginGroupOf`). Measured in a scratch project on 2.1.296: a `sentry` in `.mcp.json` beat the user `sentry` and the probe said `source: "project"`; a `--plugin-dir` plugin's MCP server, in its `.mcp.json` or its `plugin.json`, did not appear in the init message, so no source format is assumed for one. Added a fifth group, `other`, for what the section cannot place: an unknown `source`, or a plugin skill whose plugin's scope is unknown (Plugins failed, or the plugin is missing from it). A plugin skill whose plugin has two loaded records shows one row per record with "which copy loaded is not stated by Claude Code". A switch with no record sits in its settings file's group. Every `dynamic` server is marked Multi-Code, because the probe's only command-line config is the manager's. MCP overrides read "overrides user" / "overridden by local". Duplicates match on the name after the prefix, so two plugins' `x` are marked too. Counts count what loads, once per name (Plugins is 7 again in `multi-code`, not 8). In the app on `multi-code`: `sentry` under Global, the seven pairs marked, 21 skills under This project, 3 under Global, 16 Built-in. The manager line of M1 is left to T-605. After review: a skill folder counts only with a `SKILL.md`; the resolved cwd is looked up in `~/.claude.json` before the path as given; a config file that exists but cannot be read fails the MCP part. Rejected: showing MCP before `plugin list` answers (Skills and Plugins need both sources; a comment in `refresh.ts` says why).

### T-605: M1 QA pass

- **Type:** qa
- **Status:** done
- **Requirement:** `docs/specs/skills-mcp/prd.md#phase-1-see-what-an-agent-loads`
- **Code:** none
- **Description:** Run `qa` against M1's "Done when" on `multi-code`, `apra-amcos-admin-dolce`, `apra-amcos-admin-hrr` and a manager instance. Check each list against a hand-run probe and `claude plugin list --json` in the same cwd. Count `.jsonl` files before and after ten refreshes. Watch for a chime or red dot during refreshes. Write the plan to `docs/specs/skills-mcp/test-plan.md`.
- **Acceptance:** Every M1 "Done when" line passes, or fails with a bug task filed.
- **Blocks:** T-610 · **Blocked by:** T-604 · **Parallel with:** T-606
- **Done 2026-10-13:** Every M1 "Done when" line passes; no bugs filed. Plan and results: `docs/specs/skills-mcp/test-plan.md#milestone-1-qa-pass-t-605`. Each list matched a hand-run probe and `claude plugin list --json` in `multi-code`, `apra-amcos-admin-dolce` and `apra-amcos-admin-hrr`; the manager showed `multi-code dynamic connected Multi-Code` under This session; 40 refreshes left every `.jsonl` count unchanged with no error, chime or red dot; 120 s open and idle started no probe. `sentry` now reports `connected`, not the `needs-auth` the first line names.
