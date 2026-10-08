# Brief Writer Spike on the Real CLI — investigation

**Date:** 2026-10-08
**Type:** investigation (T-501)
**Participants:** Claude (task agent, working autonomously for the builder)
**Source:** probes run on the builder's Mac against Claude Code 2.1.292, Bedrock `global.anthropic.claude-sonnet-5-5` and `https://tts.jasenpan.com`; scripts kept in `.omt/probes/voice-secretary/t501/` (gitignored)
**Feeds:** `docs/specs/voice-secretary/kanban.md` T-504; also T-502 (speech timeout) and T-505 (Story 2's 20 s)

## Summary

The brief writer works as a spawned `claude -p`, with no SDK and nothing new to install.
Launched the way the Dock launches an app, with no `AWS_*` in its environment, it reaches
Bedrock: `--bare` still applies the `env` block of `~/.claude/settings.json`, which is where
the Bedrock profile lives. Each call leaves nothing behind in `~/.claude/projects`, history
or `~/.claude.json`. Two CLI bookkeeping files exist only while the call runs. It
answers in 3.6 to 8.9 s for inputs of 3.5k to 75k tokens. Asked for JSON in the prompt
alone, with no `--json-schema`, it returned valid JSON on every one of 142 runs, and the
final prompt met the strict two-key contract on all 31 of its runs. Spoken, the briefs run
33 to 51 s, under the PRD's minute. They take the speech server 12 to 21 s to synthesize,
though, so T-502's 15 s timeout fails most of them. That needs a decision before T-502
ships.

## The command

```bash
claude -p --bare --no-session-persistence \
  --model global.anthropic.claude-sonnet-5-5 \
  --output-format json \
  --setting-sources user \
  --tools "" \
  --system-prompt "<the prompt below, verbatim>"
# stdin: the event JSON (compact), then EOF
```

| Flag beyond the kanban's | Why | Measured |
|---|---|---|
| `--system-prompt` | Replaces the CLI's coding-agent prompt with the secretary's rules | Same speed and quality as `--append-system-prompt` or rules on stdin; about 1.5k fewer input tokens |
| `--tools ""` | No tools at all: the writer can't read files, run anything or wander off | About 1.4k fewer input tokens; speed unchanged |
| `--setting-sources user` | Loads `~/.claude/settings.json` (the Bedrock env) and nothing from the cwd's `.claude/` | Works from the Dock env, see 1 |

Considered and left out:

- **`--json-schema`**: 2 or 3 turns per call instead of 1 (it answers through a
  structured-output tool), twice the input tokens (67k against 33k on the large sample),
  1 to 3 s slower. It also wrote a **Chinese** brief for an English builder on both runs of
  the English permission sample, which prompt-only never did. The prompt-only contract
  needs no schema (see 4).
- **`--effort low`**: no effect. Sonnet reported 0 thinking tokens on every run, with or
  without it, even though the user's settings carry `alwaysThinkingEnabled` and
  `effortLevel: xhigh`.

## 1. From the Dock: does it reach Bedrock?

**Yes, with no change.** The CLI applies `~/.claude/settings.json` `env` under `--bare`.

**Method.** `open -a` from a terminal cannot answer this on this Mac: the first probe
launched that way received the shell's whole environment (`AWS_PROFILE`, `CLAUDECODE`,
`_=/usr/bin/open`). Contrary to the kanban's note, `open -a` run from a shell is not a Dock
launch. Instead, `launch-via-launchd.sh` boots a throwaway launchd agent into
`gui/<uid>`. Its plist sits in the probe directory, never in `~/Library/LaunchAgents`, and
is booted out afterwards. The agent runs
`open -n -a <worktree>/workspace/app/node_modules/electron/dist/Electron.app --args <probe>`,
so LaunchServices starts Electron from launchd's environment, the same as a Dock click.
The probe's main process (`electron-probe/main.cjs`) takes the command and env from the
real `claudeBackend.spawn(cwd)` (compiled with `pnpm build:main`), runs the calls, writes
the results and quits.

Electron's main process got exactly this env (ppid 1): `COMMAND_MODE`, `HOME`, `LOGNAME`,
`MallocNanoZone`, `ORIGINAL_XDG_CURRENT_DESKTOP`, `OSLogRateLimit`,
`PATH=/usr/bin:/bin:/usr/sbin:/sbin`, `SHELL`, `SSH_AUTH_SOCK`, `TMPDIR`, `USER`,
`XPC_FLAGS`, `XPC_SERVICE_NAME`, `__CFBundleIdentifier`, `__CF_USER_TEXT_ENCODING`. No
`AWS_*`, no `CLAUDE_*`, no `ANTHROPIC_*`. The child got the same plus `buildEnv`'s PATH
prefix (`~/.local/bin:/opt/homebrew/bin:/usr/local/bin:`).

