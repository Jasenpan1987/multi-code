# 2026-11-04 — Secretary on `opencode run` spike

**Type:** investigation (measured, no Multi-Code code changed)
**Participants:** AI (spike agent, for the supervisor session)
**Source:** OpenCode 2.2.2 on the builder's Mac, in a fake `HOME`; the builder's own service and database untouched
**Feeds:** `docs/knowledge/decisions.md`, 2026-11-04 "The secretary needs Claude Code, with no OpenCode fallback"; PRD v2.1

## Question

The secretary writes every brief and reads every reply with `claude -p`, OpenCode sessions'
too. Could a builder with OpenCode only have a secretary, with `opencode run` doing the same
one-shot job? It has to keep the promises `claude -p --no-session-persistence` keeps: nothing
put into OpenCode's shared service, nothing left in the builder's data, the input never in argv.

## Summary

It runs, but not without residue. `--standalone` keeps the process side of "Multi-Code puts
nothing into that service": the background service is never started or contacted. The data
side fails: every call writes a session into the same database the service reads, where
`opencode session list` and the service API show it until it is deleted, and deleting it
still leaves the transcript's bytes in free pages, a permanent `project` row per cwd and log
lines. `claude -p --no-session-persistence` writes none of that. The builder decided on
2026-11-04: no fallback. The secretary needs Claude Code and is off without it.

## The command that works

```bash
opencode run --standalone --format json \
  --agent <id> --title <title> --session <pre-minted id>
# stdin: the input JSON (read when stdin is not a TTY)
# OPENCODE_CONFIG_CONTENT: an inline agent carrying the system prompt
```

- **The system prompt** goes in an inline agent in `OPENCODE_CONFIG_CONTENT`, with the v2
  keys: `agents.<id>.system`, `permissions` denying everything, and
  `"plugins": ["-opencode.tool.skill"]` to remove the skill tool.
- **The shared-service mode doesn't work.** Without `--standalone` the inline config is
  ignored ("Agent not found"), and a session is still created in the service.
- **The input goes on stdin, never argv.** The CLI logs its argv to
  `~/.local/share/opencode/log/opencode.log`. `--file` stores the content, base64, in the
  database.

## Output

- NDJSON: `text` parts, per `messageID`.
- A failure is one `{"type":"error",...}` line and exit 1.
- A malformed provider stream was retried 11 times over 87 s before it failed.

## Model

- With no `--model`, the config's default model runs. The JSON never names the model; only
  the database and `opencode session export` do.
- An unusable default **silently falls back to a free model**, so the transcript goes to
  OpenCode Zen. `OPENCODE_DISABLE_FREE_MODELS=1` turns that into a `provider.no-route` error.
- The free models (big-pickle, crouton) refuse a tool-less request with a misleading "Free
  usage limit reached" (4 of 4 calls). With one dead tool added, 4 of 5 briefs passed the
  strict parser; the fifth leaked `</｜DSML｜ parameter>` markup after the JSON.

## Residue

| What | Per call | After `opencode session delete <id> --standalone` (0.57 s) |
|---|---|---|
| `session_v2` | +1 row | back to its count |
| `session_message` | +4 rows | back to its count |
| `event_sequence` | +1 row | back to its count |
| `instruction_state` | +1 row | back to its count |
| Session visible in `opencode session list` and the service API | yes | gone |
| Transcript bytes in the database file's free pages | | **stay**: a 55k-character session's text was found 63 times with grep |
| `project` row for the cwd | +1, once per cwd | **stays**: the API has no delete |
| `shell/<projectID>/` directory | created, empty | **stays** |
| Log lines | about 8 | **stay** |
| `instruction_blob` rows | added | **stay** |

`OPENCODE_DB=:memory:` writes nothing, but it also loses the logins stored in the database,
such as a key from `opencode auth login` or Copilot's OAuth.

## Side effects on every call

- **The builder's MCP servers and server plugins start**, about 3 s each call. On 2.2.2 a
  policy `{"action":"integration.use","resource":"*","effect":"deny"}` stops them. The docs
  say that from 2.2.3 the same policy blocks every provider, and `mcp.use` / `plugin.use` must
  be used instead, which 2.2.2 ignores.
- **A global `~/.config/opencode/AGENTS.md` is appended to the prompt.** No switch was found
  to turn it off.

## Time

On the free model: 5.4 s, 8.4 s and 33.2 s (a 55k-character input), plus 0.6 s for the
delete. The machine's load average was about 150.

## Verdict

The process side of the OpenCode 2 rule holds (`CLAUDE.md`, Architecture: Multi-Code puts
nothing into the shared service). The data side does not: each brief would leave a trace in
the builder's OpenCode database, and the Privacy and Zero-residue promises of the PRD would
break. `claude -p --no-session-persistence` writes nothing. **Decided by the builder on
2026-11-04: no OpenCode fallback.** The secretary always runs `claude`; without Claude Code it
is off, and the Secretary section says so. Revisit if OpenCode adds a run that doesn't persist.
