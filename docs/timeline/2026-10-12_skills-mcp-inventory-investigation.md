# Skills & MCP section: what each agent loads, and from where (investigation)

**Date:** 2026-10-12
**Type:** investigation
**Participants:** Jasen, Claude (driving the real CLIs)
**Source:** Claude Code 2.1.296 and OpenCode 1.18.35 on the builder's Mac
**Outcome:** the data sources a read-only "Skills & MCP" toolbox section can rely on, and
the traps an install feature must avoid

## Summary

Claude Code states what a session loads in the `system/init` message of
`claude -p --output-format stream-json --verbose`: MCP servers with status and scope,
plugins with version and path, skill names. `claude plugin list --json` adds every install
record with its scope, which is what an override display needs. Skill scope is not stated
anywhere and has to be derived from the name and the file's location. OpenCode states the
same through `opencode debug skill`, `opencode debug config`, `opencode mcp list`, and its
HTTP API, but resolves duplicate skill names at random on every start, so only the running
instance knows which copy it has. A report-only mod is a worse source than either for this
section.

Removing the user-scope omt plugin showed that a plugin loads from two independent things,
an install record and an enable switch, and that two projects had their switch only in the
user's settings.

## Claude Code

### The init message

The first line `claude -p --output-format stream-json --verbose "<prompt>"` prints is
`{"type":"system","subtype":"init",...}`. Fields seen: `cwd`, `session_id`, `tools`,
`mcp_servers` (`{name, status, source}`), `model`, `permissionMode`, `slash_commands`,
`agents`, `skills` (names), `plugins` (`{name, path, source, version}`, `source` being
`<plugin>@<marketplace>`, `@inline` for `--plugin-dir`, `@builtin`), `claude_code_version`,
`output_style`, `memory_paths`. Hooks are not in it.

Measured in `multi-code`: 1 MCP server (`sentry`, `needs-auth`, `source: "user"`),
8 plugins (one was the probe), 40 skills, 17 agents, 75 slash commands.

The probe must not reach the model. Here it loaded a mod that drops the prompt
(`.omt/probes/skills-mcp/drop/`, passed with `--plugin-dir`). A settings
`UserPromptSubmit` hook that blocks should do the same without a mod; not yet verified.
Run it in the session's cwd with the flags Multi-Code spawns that session with, so it
resolves what the session resolved at its start.

### Scope of each kind

