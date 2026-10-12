# PRD: Skills and MCP

**Version:** 1.2
**Last Updated:** 2026-10-13
**Status:** draft
**Owner:** Jasen

## Overview

A toolbox section named "Skills and MCP" shows what the selected instance's agent loads:
its MCP servers, its skills and its plugins. It shows what comes from this project apart
from what is global, and which copy wins when one name is set in two places, for example
"global omt 3.5.0, overridden by this project's 3.4.1". It covers Claude Code and OpenCode
instances.

Phase 2 adds an install. The builder picks a plugin, skill, MCP server or marketplace,
chooses where in this project it goes, reads a preview of every command and file, and
clicks Install. One install writes for Claude Code and OpenCode together.

(source: docs/timeline/2026-10-12_skills-mcp-inventory-investigation.md; builder,
2026-10-12, in session)

## Background & Context

- **What an agent loads is invisible without a terminal.** On 2026-10-12, finding which
  omt version five projects loaded took a probe in each one. Two projects had lost omt
  when the user-scope plugin was removed, and nothing showed it. (source: investigation,
  "Override and the enable switch")
- **Claude Code states it at start.** The `system/init` message of
  `claude -p --output-format stream-json --verbose` lists MCP servers with status and
  scope, plugins with version, and skill names. `claude plugin list --json` lists every
  install record with its scope. (source: investigation, "Claude Code")
- **OpenCode picks among same-name skills at random on every start.** Only the running
  instance knows which copy it has. Multi-Code's OpenCode plugin
  (`workspace/app/src/main/backends/opencodePlugin.ts`) already runs inside every instance
  and reports to Multi-Code. (source: investigation, "OpenCode")
- **OMT is installed per project, never globally.** Since 2026-10-12, omt 3.5.0 is
  installed at project scope in five projects and the user-scope plugin is gone. One
  project install wrote a new `.claude/` folder into its repository. (source:
  investigation; builder, 2026-10-12)
- **Install writes project config.** Until now Multi-Code wrote no agent config. Since
  2026-10-12 it may, on an explicit Install only. (source: docs/knowledge/decisions.md,
  2026-10-12)

## Users & Stakeholders

| Role | Who | How they interact |
|------|-----|-------------------|
| Builder | Jasen | Runs several Claude Code and OpenCode instances on different projects. Opens the section to check what one loads, and installs into a project from it. |

## Definitions

