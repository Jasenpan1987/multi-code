# Gaps: Agent Brief

| ID | Question | Affects | How to close | Status |
|----|----------|---------|--------------|--------|
| G-901 | Does a fork brief a dialog well while the dialog is open (permission, AskUserQuestion, ExitPlanMode)? Does `--resume` of a session stopped on a dialog work, and does it leave the dialog untouched? | Story 2 | Fork real sessions stopped on each dialog kind; compare with today's writer on the eval's judge | open |
| G-902 | Can an OpenCode 2 session be forked so that nothing is saved (no session in its database, nothing in the shared service)? | Story 3 | Read OpenCode 2's fork and session API; measure in a fake `HOME`, as the 2026-11-04 spike did | open |
| G-903 | What does a warm fork cost, and how long does it take, on a 400k+ context? | NFR Cost, Performance | Fork a large live session right after its turn | open |
| G-904 | How long after a session's last request does a fork still read its cache? Does Claude Code ever use the 1-hour cache? | Story 3 | Fork at 1, 3, 4 and 6 minutes after a turn; read `cache_creation.ephemeral_*` | open |
| G-905 | Which effort should today's writer run at? | Story 5 | Measured 2026-11-07 (timeline, "Effort eval"): 8 real inputs x 4 efforts x 2 runs, judged blind. Mean score low 4.88, medium/high/xhigh 4.81; no level more accurate beyond run-to-run spread; on dialogs high and xhigh 5.00, low and medium 4.83 (one error each). Builder chose `low` for Finished, `high` for Needs you (2026-11-07) | closed |
| G-906 | First person ("I", "我") and 30 to 45 seconds, as assumed? | Story 1 | Builder chose first person, 30 to 45 s (2026-11-07); fallback briefs stay third person | closed |
| G-907 | Does a fork leave anything under `~/.claude` (registry entry, plugin markers, shell snapshots, todos, file history)? | Story 4 | List `~/.claude` before and after forks, as T-501 did for today's writer | open |
| G-908 | Do the builder's own hooks in `~/.claude/settings.json` run in a fork, and do any of them report the fork somewhere as a session? | Story 4 | Run a fork with a logging hook in a fake `HOME` | open |
| G-909 | The reply interpreter (voice-secretary Story 6) runs `claude -p` with the same flags, so it also inherits the builder's `xhigh`. How long does reading a spoken reply take, and is a lower effort as accurate? | voice-secretary Story 6 | Time it on real replies; if slow, run the same kind of eval on its real inputs | open |