- **MCP.** `source` on each server. The scopes the CLI names (`claude mcp get <name>`
  prints them): local ("private to you in this project"), project ("shared via
  .mcp.json"), user ("available in all your projects"), dynamic ("from command line", such
  as the manager's `--mcp-config`), enterprise/managed, claude.ai, agent frontmatter.
  Claude's docs give local > project > user for one name at several scopes; not tested
  here. `claude mcp list` is text only and health-checks every server.
- **Plugins.** `claude plugin list --json` gives one row per install record: `id`,
  `version`, `scope` (`user` | `project` | `local`), `enabled`, `installPath`,
  `projectPath` (project and local scopes), `projectEnabled`. Rows for every project
  appear; filter on `projectPath`. **`enabled` reflects the directory the command runs
  in:** run from `multi-code`, the local-scope ralph-loop and ralph-wiggum rows for
  `apra-amcos-admin-dolce` read `enabled: false`, yet the init message in
  `apra-amcos-admin-dolce` loaded both. Run it in the session's cwd.
- **Skills.** The init message gives names only, and a mod's `$.command.list()` labels
  project and user skills alike as `user`. Derive the scope: a `<plugin>:` prefix means
  that plugin (and its scope); a folder under `<cwd>/.claude/skills/` means project; under
  `~/.claude/skills/` means user; anything else ships with the CLI. `multi-code` measured
  11 project, 13 plugin, 16 bundled, 0 user (40).
- In Claude a project skill `digest` and a plugin skill `omt:digest` never collide, because
  plugin skills carry the prefix. Both load. That is a duplicate to flag, not an override.

### Override and the enable switch

A plugin loads when it has an install record (which version) and an enable switch
(`enabledPlugins: { "<id>": true }` in some settings file). The two can sit at different
scopes.

| Project | Records before | Switch before | Loaded before | Loaded after removing the user-scope plugin |
|---|---|---|---|---|
| `apra-amcos-admin-dolce` | omt 3.4.1 (project), 3.5.0 (user) | `~/.claude/settings.json` only | 3.4.1 | none |
| `apra-amcos-cc-marketplace` | omt 3.4.1 (project), 3.5.0 (user) | user only; project `enabledPlugins` was `{}` | not probed | none (inferred) |
| `apra-amcos-admin-hrr` | omt 3.5.0 (project), 3.5.0 (user) | its own `.claude/settings.json` | 3.5.0 | 3.5.0 |

So the project-scope record wins the version over the user one, and
`claude plugin uninstall <id> --scope user` removes the user-scope switch with the record.
An override display takes the winner from the init message and marks every other record
of the same id as overridden.

After `claude plugin install omt@apra-amcos-cc-marketplace --scope project` in
`multi-code`, `apra-amcos-admin-dolce`, `apra-amcos-cc-marketplace` and
`apra-amcos-admin-msk`, all five projects loaded omt 3.5.0 with its 10 `omt:` skills
(checked through the init message in each).

### A mod as the source

A report-only mod (EARLY ACCESS) reads `$.command.list()` (source `builtin` | `plugin` |
`user` | `mcp`, plus the plugin's name), `$.tool.list()` (MCP tools included) and
`$.settings.read()` (merged settings, `--settings` and `enabledPlugins` included). It
cannot list MCP servers or their status, nor plugin versions or scopes. Measured in
`multi-code`: commands builtin 45, plugin 21, user 11. Not the source for this section.

## OpenCode

- **CLI.** `opencode debug config` (resolved config: `mcp`, `plugin`, `skills.paths`),
  `opencode debug skill` (JSON: `name`, `description`, `location`, `content`),
  `opencode mcp list` (status, text).
- **HTTP**, on any OpenCode started with `--port`: `GET /mcp` (status per server),
  `GET /skill`, `GET /config?directory=<cwd>` (resolved), `GET /global/config`. The
  difference of the two configs is what the project adds. Multi-Code starts its instances
  without a port, and `opencode serve` without `OPENCODE_SERVER_PASSWORD` is unsecured.
- **A global OMT.** `~/.config/opencode/opencode.json` `skills.paths` lists
  `~/.claude/plugins/marketplaces/apra-amcos-cc-marketplace/omt/skills` (with
  cross-model-review and opencode/claude-review), so OpenCode loads OMT in every project.
  `multi-code` measured 18 skills: 1 built-in (`customize-opencode`), 12 from those paths,
  5 from the project's `.claude/skills/`. MCP: `documonster` and `sentry`, both connected,
  both from the global config. No `plugin` entries; Multi-Code's own plugin is injected
  through `OPENCODE_CONFIG_CONTENT` at spawn.
- **Duplicate names resolve at random.** OpenCode also reads the project's
  `.claude/skills/`, and seven names exist both there and in the omt path. Five runs of
  `opencode debug skill` in `multi-code` (`omt` = the plugin's copy, `project` = the old
  copy committed in `de04946`):

  | Run | digest | guide | kanban | prd | qa | teach | work |
  |---|---|---|---|---|---|---|---|
  | 1 | omt | omt | omt | omt | project | omt | omt |
  | 2 | omt | project | project | project | omt | omt | omt |
  | 3 | project | omt | omt | omt | omt | omt | project |
  | 4 | omt | project | omt | omt | omt | project | omt |
  | 5 | omt | omt | omt | omt | omt | omt | omt |

  A separate process cannot tell which copy a running instance has. Only the instance can:
  through Multi-Code's OpenCode plugin, or its HTTP API.

## Traps for an install feature

- The enable switch and the install record are separate (above).
- "Local" is ambiguous. Claude has a scope named `local` (`.claude/settings.local.json`,
  private) beside `project` (`.claude/settings.json`, shared through git). The builder's
  "本地" meant per project. Ask every time.
- A project-scope MCP server in Claude waits for approval on first use
  (`⏸ Pending approval`).
- OpenCode takes nothing from a Claude plugin but its skills, through `skills.paths`, and
  that entry is an absolute path on this machine.
- MCP configs often hold API keys; they must not land in a committed file.
- A project install writes into the repository: `apra-amcos-admin-dolce` got a new
  `.claude/` folder.

## Reproduce

Probes are in `.omt/probes/skills-mcp/`.

- Init message, no model call:
  `cd <project> && claude -p --output-format stream-json --verbose --plugin-dir .omt/probes/skills-mcp/drop "hi" < /dev/null | head -1`
  (use the probe's absolute path when running from another project).
- Install records: `cd <project> && claude plugin list --json`.
- What a mod sees: `inventory/` posts to `127.0.0.1:47398`; start a listener, then
  `claude -p --plugin-dir .omt/probes/skills-mcp/inventory "hi"`.
- OpenCode duplicates: run `~/.opencode/bin/opencode debug skill > run-N.txt` a few
  times in `multi-code`, then `python3 -I .omt/probes/skills-mcp/oc_dup.py run-*.txt`.
- OpenCode HTTP: `OPENCODE_SERVER_PASSWORD=<random> opencode serve --port <p>`, then
  `curl -u opencode:<password> http://127.0.0.1:<p>/skill?directory=<cwd>`.