- **Kind:** MCP server, skill or plugin. Hooks are not a kind here.
- **Backend:** Claude Code or OpenCode.
- **Scope:** where an item is set. Claude Code names `local` (private to the builder in
  this project), `project` (shared through git), `user` (all projects), `dynamic` (a
  command-line flag, such as the manager's `--mcp-config`), `managed`, `claude.ai`, a
  plugin, and built-in. OpenCode has the global config, the project config, the config
  Multi-Code injects at spawn (`OPENCODE_CONFIG_CONTENT`), and built-in.
- **Group:** the section puts each scope in one of four groups.
  - This project: `local`, `project`, OpenCode's project config.
  - Global: `user`, `managed`, `claude.ai`, OpenCode's global config.
  - This session: flags and config Multi-Code passes at spawn.
  - Built-in: what ships with the CLI.
- **Install record and enable switch:** a Claude plugin loads only when it has both. The
  record says which version, at which scope. The switch is
  `enabledPlugins: { "<id>": true }` in a settings file that applies. The two can sit at
  different scopes. (source: investigation, "Override and the enable switch")
- **Winner and overridden:** when one name is set at several scopes, the winner is the one
  the agent loaded. Each other one is overridden.
- **Duplicate:** two items load under related names (a project skill `digest` and the
  plugin skill `omt:digest`), or one name has several copies and the agent picks one.
- **Probe:** a short `claude -p` run that Multi-Code starts to read the init message. A
  prompt-blocking hook in the probe's own `--settings` stops the prompt, so nothing
  reaches the model.
- **Install source:** where the builder picks an item to install from (Story 6).

## User Stories

## Phase 1: See what an agent loads

### Story 1: The Skills and MCP section

**As the** builder
**I want to** see what the selected instance loads in a toolbox section
**So that** I can check it without a terminal

**Acceptance Criteria:**
- [ ] The toolbox has a section titled "Skills and MCP", in the same accordion as Git,
  Quick Actions and Terminal. (source: builder, 2026-10-12)
- [ ] The section has three parts: MCP, Skills, Plugins. Each part shows its count.
- [ ] Expanding the section starts a refresh for the selected instance. A Refresh button
  starts one too. Switching to another instance while the section is expanded starts a
  refresh for that instance.
- [ ] Nothing else starts a refresh. There are no live updates. (source: builder,
  2026-10-12)
- [ ] A second refresh for an instance does not start while one is running for it.
- [ ] While a refresh runs, the section says so. Each part fills in when its own source
  answers. The rest of the app keeps working.
- [ ] The section shows the time of the last finished refresh.
- [ ] When a source fails, its part shows the source's error text. The other parts still
  show.
- [ ] The section never shows the value of an environment variable or a header. It shows
  names only.

**Edge cases:**
- A stopped Claude instance: the probe does not need the instance, so the section works.
- A stopped OpenCode instance: see Story 5.

---

### Story 2: Global and this project, apart

**As the** builder
**I want to** see what this project adds apart from what is global
**So that** I know what a teammate who clones the repository gets, and what is only mine

**Acceptance Criteria:**
- [ ] In each part, items sit under the groups This project, Global, This session and
  Built-in, in this order. An empty group is hidden.
- [ ] Each item shows its exact scope label (`local`, `project`, `user`, `dynamic`, …)
  inside its group.
- [ ] A plugin's skills and MCP servers sit in the plugin's group and carry the plugin's
  name, as in `omt:digest`.
- [ ] An item that Multi-Code adds at spawn sits under This session, marked "Multi-Code".
  Examples: the manager's `--mcp-config` server, Multi-Code's OpenCode plugin.
- [ ] The section never shows anything the probe itself adds.

---

### Story 3: Overrides and duplicates

**As the** builder
**I want to** see which copy wins when one name is set in two places
**So that** I know which version actually runs

**Acceptance Criteria:**
- [ ] When one name is set at several scopes, the winner sits in its group with
  "overrides <scope> <version>". Each other copy sits greyed in its own group with
  "overridden by <group>'s <version>". Example: "omt 3.5.0 `user`, overridden by this
  project's 3.4.1". (source: builder, 2026-10-12)
- [ ] The winner is always the copy the agent reports it loaded. Multi-Code never works out
  precedence by its own rules.
- [ ] When the agent does not state which copy it loaded, the section says "not stated by
  <backend>" and shows every copy. It does not guess.
- [ ] A plugin with an install record but no enable switch that applies shows "installed,
  not enabled". A plugin with the switch but no record shows "enabled, not installed".
- [ ] Two items that load under related names (project `digest`, plugin `omt:digest`) both
  carry a duplicate mark that names the other one.
- [ ] In OpenCode, a skill name with several copies shows the copy the running instance
  loaded, then the other copies. A note says OpenCode picks one at random on each start.

---

### Story 4: A Claude Code instance

**As the** builder
**I want to** see what a Claude Code session in this project loads, exactly
**So that** I can trust the list

**Acceptance Criteria:**
- [ ] The section reads MCP servers, plugins and skill names from a probe in the
  instance's cwd. The probe gets the same `--mcp-config` the instance was spawned with. It
  leaves out the instance's `--settings`: Multi-Code's settings files carry only hooks,
  and hooks are not shown here (`workspace/app/src/main/manager-mcp/config.ts`).
- [ ] A note under the section title says the list is what a Claude Code session started
  now in this project loads. A running session loaded its own list when it started.
- [ ] The probe sends nothing to the model and costs no tokens.
- [ ] The probe leaves no session file. After a refresh, the instance's next `--continue`
  resumes the same session as before. (see Technical Constraints, measured 2026-10-12)
- [ ] The probe raises no chime, red dot or alert. It carries no Multi-Code alert hooks
  and no instance id.
- [ ] MCP: each server shows its name, its status as the CLI states it (for example
  `connected`, `needs-auth`, `failed`, pending approval), and its scope.
- [ ] Plugins: each shows id, version, scope and whether it is enabled. Every install
  record for this project from `claude plugin list --json` shows, run in the instance's
  cwd, so overridden records show too.
- [ ] Skills: each shows its name and scope. The scope follows from the name and the
  file's place:
  - a `<plugin>:` prefix: that plugin, at the plugin's scope;
  - a folder under `<cwd>/.claude/skills/`: `project`;
  - a folder under `~/.claude/skills/`: `user`;
  - anything else: built-in.

(source: investigation, "The init message", "Scope of each kind")

---

### Story 5: An OpenCode instance

**As the** builder
**I want to** see what an OpenCode instance loaded, including which copy of a duplicate
skill it picked
**So that** I can trust the list for OpenCode too

**Acceptance Criteria:**
- [ ] Skills: the list the running instance loaded, reported by Multi-Code's OpenCode
  plugin when the instance starts. Each skill shows its name and scope (from the file's
  location), and its other copies (Story 3). (source: builder, 2026-10-12, route 1)
- [ ] An instance that sent no report (stopped, or started before this feature) shows
  "restart this instance to see its skills" in the Skills part.
- [ ] MCP: each server from `opencode mcp list`, run in the instance's cwd on each
  refresh. Each shows its name, status, and scope (global or project config).
- [ ] Plugins: each `plugin` entry in the resolved config, with its scope. Multi-Code's
  own plugin sits under This session, marked "Multi-Code".
- [ ] The plugin stays report-only. It changes no OpenCode behaviour and blocks nothing.
  (source: CLAUDE.md, Architecture)

---

## Phase 2: Install into a project

### Story 6: Pick what to install

**As the** builder
**I want to** pick an item from the places I already use, or add a new one
**So that** I don't copy config between projects by hand

**Acceptance Criteria:**
- [ ] The Skills and MCP section has an Install button. The target project is the selected
  instance's cwd.
- [ ] Four install sources (source: builder, 2026-10-12):
  - **Known marketplaces:** the plugins of each marketplace Claude already knows
    (`claude plugin marketplace list --json`), with name, version and description.
  - **This machine:** each MCP server and skill set globally, or in another project in
    Multi-Code's instance list, with where it comes from.
  - **New marketplace:** the builder enters a GitHub repository, URL or path. Multi-Code
    adds it with `claude plugin marketplace add <source> --scope <scope>` (after the
    Story 8 preview), then its plugins show for picking.
  - **New MCP server:** a form with name, transport (`stdio`, `http`, `sse`), command and
    arguments or URL, and the names of its environment variables and headers. It takes
    no values (Story 8, "Secrets").
- [ ] An item that already loads in this project at the same version shows "already
  installed" and cannot be picked.

---

### Story 7: Choose where it goes

**As the** builder
**I want to** choose the scope and the backends every time
**So that** nothing lands somewhere I did not mean

**Acceptance Criteria:**
- [ ] Every install asks for the scope. There is no default and no remembered choice. The
  two choices are "This project, shared through git" (Claude `project`) and "This project,
  private to me" (Claude `local`). (source: investigation, "Traps for an install feature")
- [ ] Global scope is not offered. (source: builder, 2026-10-12: install into a project;
  OMT per project)
- [ ] Every install asks for the backends: Claude Code, OpenCode, or both. Both start
  checked. (source: builder: "for Claude Code and OpenCode in one go")
- [ ] When a backend cannot take the item, or cannot take it at the chosen scope, it is
  unchecked and shows why. Examples: OpenCode takes only the skills of a Claude plugin; a
  marketplace is Claude-only; OpenCode may have no private project config (Open
  Question 3).

---

### Story 8: Preview and checks before writing

**As the** builder
**I want to** read every command and file change before anything runs
**So that** an install never surprises me

**Acceptance Criteria:**
- [ ] Before anything runs, a preview lists, for each backend, each exact command and each
  file it creates or changes, with the lines it adds.
- [ ] Each file is marked "shared through git" or "private" (ignored by git, or outside the
  repository).
- [ ] Commands are the official CLI commands where one runs without prompts
  (`claude plugin marketplace add`, `claude plugin install`, `claude mcp add`). Where none
  exists, the file layout the vendor documents is used, and the preview says so.
- [ ] Duplicate check: when the name already exists in this project at any scope, the
  preview names the existing item and says which copy will win. For an OpenCode skill it
  says the pick will be random.
- [ ] Secrets: Multi-Code never asks for, stores or writes an environment variable value
  or a header value. Each one is written as an environment-variable reference, and the
  preview names each variable the builder will have to set (Story 9). (source: builder,
  2026-10-13, G-001)
- [ ] A plugin install shows where the install record and the enable switch go. When the
  two would not both apply to this project, Install is disabled and the preview says why.
- [ ] A Claude MCP server at `project` scope: the preview says Claude asks the builder to
  approve it on first use.
- [ ] A shared OpenCode entry never holds an absolute path on this Mac. When it would, the
  OpenCode backend is unchecked and the preview says why. (Open Question 2)
- [ ] Nothing is written before the builder clicks Install. Cancel writes nothing.

(source: investigation, "Traps for an install feature")

---

### Story 9: Install and confirm it loads

**As the** builder
**I want to** see that the item loads after the install
**So that** I don't find out in my next session that it didn't

**Acceptance Criteria:**
- [ ] Install runs the previewed commands and writes the previewed files, in order, and
  nothing else.
- [ ] The section shows each command's output. When one fails, the install stops, shows
  the error, and lists the steps already done. Nothing is undone without the builder.
- [ ] After the install, the section refreshes. Each installed item shows whether it now
  loads. For a plugin that does not load, it says which part is missing: the record or the
  switch.
- [ ] Each running instance in this project needs a restart to load the new items. The
  section says so and names those instances. It restarts nothing itself.
- [ ] For each variable an MCP server references that is not set where the agent reads it,
  the section shows a reminder until it is set. The reminder names the server and the
  variable, gives the absolute path of the file to put it in and the exact line to add,
  and names the instance to restart. It has a button that copies `cd <absolute folder>`
  and one that copies the line. (source: builder, 2026-10-13, G-001; the file is Open
  Question 6)
- [ ] The reminder checks the variable itself, not the server's status. An unset `${VAR}`
  reaches a Claude server as the literal text `${VAR}`, and a server that only checks for
  a non-empty key then shows `connected`. (source:
  docs/timeline/2026-10-13_mcp-env-vars-experiment.md)
- [ ] A server that logs in instead of taking a key (status `needs-auth`) gets a reminder
  to type `/mcp` in the session and log in. (source: builder, 2026-10-13)

---

## Non-Functional Requirements

- **Accuracy over speed.** A wrong list is worse than a slow one. (source: builder,
  2026-10-12: "must be accurate")
- **Refresh time.** Measured on the builder's Mac in `multi-code`: Claude probe 3.0 s with
  the blocking hook (2026-10-13; 5.0 to 8.1 s with the earlier drop mod),
  `claude plugin list --json` 0.17 s, `opencode mcp list` 4.9 s (2026-10-12). Sources run
  in parallel, and each part fills in when its own source answers.
- **No model calls.** A refresh and an install spend no tokens.
- **Secrets.** Environment variable values, header values and bearer tokens are never
  logged, never sent to the renderer, and never sent to the phone link.
- **Main process.** Probes and CLI calls run in the main process and never block the UI.

## Technical Constraints

- **The probe leaves a session file unless told not to.** Measured 2026-10-12: each
  `claude -p` probe left an empty 1,171-byte `.jsonl` in `~/.claude/projects/<project>/`.
  `claude --continue` in `apra-amcos-admin-dolce` then resumed the empty probe session, not
  the builder's last one. With `--no-session-persistence`, no file was written.
- **How the probe stops the prompt.** Measured 2026-10-13 on 2.1.296 in `multi-code`:
  `claude -p --no-session-persistence --output-format stream-json --verbose --settings
  '{"hooks":{"UserPromptSubmit":[{"hooks":[{"type":"command","command":"echo probe >&2;
  exit 2"}]}]}}' "hi"` printed the full init message (1 MCP server, 7 plugins, 40 skills),
  then a result with 0 input tokens, 0 output tokens and `total_cost_usd` 0, in 3.0 s. It
  needs no mod, and no probe plugin shows in the init message. The CLI honours only the
  last `--settings`, which is free here because the probe leaves out the instance's.
- **No SSO browser.** The probe's `--settings` also sets `awsAuthRefresh` to `"false"`.
  Otherwise `claude -p` runs the builder's `aws sso login` when the token has expired,
  and opens a browser nobody is watching. (source: `workspace/app/src/main/secretary/cli.ts`,
  `NO_AUTH_REFRESH_SETTINGS`)
- **No alerts from the probe.** `/alert` routes a delivery by the `MULTICODE_INSTANCE_ID`
  and `MULTICODE_SPAWN_ID` headers, and drops one that names no running instance
  (`ProcessManager.handleAlertDelivery`). The probe carries neither the alert hooks nor
  those variables (`buildEnv` in `backends/claude.ts` strips them).
- **`enabled` depends on the directory.** `claude plugin list --json` reports `enabled`
  for the directory it runs in. Run it in the instance's cwd. (source: investigation)
- **The OpenCode plugin's reach.** OpenCode passes a plugin `client` and `serverUrl`, and
  its SDK has `app.skills()` (`GET /skill`). Calling it from inside the plugin is not yet
  verified (Open Question 1). (source:
  `~/.config/opencode/node_modules/@opencode-ai/plugin/dist/index.d.ts`, SDK 1.15.13)
- **OpenCode also reads `.claude/skills/`.** A skill folder there loads in both backends.
  (source: investigation)
- **Where a server's variables come from.** Measured 2026-10-13: a stdio server gets the
  CLI's own environment plus its config's `env` (Claude) or `environment` (OpenCode).
  Neither CLI reads a project's `.env`; a server can read it itself (the Brave server
  does, through `dotenv`). Claude's settings `env` block reaches the server. A Claude
  `${VAR}` that is not set arrives as the literal text; an OpenCode `{env:VAR}` arrives
  empty. Multi-Code started from the Dock has none of the shell's exports, and `buildEnv`
  passes only Multi-Code's own environment. (source:
  docs/timeline/2026-10-13_mcp-env-vars-experiment.md)
