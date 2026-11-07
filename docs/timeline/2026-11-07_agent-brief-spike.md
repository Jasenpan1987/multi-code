# 2026-11-07 — The working agent writes its own brief: fork spike

**Type:** investigation (measured, no Multi-Code code changed)
**Participants:** builder, AI (in session)
**Source:** Claude Code 2.1.319 on the builder's Mac, Bedrock, Opus 5.5; real sessions, forked with nothing saved; the probe scripts and raw results stay local (`.omt/probes/fork-brief/`)
**Feeds:** `docs/specs/agent-brief/prd.md`; `docs/knowledge/decisions.md`, 2026-11-07

## Question

The builder found the briefs too shallow (2026-10-28) and leans to the working agent
reporting itself: "我其实现在有点偏向于让干活的 agent 自己汇报". Not by reading its whole
last reply aloud: "直接让他对刚才做的这件事做个总结". Can Multi-Code ask the working agent
for a spoken summary without touching its session, fast enough and at a cost that works?

## Why today's briefs are shallow

Today's brief writer is an outsider: one `claude -p --bare --tools ""` per event that reads
the session name, the builder's last four messages and the turn since the last one, cut from
the front to 60,000 characters. Its prompt tells it to retell in its own words, never follow
the agent's reply, keep to 30 to 45 seconds, and drop what doesn't fit. On the secretary-bar
release session (the builder's last message, then 1,858 lines of work: one bug fix shipped
as 0.10.7, then the whole epic shipped as 0.10.8), the input kept 86 of 279 entries. The
brief never mentioned the first task.

## The command that works

```bash
claude -p --resume <sessionId> --fork-session --no-session-persistence \
  --output-format json \
  --settings '{"awsAuthRefresh":"false","hooks":{"PreToolUse":[{"matcher":"*","hooks":[{"type":"command","command":"echo ... >&2; exit 2"}]}]}}'
# stdin: the request for a spoken summary; cwd: the session's project
```

The fork has the whole conversation, answers once and exits. It keeps the session's tools,
so its request starts with the same bytes as the session's own last request and reads that
request's prompt cache. The PreToolUse hook blocks every tool call.

## Measurements

`total_cost_usd` of a resumed session includes the original's accumulated cost (its
`cost-state` row); the cost below is the fork's own.

| Run | Context | Cache read | Cache write | Cost | Time |
|---|---|---|---|---|---|
| Fork, cache cold (copy of the release session) | 435k | 14,316 | 421,176 | $2.12 | 26.7 s |
| Fork after a fork with another prompt | 435k | 449,608 (2 turns) | 421,239 | $2.21 | 37.4 s |
| Fork, cache warm (a live session, right after its request) | 119k | 115,659 | 3,006 | $0.058 | 15.6 s |
| Same, "answer at once" in the request | 145k | 139,319 | 6,192 | $0.072 | 13.2 s |
| Same, `--effort low` | 119k | 14,316 | 106,975 | $0.55 | 10.3 s |
| Same, `--tools ""` | 119k | 0 | 160,861 | $0.83 | 19.2 s |
| Today's writer, release session | 33k input | 0 | 32,868 | $0.22 | 28.7 s |
| Today's writer, `--effort low` | 33k input | 0 | about 33k | $0.17 | 7.4 s |

- **The cache.** A fork reads the cache only when its request starts like the session's own:
  same tools, same model, same effort. Another effort or no tools costs 9 to 14 times more.
  The session's record holds each request's parameters (`api-request` rows:
  `"model"`, `"output_config":{"effort":...}`), so the fork can match them even after the
  builder changes model or effort. The cache lives 5 minutes (`ephemeral_5m`): a fork more
  than about 5 minutes after the turn pays the cold price, about $2 on a 435k session.
- **Safety.** Asked to write a file and run `ls`, the fork was blocked by the hook
  (`permission_denials` 1) and no file appeared. Forking a live session in the real repo left
  `git status` and the project's session files unchanged.
- **Quality.** On the release session the fork named both tasks, the bug's cause, both
  releases and the four iPhone checks. On the live session it summed up the conversation
  correctly, numbers included, in the first person.
- **Speed.** Thinking is most of the time. Today's writer names no effort, so it inherits the
  builder's `effortLevel: xhigh`: 2,564 of its 2,834 output tokens were thinking, for a
  291-character brief. The fork must keep the session's effort for the cache; asking it to
  answer at once cut its thinking from 726 to 418 tokens. Output runs about 50 to 60 tokens
  per second, so a fork's floor is about 8 to 9 seconds. Speech is on top (about 0.4 s per
  second of audio, voice-secretary PRD).
