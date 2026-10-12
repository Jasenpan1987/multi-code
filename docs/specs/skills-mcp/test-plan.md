# Test plan: Skills and MCP

**Epic:** `docs/specs/skills-mcp/prd.md` v1.2 · **Tasks:** `docs/specs/skills-mcp/kanban.md`

## Milestone 1 QA pass (T-605)

**Result: every M1 "Done when" line passes.** No bugs filed. 2026-10-13.

### Build, launch, references

- **Build:** branch `skills-mcp` at `1c383e0`, `pnpm build`, run as a dev build with its own
  userData: `./node_modules/.bin/electron . --remote-debugging-port=9471
  --user-data-dir=/tmp/mc-t602` from `workspace/app`. The builder's installed Multi-Code ran
  throughout, untouched. Port 9444 was taken by another session's dev build, so pick a free
  port and stop the build by its `--user-data-dir`, never by port.
- **Contacts:** stopped Claude contacts for `multi-code`, `apra-amcos-admin-dolce` and
  `apra-amcos-admin-hrr`, written into `/tmp/mc-t602/contacts.json` before launch, so no
  project session was started or resumed. The manager was created in the app
  (`createManager`); it stopped at the workspace-trust dialog and was sent nothing.
- **Driven over CDP:** `.omt/probes/skills-mcp/t605/` (`readall.js`, `ten.cjs`, `edges.cjs`).
  A hidden window throttles the page's own timers to about one a minute, so loops are paced
  from Node, not with `setTimeout` in the page.
- **Reference:** `.omt/probes/skills-mcp/t605/reference.py` runs the probe and
  `claude plugin list --json` by hand in each cwd, outside Multi-Code, and `compare.py`
  checks the section against it.
- **CLI:** Claude Code 2.1.296.

### Results

| # | M1 "Done when" | Result |
|---|---|---|
| 1 | `multi-code`: `sentry` (`user`) under Global, omt 3.5.0 under This project, seven duplicate pairs | **pass**: `sentry user connected` under Global (the status is whatever the CLI states; it was `needs-auth` when the line was written); `omt 3.5.0 project enabled (project)` under This project; digest, guide, kanban, prd, qa, teach and work each marked "duplicate of omt:…", and each `omt:` half names the other |
| 2 | `apra-amcos-admin-dolce`: local ralph-loop and ralph-wiggum enabled under This project | **pass**: both `1.0.0 local enabled (local)` under This project |
| 3 | A manager shows its `--mcp-config` server under This session, marked Multi-Code | **pass**: `multi-code dynamic connected Multi-Code` under This session, beside `sentry` under Global. The manager's activity feed stayed empty: the probe lists the tools and calls none |
| 4 | Ten refreshes leave the `.jsonl` count unchanged, spend no tokens, raise no chime or red dot | **pass**: ten on each of `multi-code`, dolce, hrr and the manager (40), every one without an error, so every result reported 0 tokens and no error (the probe fails the refresh otherwise); `.jsonl` counts 23 / 0 / 29 / 0 before and after; 0 `instance-activity` events, 0 `.unread-badge` or `.fold-strip-dot` |
| 5 | Nothing refreshes while the section stays open and nobody presses Refresh | **pass**: section open on the manager for 120 s, 0 `skills-mcp-update` pushes and 0 of 60 samples with a probe process |

Every list matched the hand-run reference in all three projects: MCP names, scopes and
statuses; the skill names and count (40 / 29 / 33); the loaded plugins (7 / 9 / 8); and every
install record for the cwd, with its scope (6 / 8 / 8). One refresh took 2.7 to 5.7 s.

### Edges

- [x] Refresh pressed, then three more refresh calls while it runs: one probe process at most.
- [x] Refresh on `multi-code`, then dolce selected at once: dolce shows its own lists
  (Skills 29), and `multi-code` shows 40 when selected again.
- [x] A stopped instance opens the section; every other section stays closed while stopped.
- [x] An OpenCode instance shows "OpenCode comes in M2" (T-602 check).
- [x] A contact whose folder is gone shows "project folder not found: <path>" in each part,
  with no count (T-602 check).
- [x] A project or local `"disableAllHooks": true` no longer lets the prompt out (review fix,
  measured in a scratch project with a model no provider has, so nothing was spent).

### Five-minute check for the builder

1. Start the dev build as above, select a stopped Claude instance and open "Skills and MCP".
   Expect "Refreshing…", then three parts with counts in about 3 s.
2. Compare one project with `claude -p --no-session-persistence --output-format stream-json
   --verbose --settings '{"disableAllHooks":false,"hooks":{"UserPromptSubmit":[{"hooks":[{"type":"command","command":"exit 2"}]}]}}' x < /dev/null | head -1`
   in its folder. Expect the same MCP servers, plugins and skill count.
3. Leave the section open for a minute. Expect "Refreshed <time>" not to change.
4. Record what happened: ______

## Leftovers

- `/tmp/mc-t602/` (isolated userData) and the CDP scripts stay for M2's QA.