- **Field names are version-bound.** Measured on Claude Code 2.1.296 and OpenCode 1.18.35.
  A CLI update can rename a field.
- **Architecture.** Config writes only on Install, through official CLI commands where one
  exists. (source: docs/knowledge/decisions.md, 2026-10-12)

## Dependencies

- The toolbox accordion: `docs/specs/toolbox/prd.md`,
  `workspace/app/src/renderer/components/Toolbox.tsx`.
- Multi-Code's OpenCode plugin and the `/alert` endpoint:
  `docs/specs/attention-alerts/prd.md`, `workspace/app/src/main/backends/opencodePlugin.ts`.
- How a Claude instance is spawned (`--mcp-config`, `--settings`, `--continue`):
  `workspace/app/src/main/backends/claude.ts`.

## Out of Scope

- Hooks, agents, slash commands and output styles. (source: builder, 2026-10-12: three
  kinds only)
- Uninstalling, disabling, updating or editing an existing item.
- Installing at global (`user`) scope.
- Live updates while the section is open. (source: builder, 2026-10-12)
- Restarting instances after an install.
- Plugin options declared in a plugin's manifest (`claude plugin install --config`). The
  preview names the `claude plugin configure` command instead.
- The phone link.

## Open Questions

1. Can Multi-Code's OpenCode plugin read the instance's skill list (`GET /skill`, through
   its `client` or `serverUrl`) without `--port`? Answer with a probe before Story 5's task.
   If it cannot, the route goes back to the builder: `--port` reopens manager-agent Q8.