| Call (all `-p --bare --no-session-persistence --model global.anthropic.claude-sonnet-5-5 --output-format json`) | Result |
|---|---|
| as is | `pong`, `modelUsage` provider `bedrock`, 3.1 s |
| plus `--tools Bash`, asked to print its own env | `AWS_PROFILE=sso-bedrock`, `AWS_REGION=ap-southeast-2`, `CLAUDE_CODE_USE_BEDROCK=1`, `CLAUDE_CODE_SIMPLE=1`: the settings `env` was applied inside the CLI |
| plus `--setting-sources project,local` (user settings skipped) | exit 1, `is_error: true`, result `Not logged in · Please run /login`, 0.9 s |
| the same, with `AWS_PROFILE`, `AWS_REGION`, `CLAUDE_CODE_USE_BEDROCK` passed in the env | `pong` via Bedrock, 4.0 s |
| plus `--setting-sources user --tools ""` | `pong` via Bedrock, 3.5 s |

So the Bedrock access comes only from the user's settings file, and `--bare` keeps it.
The fallback, if that ever changes, is the fourth row: pass the three variables explicitly.
One correction to the kanban: `instance-env.ts` does not pass Bedrock env to instances
today. It only holds the `MULTICODE_*` names, and instances reach Bedrock through the same
settings file, so there is nothing to copy from it.

## 2. Residue

**Nothing persists from a call that exits normally or on SIGTERM.** Reproduce with
`node residue_watch.cjs <out.json>`, run under the Dock-like env of `run-dockenv.sh`. It
snapshots the mtime of every path under `~/.claude` (except this job's own directory) and
`~/.claude.json`. Then it runs a call while polling `~/.claude/sessions/` every 25 ms, and
diffs. Between calls it runs a 5.5 s control window with no call, because other Claude
sessions were live on the machine. A first attempt with a marker file and
`find ~/.claude -newer marker` could not separate the probe from them.

| Path | During the call | After a normal exit or SIGTERM | After SIGKILL |
|---|---|---|---|
| `~/.claude/projects/` | nothing: no directory for the cwd, no transcript; the nonce and session ids found nowhere but this agent's own transcript | nothing | nothing |
| `~/.claude/history.jsonl`, `todos/`, `shell-snapshots/`, `file-history/`, `~/.claude.json` | unchanged during every call (`history.jsonl` and `file-history/` changed once, in a control window, from another session) | unchanged | unchanged |
| `~/.claude/sessions/<pid>.json` | created: the CLI registers itself | removed | left, then removed by the next CLI start |
| `~/.claude/plugins/cache/<mkt>/<plugin>/<ver>/.in_use/<pid>` (one per enabled plugin, 4 here) | created | removed | **left; the next CLI run does not clear it** |

The same holds for the kanban's exact flags (no `--setting-sources`, `--tools` or
`--system-prompt`). The SIGKILL leftovers from the test were removed by hand afterwards.
Stale `.in_use/<pid>` markers from the user's own past sessions were already there, so a
leftover marker is the CLI's normal untidiness, not new damage. T-504 should still try
SIGTERM before SIGKILL. SIGTERM exited with code 143 within about half a second and
cleaned up both kinds.

The brief writer's `sessions/<pid>.json` lives for the 4 to 9 s of a call. Multi-Code reads
that registry by the pty child's pid and checks the cwd (`findClaudeLiveSessionId`), so a
brief writer's entry never matches an instance.

## 3. Timing

Final prompt, 31 calls, all launched through launchd (`out-final-launchd.json`). Wall time
is spawn to exit, measured in the Electron main process.

