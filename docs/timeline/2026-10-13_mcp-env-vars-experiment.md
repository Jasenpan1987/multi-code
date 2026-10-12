# Where an MCP server gets its environment variables (experiment)

**Date:** 2026-10-13
**Type:** investigation
**Participants:** Jasen, Claude (driving the real CLIs)
**Source:** Claude Code 2.1.296, OpenCode 1.18.35, `@brave/brave-search-mcp-server` 2.1.4 on the builder's Mac
**Outcome:** the facts the install's secret handling (PRD Story 8, G-001) must rest on

## Summary

A stdio MCP server is a child process of the CLI. It gets the CLI's own environment plus
the `env` (Claude) or `environment` (OpenCode) entries of its config. Neither CLI reads a
project's `.env` file. A server can read `.env` itself: the Brave server does, through
`dotenv`, from its working directory, which both CLIs set to the project folder. An unset
`${VAR}` reference in Claude's config reaches the server as the literal text `${VAR}`, so
a server that only checks for a non-empty key reports `connected` with a wrong key.
OpenCode's `{env:VAR}` becomes an empty string, and the same server fails.

## Method

The Brave server exits at once with "A Brave API key is required via --brave-api-key,
BRAVE_API_KEY, --brave-api-key-file, or BRAVE_API_KEY_FILE" when it finds no key, and starts
with any value, so a fake key `fake-key` shows whether the variable arrived. No Brave API
call, no model call.

- Claude: a probe in a temp git repository, the server passed with `--mcp-config` (no
  approval needed), the status read from the init message. Script:
  `.omt/probes/skills-mcp/env/claude_case.sh <project dir> <mcp config> [settings fragment]`,
  configs `plain.json` (no env), `literal.json` (`"BRAVE_API_KEY": "fake-key"`), `ref.json`
  (`"BRAVE_API_KEY": "${BRAVE_API_KEY}"`).
- OpenCode: `opencode mcp list` in the same folder with an `opencode.json` that declares the
  server.
- `BRAVE_API_KEY` unset in the calling shell for every case except the "exported" ones.

## Results

| Where the key is | Claude Code | OpenCode |
|---|---|---|
| Nowhere | failed | failed |
| Exported in the shell that starts the CLI | connected | connected |
| Only in the project's `.env` | connected (the server reads it, see below) | connected (same) |
| Written in the MCP config's env | connected | connected |
| Reference, variable not set (`${VAR}` / `{env:VAR}`) | **connected**: the server got the literal `${BRAVE_API_KEY}` | failed: the server got an empty string |
| Reference, variable exported | connected | connected |
| Claude's settings `env` block (passed with `--settings`) | connected | n/a |

**`.env` is the server's doing.** The Brave server lists `dotenv` 17.3.1 in its dependencies
and loads it in `dist/config.js`. Started by hand in the folder with `.env`, it started;
started from `/tmp` with the same `.env` left behind, it failed. A separate test with
`sh -c 'printf ... "$V" "$MC_ENV_TEST"'` as the server showed Claude passing
`V=[${MC_ENV_TEST}] RAW=[]` with `MC_ENV_TEST` only in `.env`, and `opencode debug config`
resolving `{env:MC_ENV_TEST}` to `''` in the same situation: neither CLI loads `.env`.

## What follows for Multi-Code

- A `.env` in the project works only for servers that read it themselves. It is not a
  general place for a key.
- A variable exported in a terminal reaches only CLIs started from that terminal. Multi-Code
  started from the Dock does not have the shell's exports (the same cause as the missing
  `LC_CTYPE` fixed in v0.8.1), so neither do the instances it starts.
- `connected` does not prove a key is right. Multi-Code must check that each variable a
  server references is set, rather than trust the status.