2. How does a shared OpenCode entry point at a Claude plugin's skills without an absolute
   path? `skills.paths` today names the marketplace folder under `~/.claude/plugins/`.
   Copying the skills into `.claude/skills/` would make Claude load both `digest` and
   `omt:digest`.
3. Does OpenCode have a private per-project config? If not, "private to me" is Claude-only
   for OpenCode items.
4. ~~Does a probe with the instance's `--settings` post to `/alert`?~~ Resolved
   2026-10-13: the probe leaves out the instance's `--settings` (see Technical
   Constraints, "No alerts from the probe").
5. ~~Can the probe stop the prompt without the drop mod?~~ Resolved 2026-10-13: yes, with a
   `UserPromptSubmit` hook that exits 2 (see Technical Constraints, "How the probe stops
   the prompt").
6. Which file does the Story 9 reminder name, for each backend and scope? A project `.env`
   alone is not read by either CLI. Candidates: Claude's `.claude/settings.local.json`
   `env` block (private, per project, works outside Multi-Code too; not yet measured
   there), or Multi-Code reading named variables from `<project>/.env` when it starts the
   project's instances (a new architecture behaviour: the builder's call). Measured in
   T-609; the builder chooses from its two best options.

## Success Metrics

- The builder answers "which omt version does this project load, and from where" from the
  section alone, for both backends.
- Installing omt into a project with no `.claude/` folder takes one dialog. The refresh
  after it shows omt loading in Claude Code and its skills in OpenCode.
- After any number of refreshes, no probe session file exists, and no secret is in a file
  shared through git.

## Changelog

| Version | Date | Change |
|---------|------|--------|
| 1.0 | 2026-10-12 | First version: phase 1 (read-only view) and phase 2 (install), from the 2026-10-12 investigation and the builder's answers in session. |
| 1.2 | 2026-10-13 | G-001 resolved by the builder: no value is ever asked for or written; a reminder after the install names the variable, the file's absolute path and the line to add (Stories 6, 8, 9). Added the env-var facts from the 2026-10-13 experiment and Open Question 6 (which file). |
| 1.1 | 2026-10-13 | Story 4: the probe passes `--mcp-config` but not the instance's `--settings` (hooks only), and stops the prompt with its own `UserPromptSubmit` hook instead of the drop mod. Measured: 3.0 s, 0 tokens. Open Questions 4 and 5 resolved. Added the `awsAuthRefresh` constraint. |