| Sample | Input | Wall min / median / max | API median |
|---|---|---|---|
| s6 decision, English | 3.5k tokens | 3.6 / 3.7 / 3.8 s | 2.0 s |
| s2 finish, English | 3.6k | 4.3 / 4.4 / 5.0 s | 2.3 s |
| s3 permission, Chinese | 4.1k | 4.4 / 5.0 / 5.1 s | 3.1 s |
| s5 decision, Chinese | 6.2k | 4.2 / 4.6 / 5.9 s | 2.5 s |
| s4 permission, English | 6.4k | 3.6 / 4.0 / 4.1 s | 2.1 s |
| t7 large turn cut to 60,000 characters | 30.5k | 5.1 / 5.5 / 5.9 s | 3.8 s |
| s1 finish, Chinese | 30.9k | 5.3 / 6.1 / 6.9 s | 4.1 s |
| t7 large turn, whole (149k characters) | 75.1k | 6.9 / 7.9 / 8.9 s | 4.1 s |
| x1–x3 language checks | 3.6–4.1k | 3.7 to 5.2 s | |
| **All 31** | | **3.6 / 4.6 / 8.9 s** | |

About 1.5 to 2 s of each call is CLI startup; the rest grows slowly with input. Output was
140 to 340 tokens. The serialized input ran 1.7 to 2 characters per token in both
languages (JSON escaping and command text are dense), so a 60,000-character budget is about
30k tokens and keeps a call around 5 to 6 s.

## 4. The JSON contract

**Prompt-only is reliable enough with a lenient parse.** Across 142 prompt-only runs
(all seven prompt versions, every variant except `--json-schema`), the result always parsed as a JSON object with
a valid `language` and a non-empty `brief`. There was never a code fence, prose around it, a
wrong type or an unknown language. The strict two-key shape broke 5 times, every time by an
extra third key (`language_note`, `extra`, `reasoning`, null or empty). The final prompt
went 31 for 31 strict. So T-504 should parse with `JSON.parse`, require the two fields and
ignore anything else.

The prompt took seven rounds. What each round fixed, from the briefs it produced: the
secretary speaking as the agent ("I ran a test of the flags"), briefs of 550+ Chinese
characters (two minutes spoken), half-width punctuation and raw names in Chinese
(`feat/manager-agent`, `npmrc`, `hdiutil`), an English builder getting a Chinese brief
because everything else in the session was Chinese, and "您" against "你".

### Final system prompt (verbatim, `system-prompt-v7.txt`)

```text
You are the secretary of one coding-agent session in Multi-Code. The builder you work for is away from the screen. When they come back and click the session, your brief is spoken to them by a text-to-speech voice. Write that brief: a secretary briefing a busy boss in person, not someone reading the screen aloud.

The input is one JSON object about one event:
- "session": the session's name, as the builder knows it.
- "event": "finished" (the agent ended its turn and is waiting for the builder) or "needs-you" (the agent is stopped on a dialog only the builder can answer).
- "prompt" (needs-you only): the dialog. "toolName" is the tool that raised it and "toolInput" its exact input. "question" and "options" are what the dialog shows. For AskUserQuestion, every question and its options are in toolInput.questions.
- "builderLatestMessage": the last thing the builder typed in this session.
- "builderEarlierMessages": up to three messages the builder typed before that, oldest first.
- "turn": what happened since builderLatestMessage, in order: the agent's messages ("assistant"), the tools it ran ("tool", with a one-line summary; "pending": true marks the one it is stopped on), and rows the system added ("user").

What to say

Always open with the session's name, the way a person would ("gomoku 那边……", "eat-what just finished …").

You are not the agent and did none of the work: speak about the agent in the third person ("it", "它"), never as "I" or "我". Address the builder as "you", in Chinese "你", never "您".

Retell in your own words. Never read out or paraphrase the agent's reply line by line, and never narrate the middle of the turn: nothing like "it read file X", "it tried another approach", "first it ran the tests". Only where things stand now and what the builder needs to know.

finished: the outcome first, then what the builder asked for and what was done, whether it worked (tests pass, the build succeeded, what failed or couldn't be done), and anything left for the builder, such as a decision, something to check, or a question the agent asked at the end. If the agent ended on a question, end the brief with that question.

needs-you, permission (any toolName except AskUserQuestion and ExitPlanMode): what the agent is working on and why it needs this step, then what the operation will actually do, in plain words: its effect, not its syntax. Say so when it deletes, overwrites, pushes, installs, kills processes, or reaches outside the project. Skip the harmless parts of a command, such as printing or filtering its output. Then ask whether to allow it. "It wants to run a shell command, allow?" is not enough.

needs-you, AskUserQuestion: in one sentence, what the agent is deciding. Then each question, and each of its options as a short phrase: what choosing it means and its main cost, not its full description. Say which option the agent recommends, if it does. With several questions, say how many and take them in order. Leave out the automatic "Other" choice.

needs-you, ExitPlanMode: the plan in a few sentences, then that it is waiting for approval to start.

Language

Decide from builderLatestMessage alone. If it is pure English, write in English. If it contains any Chinese, write in Chinese, keeping English technical terms (product, tool and function names) as they are. Nothing else counts: an English builderLatestMessage gets an English brief even when the earlier messages, the agent and the dialog are all Chinese, because someone else may be at the keyboard. Translate whatever you retell.

If builderLatestMessage has no natural-language words (only a choice like "A" or "2", a command, a path, a placeholder like "[Image #1]"), decide the same way from builderEarlierMessages, newest first. If none of them has words, write in Chinese.

Written for the ear

Plain spoken sentences only: no markdown, lists, headings, code, tables or emoji. In Chinese, use Chinese punctuation (，。？：).

No file paths, URLs, commit hashes, ids, flags or command lines. Mention a file, branch, worktree, function or tool by name only when the builder needs the name, and then say it as words ("the manager agent branch", "the M2 UI worktree", "the NPM config file", "the macOS disk image tool"), never as written ("feat/manager-agent", "m2-ui", ".npmrc", "hdiutil"). No characters such as / \ _ - . # @ ~ ` * > & | inside a word. The one exception is the session's name: always write it exactly as given.

