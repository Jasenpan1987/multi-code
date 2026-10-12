# Claude Code mods and auto mode: what they offer Multi-Code (research)

**Date:** 2026-10-11 to 2026-10-12
**Type:** investigation
**Participants:** Jasen, Claude (driving the real CLI)
**Source:** Claude Code 2.1.296 on Bedrock; the bundled `plugin-authoring` skill and the
`types/claude-code.d.ts` it writes (about 21,000 lines, the authority); probes in
`.omt/probes/claude-mods/`
**Outcome:** background for later epics; no decision taken

## Summary

A mod is a plugin whose `hooks/hooks.json` names a TypeScript module. The module runs
inside the CLI, with no Node, and hooks any engine event as middleware `($, e, next)`.
It is EARLY ACCESS, and installed mods can be turned off remotely. It verifiably loads on
this machine's Bedrock setup with `claude --plugin-dir <dir>`. Auto mode already is the
"second model reviews each tool call" idea: a Sonnet 5 classifier against allow,
soft_deny and hard_deny rules.

## Mods

- **Shape.** `.claude-plugin/plugin.json`, `hooks/hooks.json` (`{ "modules":
  ["./register.ts"] }`), the module exporting `register(on, options)`. `claude plugin
  validate <dir>` reads it as the engine will; `claude plugin test <dir>` runs
  `*.test.ts`. Event names must be string literals, `$` must be spelled
  `$.noun.method(...)` at each call, and `$` may be passed only to a top-level function.
- **Sandbox.** Measured inside a module: `fetch`, `require` and `process` are undefined;
  `setTimeout`, `console`, `URL` and `crypto` exist. Everything outside goes through `$`
  (`$.http.fetch`, text bodies only; `$.fs`; `$.process.run`; `$.env`; `$.store`).
- **Hook budget.** 10 s of the hook's own time; `next` and `$` calls in flight do not count.
  A hook that throws is skipped, so a guard needs `.catch`. Calling `next` without
  awaiting it and then denying still runs the tool (measured).
- **Events in one turn**, measured: `prompt.submit` once, `turn.step` once per model
  request, `tool.call` once per tool call (permission is decided inside its `next`:
  `classic.PreToolUse`, then `tool.check`), `session.append` for every stored row,
  `turn.complete` once. Every settings-hook event is also hookable as `classic.<Event>`.
- **Acting.** `$.prompt.submit` starts its own turn once the session is idle;
  `$.command.run` runs a slash command. Measured in an interactive session: a mod
  submitted a prompt, ran `/clear` (session id `cd8b6be3` → `ab5073d0`, `session.end`
  reason `clear`), then submitted a prompt in the new conversation, which answered from a
  file the first one wrote; the module and its variables survived the `/clear`.
- **Reading.** `$.session.usage()` gives context percent; `$.model.complete`,
  `$.model.fork` (over the session's own transcript, cached) and `$.model.classify`
  (small fast model by default) call the model on the session's own credentials.
- **Drawing.** `$.ui.status`, `$.ui.toast`, and `ui.render` on `AbovePrompt` (a band over
  the prompt) or `Pane` (a docked panel opened with `$.ui.open`), seen in a real terminal.
- **AskUserQuestion is a tool call**, so a mod can answer it itself; permission decisions
  are the `tool.check` event (`allow` | `ask` | `deny`).

## Auto mode

- `claude auto-mode defaults` prints the rules: 17 allow, 72 soft_deny, 1 hard_deny
  (Data Exfiltration), 21 environment entries, all "None configured" for this machine.
  `claude auto-mode config` prints the effective set; `claude auto-mode critique` reviews
  custom rules. Custom rules go under `autoMode` in `~/.claude/settings.json`.
- The classifier is `au.anthropic.claude-sonnet-5[1m]` on the builder's Bedrock, in two
  stages. Measured on an unrequested `DROP TABLE users;` (a mod rewrote a harmless
  `sqlite3` count): stage 1 1,355 ms, stage 2 6,787 ms, blocked as
  `[Irreversible Local Destruction]`. When the prompt itself asked to drop the table it
  was allowed in 3.7 s, and the model backed the file up first. Read-only calls and edits
  inside the project skip the classifier ("would be allowed in acceptEdits mode").
- A block tells the model to carry on with other work. It falls back to a permission
  prompt after 3 consecutive or 20 total blocks in a session (`maxConsecutive: 3,
  maxTotal: 20`); headless `-p` aborts instead. A timed auto-deny of that prompt
  (`CLAUDE_CODE_TICKLISH_WHISPER_TIMEOUT_MS`, default 120000) sits behind an internal flag.
- In auto mode the builder's `Bash(*)` and `Agent(*)` allow rules are ignored ("bypasses
  classifier", debug log); in any other mode they let every command through.
- The classifier blocked, as `[Auto-Mode Bypass]`, a grep of past transcripts for its own
  denials.

## Third-party judge looked at

TypeSafe AI's Jev (published 2026-10-11, early access) returns typed choices with
probabilities, claims 70 to 500 ms per call, and is served only from its own API on the US
West Coast; the company profile allows Bedrock only.