- Resuming a live session whose last row is a tool call still waiting for its result works.

The builder on 28.7 s: "这个完全无法接受，太慢了". On effort: test every level on complex and
ordinary cases; "我还是需要准确性，慢一点就慢一点". Accuracy comes before speed.

## Effort eval for today's writer

The builder asked for every effort level to be tried on complex and ordinary cases, judged
on accuracy. Today's writer, its real prompt and flags, on 8 real inputs built by the app's
own reader: 3 long Finished turns (68 to 86 entries kept after the 60k cut), 2 ordinary
Finished turns, and 3 dialogs (a command that edits files and drops a stash, a read-only
command, an AskUserQuestion). Each at `low`, `medium`, `high` and `xhigh`, twice: 64 briefs.
One judge call per input (Opus 5.5, `xhigh`) saw the input and that input's 8 briefs,
shuffled, efforts hidden; it listed the key points, then each brief's missed points and
errors, and scored 1 to 5. Every listed error was checked by hand against the input.
Cost: $2.77 for the briefs, $1.41 for the judge.

| Effort | Mean score | Essential points missed | Errors | Median time | Thinking tokens |
|---|---|---|---|---|---|
| low | 4.88 | 0 | 2 | 11.4 s | 0 |
| medium | 4.81 | 0 | 3 | 15.4 s | 364 |
| high | 4.81 | 1 | 2 | 18.7 s | 762 |
| xhigh | 4.81 | 2 | 1 | 29.3 s | 1,886 |

By kind (mean score): long Finished 4.83 / 4.83 / 4.50 / 4.50, dialogs 4.83 / 4.83 / 5.00 /
5.00, ordinary Finished 5.00 / 4.75 / 5.00 / 5.00 (low / medium / high / xhigh). Times ran
four at a time and are slower than alone: the same `low` call alone took 7.4 s.

- No level is more accurate than another beyond the spread between two runs of the same
  level. Higher effort only thinks longer.
- The errors are small and spread over every level: a version said as "零点十八" for 0.10.8
  (low), a test count rounded up past the real one (medium), a review history told wrong
  (high), two iPhone checks merged into one (xhigh).
- On the dialog that edits files, one of the two `low` briefs said the step "runs the tests"
  when the command only edits files; the `xhigh` briefs also said that the stash is dropped
  even if the edit fails. On dialogs, high and xhigh scored 5 on all six runs.

### After T-1101

The writer now names its effort (`low` for Finished, `high` for Needs you). The 8 inputs
rerun twice each, one call at a time, judged blind together with the old `xhigh` runs (and,
on dialogs, the old `high` runs). Cost: $0.80 for the briefs, $1.18 for the judge.

| Kind | New | Old |
|---|---|---|
| Finished (5 inputs) | `low`: 4.60, 1 essential point missed, 4 errors, median 6.9 s | `xhigh`: 4.60, 4 missed, 1 error, median 33.2 s |
| Needs you (3 inputs) | `high`: 5.00, no error, median 12.0 s | `high` 5.00, `xhigh` 5.00 |

One weakness repeats: at `low`, the multi-part version 0.10.8 came out as "零点十八" or
"零点八" in 3 of 5 briefs of the release sample; `xhigh` said it right in all 3. The
prompt's only example of a spoken version has two parts ("零点五版"). No other sample had
such a version.

T-1112 (prompt v12) says a version "every part and every dot", with 0.10.8 as the example.
The release sample at `low` then said "零点十点八版" in 5 of 5 briefs. All 8 inputs again,
judged blind with the old runs: Finished at `low` 5.00 (9 briefs, no point missed, no
error, median 6.7 s) against `xhigh` 4.80; dialogs at `high` 4.89 (9 briefs, median 11.9 s),
the one error an inference not in the material ("keyset" called a paging style). Cost: $0.85
for the briefs, $1.45 for the judge.

## Decided

- The working agent writes the brief, in a fork (builder, 2026-11-07). The other option, the
  agent adding a spoken summary to the end of every reply, would be faster but changes every
  reply on screen and the agent itself.
- Today's writer stays as the fallback: cold cache, OpenCode sessions, a fork that fails. Its
  effort is chosen by an accuracy eval across sample types, not by speed alone.

## Not measured

- A fork for a Needs you (the agent stopped on a dialog).
- A fork of an OpenCode 2 session.
- Warm cost and time on a 400k+ session (by proportion about $0.2).
- Whether a fork leaves anything behind outside the session files.