Write anything said letter by letter in capitals, even a tool normally written in lowercase, in Chinese briefs too (NPM, PNPM, TSX, DMG, PR, UI, CLI: "NPM 配置", never "npm 配置"), but keep names people say as words (React, Vite, JSON, GitHub, esbuild). Write version numbers the way they are said ("version zero point five", "零点五版"), and round other numbers when the exact figure doesn't matter.

Length: aim for 30 to 40 seconds spoken: at most six sentences, about 150 to 200 Chinese characters or 70 to 100 English words. Never more than 250 characters or 130 words. Shorter is better when there is little to say. When there is more than fits, keep the outcome and what the builder has to do, and drop the rest.

Before answering, reread the brief as if hearing it: rewrite any word that holds / - _ . or mixes letters and digits in lowercase (m2-ui, dmg, hdiutil), and any sentence that only makes sense on screen.

Output

Return only a JSON object, with nothing before or after it and no code fence:
{"language": "Chinese" or "English", "brief": "<the brief>"}
Exactly these two keys, no others. "language" is the language the brief is written in.
```

### Input format (stdin)

One compact JSON object (`JSON.stringify(input)`):

```ts
interface BriefWriterInput {
  session: string;                    // the instance's alias
  event: "finished" | "needs-you";
  prompt?: {                          // needs-you only, from T-503's secretaryEvent.prompt
    toolName: string;
    toolInput: unknown;               // raw, as the PermissionRequest hook delivered it
    question?: string;                // PromptDetail.question
    options: PromptOption[];          // PromptDetail.options, "Other" included
  };
  builderLatestMessage: string;
  builderEarlierMessages: string[];   // up to 3 typed before it, oldest first
  turn: TranscriptEntry[];            // readTranscript entries after builderLatestMessage
  turnEntriesDropped?: number;        // set when the front of `turn` was cut to fit
}
```

`builderLatestMessage` and `builderEarlierMessages` must **not** come from
`readTranscript`. In a survey of the multi-code, eat-what and two study projects'
transcripts (live sessions excluded), `readClaudeTranscript` keeps all 65 `isMeta` rows
with string content as `user` entries, 25 of them the CLI's
`[Image: original 2400x1600, displayed at …]` lines. It also drops every typed message whose
content is an array: 32 with a pasted image, 8 text-only. Taking its last `user` entry would hand the writer
"[Image: original …]", which is English and would flip a Chinese builder's brief. The
samples here read the raw JSONL instead (`typedText` in `build_inputs.cjs`). A message
counts as the builder's when it is a `user` row, not `isMeta`, not a `tool_result`, its
string content or the text parts of its array content not starting with `<` (which skips
`<command-name>`, `<bash-input>`, `<task-notification>` and `<local-command-…>`), and not
`[Request interrupted`.

`builderEarlierMessages` exists for the language rule. Real builders often answer with a
bare "B", "2" or "[Image #1]", and by the PRD's rule a pure-ASCII answer would turn a
Chinese builder's brief English. The prompt falls back to the earlier messages, so the rule
stays in the prompt, as the kanban asks.

### Samples

Event fields were built by the real code: `turn` by `readClaudeTranscript` over the
turn's lines; `question` and `options` by `extractPromptDetail` over the blocking
`tool_use`'s `name` and `input`. All from personal projects. Outputs are the first of three
runs of the final prompt from the launchd (Dock-env) run, verbatim.

| Id | Transcript, lines | Event | Builder's latest message | Input |
|---|---|---|---|---|
| s1 | `-Users-jasenpan-code-study-ai-nativ-sdlc-gomoku--claude-worktrees-m2-ui/b14cf76c-f7a5-4ad3-81f7-5bb17f004dab.jsonl` 6–1198 | finished; 210 entries | "你在 worktree 里。负责人决定 M2 和 M3 的电脑算法部分分两个会话并行做。你只做 … M2，第 1 到第 9 步 …" | 51k characters, 30.9k tokens |
| s2 | `-Users-jasenpan-code-eat-what/819851b1-c4f5-4629-9893-a5769fdf019c.jsonl` 212–261 | finished; 10 entries, the last ending in a code block | "give me a claude code command, I will open in a new terminal, the command will let claude code run automatically without interrupt …" | 3.6k tokens |
| s3 | `-Users-jasenpan-code-apra-multi-code/3df4ad28-964f-49eb-bda1-727b07489b1b.jsonl` 1197–1225 | needs-you, `Bash`: `git checkout master 2>&1 \| tail -2 && git merge --ff-only feat/manager-agent 2>&1 \| tail -4 && echo "=== now on ===" && git log --oneline -3`, description "Fast-forward master to the branch"; options Yes / Yes, and don't ask again / No | "他不是每次都有的 而且是在0.4.2版本触发的 没事 commit merge进main 然后build一个新版本出来 …" | 4.1k tokens |
| s4 | `-Users-jasenpan-code-eat-what/d5bb91b9-38c4-46c9-91f3-e79c1e908331.jsonl` 7–203 | needs-you, `Bash`: `npm approve-scripts esbuild 2>&1 \| tail -10; echo "---"; node -e "…p.allowScripts…"`, description "Approve esbuild install script" | "# Autonomous build brief — `eat-what` …" (6,190 characters, English) | 6.4k tokens |
| s5 | `-Users-jasenpan-code-apra-multi-code/c35e293e-23c5-4c1d-92b4-a1bd7756ea64.jsonl` 243–271 | needs-you, `AskUserQuestion`, two questions: "你平时开的那些 session，主要是哪个 CLI？" (混着用 / 几乎全是 Claude Code) and "Manager 给下面派活，要不要经你批？" (直接派，但 UI 上看得见（推荐） / 写入类操作要批) | "我想跟你聊一件事，关于我真正需要的功能 … Manager 的角色 …" | 6.2k tokens |
| s6 | `-Users-jasenpan-code-eat-what/819851b1-c4f5-4629-9893-a5769fdf019c.jsonl` 5–65 | needs-you, `AskUserQuestion`, three questions: platform, data source, who uses it; two options each, the first marked (Recommended) | "follow the eccp way, I want to build a lunch picker app. please guide me step by step from planning to complete" | 3.5k tokens |
| x1 | s3 with the latest message replaced by "B" (its earlier messages Chinese) | as s3 | "B" | |
| x2 | s3 with an English latest message after Chinese ones | as s3 | "ok, commit it, merge into main, then build a new version so I can try it" | |
| x3 | s6 with a mixed latest message | as s6 | "按 eccp 的流程来，我想做一个 lunch picker app，一步一步带我从 planning 做到完成" | |
| t7 | `-Users-jasenpan-code-apra-multi-code/89dfe948-d43b-406a-a209-113eab8115df.jsonl` 7–1438, whole and cut to 60,000 characters | finished; timing only, since the turn ends on a CLI "Continue from where you left off" row | | 75.1k / 30.5k tokens |

`eat-what/d5bb91b9…` 7–593 was the first English finish tried. It was dropped because the
turn ends in "[Request interrupted by user]".

**s1** (finish, Chinese):

> {"language":"Chinese","brief":"gomoku M2 那边做完了，第 1 到 9 步都完成，自动测试全过，还没提交，等你点头。中途它被开在 m3-ai 里，后来按你说的整体搬到了新的 m2-ui worktree，m3-ai 已恢复干净。单元测试 142 条、端到端 53 条都通过，类型检查和安全审计无问题，正式包和 DMG 都能出，签名有效。和计划不同的地方有 12 条，已写进计划的 M2 那一节。另外，它查 NPM 配置时把你的 NPM 配置文件整个打印出来了，里面有两个 GitHub token，建议你去换掉。现在需要你按手工检查清单过一遍，尤其是关闭按钮、退出和英文系统下的关于面板，没问题就点头，它再提交。"}

**s2** (finish, English):

> {"language": "English", "brief": "eat-what is done. You asked for a command that runs Claude Code with no interruptions and logs its decisions. It wrote two files in the project, a brief for the autonomous run and a decisions log already holding ten earlier decisions. It also built a terminal command that skips permission prompts, blocks the question tool, and tells the new session to follow the EPCC rules. The agent test-ran the flags and they parsed fine. The command is in the session, ready to paste into a fresh terminal. One warning: it will run any command without asking you, but you can press Escape to stop it. Want to run it?"}

**s3** (Bash permission, Chinese):

> {"language": "Chinese", "brief": "Multi-Code 这边需要你批准一步。它已经把两个提交做完了，一个是 README 的小修改，一个是给管理 agent 加上自己动手能力并显示在活动记录里的功能。现在它想切换到 master 分支，再把 manager agent 分支快进合并进去，最后看一下最近三条提交记录。这只是在本地移动分支指针，不会推送，也不会删除东西，而且因为是只允许快进，有冲突就会直接失败。这对应你说的先合并再打新版本。要允许吗？"}

**s4** (Bash permission, English):

> {"language": "English", "brief": "eat-what is working through the autonomous build and has stopped on a permission request. It has finished planning, set up git and the shared and server workspaces, and is now installing server dependencies. It wants to run an NPM command that approves the install script for esbuild, so the build tool can finish setting itself up. That will likely add an approval entry for esbuild to the package config file. It only affects this project, and the rest of the command just prints the result. Do you want to allow it?"}

**s5** (AskUserQuestion, Chinese):

> {"language":"Chinese","brief":"Multi-Code 这边，agent 在设计 Manager 方案，现在停下来问你两个问题。第一，你平时主要用哪个 CLI。选混着用 Claude 加 OpenCode，就只走 Multi-Code 自己的通道，功能不减，但 session 不能主动找 Manager。选几乎全是 Claude Code，可以再加一层原生通道，让 session 主动向 Manager 汇报，代价是多维护一条路径。第二，Manager 派活要不要经你批。直接派，但界面上看得见，这是它推荐的，符合你当 CEO 的定位。或者写入类操作要你批，更安全，但 Manager 没法自主串联流程。"}

**s6** (AskUserQuestion, English):

> {"language": "English", "brief": "eat-what has finished exploring the empty folder and is now asking three questions before it writes the plan. First, web page or terminal command. It recommends the web page, which also works on your phone; the terminal is faster but only runs on your Mac. Second, where restaurants come from: your own list, which it recommends and needs no keys, or a live maps search that needs an API key and billing. Third, just you or group voting with coworkers. It recommends just you, since voting needs a server and database and is a much bigger job."}

**x2** (English latest message after Chinese ones):

> {"language":"English","brief":"Multi-Code is asking permission for the merge step. It has committed the README fix and the manager's own tools work, and now wants to switch to the master branch and fast-forward it to the manager agent branch, then show the last three commits. Fast-forward only means no new merge commit and nothing is overwritten, and it fails safely if the branches have diverged. It only changes the local branch, with no push. After this it should build the new version for you to try. Allow it?"}

Language came out right on all 27 runs of s1–s6 and x1–x3: x1 Chinese 3/3, x2 English
3/3, x3 Chinese 3/3. Before the "Nothing else counts" sentence was added (prompt v5), x2
came out Chinese on both runs.

## 5. Spoken

Each first-run brief above went to `https://tts.jasenpan.com/v1/audio/speech` as in
`deploy/tts-server/smoke-test.sh`: voice `serena`, the brief's `language`, the casual
`instructions` string from `voice-samples.sh` in that language, `response_format: wav`.
The calls went one at a time from `tts.py`. WAVs are in the job's scratch directory, not the
repo.

| Brief | Text | Audio | Synthesis |
|---|---|---|---|
| s1 finish, Chinese | 294 characters | 51.3 s | 20.7 s |
| s2 finish, English | 109 words | 46.7 s | 17.3 s |
| s3 permission, Chinese | 208 characters | 32.6 s | 12.4 s |
| s4 permission, English | 91 words | 37.4 s | 15.3 s |
| s5 decision, Chinese | 287 characters | 44.6 s | 16.6 s |
| s6 decision, English | 97 words | 40.3 s | 15.5 s |
| x2 permission, English | 86 words | 32.9 s | 12.6 s |

Three earlier briefs (prompt v4) measured the same way: 285 characters, 48.6 s audio, 18.1 s
synthesis; 119 words, 49.6 s, 18.4 s; 180 characters, 31.5 s, 12.1 s.

Serena speaks 5.7 to 6.4 Chinese characters or 2.3 to 2.6 English words a second. Synthesis takes
0.37 to 0.41 s per second of audio on the L4. Every brief fits the PRD's minute.

What still reads badly in the text: the dense Chinese finish (s1) kept `m3-ai`, `m2-ui`
and, in one of three runs, `hdiutil`, despite the rule and the self-check. The other
samples came out clean: no paths, flags, hashes or code, acronyms in capitals, Chinese
punctuation. One more thing seen in the residue runs: a session alias that looks like an id
(`residue-r1791380446x25003`) was shortened to "Residue" despite the "exactly as given"
exception. Real aliases (`eat-what`, `gomoku M2`, `Multi-Code`) were kept. Not checked by
ear: whether Serena reads `README`, `EPCC` or `eat-what` well. The builder should listen to
the seven WAVs.

## Findings that conflict with the kanban or PRD

1. **The speech timeout and the brief length don't fit together.** At 0.37 to 0.41 s of
   synthesis per second of audio, T-502's 15 s timeout (PRD Story 7, "in time is 15 seconds")
   allows about 37 to 40 s of audio. Five of the seven final briefs took longer than 15 s.
   A full-minute brief needs about 22 to 25 s. The prompt aims at 30 to 40 s, but dense turns
   still run 45 to 51 s. Choices: raise the timeout to about 30 s, scale it with the text
   length, or cap briefs at about 35 s and accept thinner briefs. The 15 s figure came from
   one 13 s brief on 2026-10-07.
2. **Story 2's "ready within 20 seconds" is likewise tight.** 4 to 7 s of writing plus 12
   to 21 s of speech is 16 to 28 s.
3. **The kanban's note on testing (1) is wrong for this Mac.** `open -a` from a shell
   passes the shell's env, so it behaves like `pnpm start`. Use Finder, the Dock or the
   launchd method above.
4. **The kanban's fallback points at something that doesn't exist.** `instance-env.ts`
   passes no Bedrock env; instances rely on the settings file too. The fallback, if ever
   needed, is to pass the three variables explicitly, measured to work.
5. **"The turn's transcript entries since that message (from `readTranscript`)" needs a
   second reader for the builder's messages.** See the input format above.
6. **For T-509:** `extractPromptDetail` keeps only an AskUserQuestion's first question, but
   real dialogs carry two or three (s5, s6). The brief covers all of them from `toolInput`.
   Mapping a spoken reply onto options will have to handle several questions too.

Not tested: what happens when the SSO token has expired. The user's settings carry
`awsAuthRefresh: aws sso login …`, and `buildEnv`'s PATH includes `/opt/homebrew/bin`. A
brief written while logged out might start an SSO login in the browser, or just fail with an
error in `result`.

## What T-504 should do

- **Spawn**: `child_process.spawn(command, args, { cwd: os.tmpdir(), env, stdio: "pipe" })`.
  `command` and `env` are what `claudeBackend.spawn()` returns. `buildEnv` is private today,
  so export it, for example as `claudeSpawnEnv()`; it already strips the inherited CLI
  markers and `MULTICODE_*` ids. `args`:
  `["-p", "--bare", "--no-session-persistence", "--model", "global.anthropic.claude-sonnet-5-5", "--output-format", "json", "--setting-sources", "user", "--tools", "", "--system-prompt", SYSTEM_PROMPT]`.
  The prompt goes in argv (no secrets in it); the transcript goes on stdin, where `ps`
  can't see it.
- **Stdin**: `JSON.stringify(input)` in the format above, then end the stream.
- **Truncate** before serializing: drop entries from the front of `turn` until the whole
  string is at most 60,000 characters, and set `turnEntriesDropped`. The builder's messages
  are separate fields, so they always survive.
- **Parse** stdout as JSON, even on a non-zero exit, because the CLI explains failures
  there. When `is_error` is true or the exit code isn't 0, return
  `{ ok: false, reason: result || stderr }` (seen: `Not logged in · Please run /login`,
  exit 1). Otherwise `JSON.parse(result)`, require `language` to be `"Chinese"` or
  `"English"` and `brief` a non-empty string, and ignore other keys. Anything else is a
  failure.
- **Timeout**: the observed maximum was 8.9 s at 75k tokens, so 60 s is generous. On
  timeout send SIGTERM, then SIGKILL after about 3 s. SIGTERM exits with 143 and cleans up
  the CLI's registry and plugin markers; SIGKILL leaves the plugin markers behind.
- **Live test** (skipped in CI): samples s1–s6 above, rebuilt from those lines with
  `build_inputs.cjs`.

Probe scripts, all in `.omt/probes/voice-secretary/t501/`: `launch-via-launchd.sh` and
`electron-probe/` (the Dock launch), `runner.cjs` and `run-dockenv.sh` (calls in the Dock
env), `build_inputs.cjs` and `extract_sample.cjs` (the samples), `gen_jobs.py` and
`summarize.py` (the variants and the contract check), `residue_watch.cjs` and
`kill_watch.cjs` (residue), `tts.py` (speech), `system-prompt-v1.txt`…`v7.txt`.

## Addendum, T-504: an expired SSO login

The question left open above, answered while building T-504 against the same CLI
(2.1.292): **a logged-out brief writer does run `awsAuthRefresh`**, so without an override it
would start `aws sso login` and open a browser on the builder's screen. T-504 passes
`--settings '{"awsAuthRefresh":"false"}'` (`secretary/cli.ts`), and the call then fails in
about 2 s with the CLI's credential error in `result`.

Measured without going near the real login: `sso_probe.cjs` in
`.omt/probes/voice-secretary/t504/` runs the brief writer's command under `env -i` with a fake
HOME (`CLAUDE_CONFIG_DIR`, `AWS_CONFIG_FILE` and `AWS_SHARED_CREDENTIALS_FILE` pointed into it
too). Its `~/.claude/settings.json` sets the Bedrock env for a fake SSO profile and an
`awsAuthRefresh` that only appends to a marker file. Its `~/.aws` holds that profile and a
cached SSO token that expired in 2020.

| `--settings` | What ran | Result |
|---|---|---|
| none | the user's refresh command, once | exit 1, `is_error`, `Could not load AWS credentials · …`, 1.8 s |
| `{"awsAuthRefresh": "<another command>"}` | that command, not the user's | the same, 2.0 s |
| `{"awsAuthRefresh": ""}` | nothing | the same, 1.9 s |
| `{"awsAuthRefresh": "false"}` | `false`; stderr `Error running awsAuthRefresh` | the same, 1.8 s |

So a key in `--settings` replaces the user file's, as the settings docs say. `false` was
chosen over `""`: the key is documented as "a shell command line" with the default "unset",
and nothing says how an empty string is treated, so a later CLI that rejected it could drop
the whole flag and bring the browser back. `awsCredentialExport` is not overridden: when set
it is the credential source itself, and this builder doesn't use it.

The real login happened to have expired during the work (token `expiresAt` 13:53 UTC, call at
14:03). One real call with the override returned `Token is expired` and ran `false`; no browser
opened. Fifteen minutes later the token had been renewed and the same calls succeeded.

## T-522 addendum: OpenCode's dialogs (prompt v8, 2026-10-08)

OpenCode sessions joined Milestone 1 (PRD v1.6). Their dialogs reach the brief writer as
`toolName` `bash`, `edit`, … for a permission (with `toolInput: {patterns, metadata}`, the
command in `metadata.command`) and `question` for a question box (`toolInput: {questions}`,
the same shape as AskUserQuestion's). v7 said "any toolName except AskUserQuestion and
ExitPlanMode" is a permission, so a question box would have been briefed as one. v8 changes
four phrases and nothing else (`.omt/probes/voice-secretary/t501/system-prompt-v8.txt`, diff
against v7): `question` is named beside AskUserQuestion twice, OpenCode's lowercase permission
names and `toolInput.metadata` are mentioned, and "Type your own answer" (OpenCode's automatic
choice) is left out like "Other". sha256 `9ebd3266…b1ce5`.

Re-run on the live CLI (`briefWriter.live.test.ts`, 2026-10-08): the six T-501 samples and
three OpenCode ones, all nine in the right language, opening with the session's name, 4.3–7.1 s.
The OpenCode samples are real personal sessions read by `readOpencodeBuilderTurn`
(`ai-nativ-sdlc`, Chinese, a version check; `mp-compare-ws`, English, a skills comparison) with
the dialog shaped exactly as `opencodeAttention` passes it: a finish, a bash permission to
delete a temp clone ("The delete is permanent, but it only touches a temporary copy in the temp
folder … Your own repo isn't touched. Do you want to allow it?"), and a two-question box read
question by question with its options and the recommended one, without "Type your own answer".

