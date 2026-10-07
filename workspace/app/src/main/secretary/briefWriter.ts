// The brief writer (T-504): one secretary event in, one spoken-style brief out.
//
// For an instance's live Finished or Needs-you (T-503), it gathers what a secretary
// would need to brief the builder in person: the session's name, what the builder
// last asked, what happened since, and for a dialog the exact tool call and its
// options. One `claude -p` call (secretary/cli.ts) turns that into a brief the
// speech server can read aloud, written in the language of the builder's latest
// message. The language rule lives in the prompt, not here: the model sees the
// messages and reports which language it wrote in. Everything about the prompt,
// the input format and the limits was settled on the real CLI by the T-501 spike,
// docs/timeline/2026-10-08_brief-writer-spike.md.
//
// Nothing is written anywhere: the input goes to the CLI on stdin and the brief
// comes back to the orchestrator (secretary/index.ts), which keeps it in memory.

import { processManager } from "../process-manager";
import type { SecretaryEvent } from "../process-manager";
import { findJsonlBySessionId } from "../backends/claude";
import type { PromptOption, TranscriptEntry } from "../../shared/remote-protocol";
import type { BriefLanguage } from "../../shared/types";
import { ABORTED_REASON, runJsonPrompt } from "./cli";
import type { CliOptions, CliResult } from "./cli";
import { readBuilderTurn } from "./turn";
import type { BuilderTurn } from "./turn";

export type Brief =
  | { ok: true; language: BriefLanguage; text: string }
  | { ok: false; reason: string };

// What the CLI reads on stdin, as one compact JSON object. The prompt below
// describes every field to the model.
export interface BriefWriterInput {
  session: string;
  event: SecretaryEvent["kind"];
  // needs-you only, when the dialog decoded into options. An MCP elicitation has
  // none and is briefed from the turn alone.
  prompt?: {
    toolName: string;
    // Raw, as the PermissionRequest hook delivered it: for Bash, the command.
    toolInput: unknown;
    question?: string;
    // "Other" included; the prompt tells the model to leave it out.
    options: PromptOption[];
  };
  // "" when the session has no message the builder typed.
  builderLatestMessage: string;
  builderEarlierMessages: string[];
  turn: TranscriptEntry[];
  // Set when the front of `turn` was cut to fit.
  turnEntriesDropped?: number;
}

// About 30k tokens, which keeps a call around 5 to 6 s. The serialized input ran
// 1.7 to 2 characters per token in both languages.
export const INPUT_BUDGET_CHARS = 60_000;

// One pasted document or one file's contents in a Write's input must not take the
// whole budget, or overflow the model's window on its own. Applied to the builder's
// messages and to every string inside the tool input; the turn is cut by entries.
export const TEXT_CLIP_CHARS = 10_000;

// The spike's final prompt (v7), verbatim; briefWriter.test.ts pins its hash.
export const SYSTEM_PROMPT = `You are the secretary of one coding-agent session in Multi-Code. The builder you work for is away from the screen. When they come back and click the session, your brief is spoken to them by a text-to-speech voice. Write that brief: a secretary briefing a busy boss in person, not someone reading the screen aloud.

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

No file paths, URLs, commit hashes, ids, flags or command lines. Mention a file, branch, worktree, function or tool by name only when the builder needs the name, and then say it as words ("the manager agent branch", "the M2 UI worktree", "the NPM config file", "the macOS disk image tool"), never as written ("feat/manager-agent", "m2-ui", ".npmrc", "hdiutil"). No characters such as / \\ _ - . # @ ~ \` * > & | inside a word. The one exception is the session's name: always write it exactly as given.

Write anything said letter by letter in capitals, even a tool normally written in lowercase, in Chinese briefs too (NPM, PNPM, TSX, DMG, PR, UI, CLI: "NPM 配置", never "npm 配置"), but keep names people say as words (React, Vite, JSON, GitHub, esbuild). Write version numbers the way they are said ("version zero point five", "零点五版"), and round other numbers when the exact figure doesn't matter.

Length: aim for 30 to 40 seconds spoken: at most six sentences, about 150 to 200 Chinese characters or 70 to 100 English words. Never more than 250 characters or 130 words. Shorter is better when there is little to say. When there is more than fits, keep the outcome and what the builder has to do, and drop the rest.

Before answering, reread the brief as if hearing it: rewrite any word that holds / - _ . or mixes letters and digits in lowercase (m2-ui, dmg, hdiutil), and any sentence that only makes sense on screen.

Output

Return only a JSON object, with nothing before or after it and no code fence:
{"language": "Chinese" or "English", "brief": "<the brief>"}
Exactly these two keys, no others. "language" is the language the brief is written in.
`;

export interface BriefMaterial {
  session: string;
  event: SecretaryEvent;
  builderLatestMessage?: string;
  builderEarlierMessages: string[];
  turn: TranscriptEntry[];
}

export function buildBriefInput(
  material: BriefMaterial,
  budget: number = INPUT_BUDGET_CHARS
): BriefWriterInput {
  const prompt = material.event.prompt;
  const input: BriefWriterInput = {
    session: material.session,
    event: material.event.kind,
    ...(material.event.kind === "needs-you" && prompt
      ? {
          prompt: {
            toolName: prompt.toolName,
            toolInput: clipStrings(prompt.toolInput),
            question: prompt.detail.question,
            options: prompt.detail.options,
          },
        }
      : {}),
    builderLatestMessage: clipText(material.builderLatestMessage ?? ""),
    builderEarlierMessages: material.builderEarlierMessages.map(clipText),
    turn: material.turn,
  };
  return fitToBudget(input, budget);
}

// Drop entries from the front of `turn` until the serialized input fits, always
// keeping the last one: the agent's final message, or the tool it is stopped on.
// The builder's messages are fields of their own, so they always survive.
export function fitToBudget(input: BriefWriterInput, budget: number): BriefWriterInput {
  if (JSON.stringify(input).length <= budget) return input;

  const { turn } = input;
  // Sizes once, not a stringify per dropped entry: a long turn has thousands.
  // Counted against an upper bound of the drop count's own key, then confirmed.
  let total = JSON.stringify({ ...input, turnEntriesDropped: turn.length }).length;
  let dropped = 0;
  while (dropped < turn.length - 1 && total > budget) {
    total -= JSON.stringify(turn[dropped]).length + 1;
    dropped++;
  }
  let cut = withDropped(input, dropped);
  while (cut.turn.length > 1 && JSON.stringify(cut).length > budget) {
    dropped++;
    cut = withDropped(input, dropped);
  }
  return cut;
}

function withDropped(input: BriefWriterInput, dropped: number): BriefWriterInput {
  if (dropped === 0) return input;
  return { ...input, turn: input.turn.slice(dropped), turnEntriesDropped: dropped };
}

function clipText(text: string): string {
  if (text.length <= TEXT_CLIP_CHARS) return text;
  return `${text.slice(0, TEXT_CLIP_CHARS)}… [${text.length - TEXT_CLIP_CHARS} more characters]`;
}

function clipStrings(value: unknown): unknown {
  if (typeof value === "string") return clipText(value);
  if (Array.isArray(value)) return value.map(clipStrings);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [key, clipStrings(inner)])
    );
  }
  return value;
}

// The model's answer, held to the two keys the brief needs. Extra keys are
// ignored: the only way the strict shape broke in 142 spike runs was a third key.
export function parseBrief(output: Record<string, unknown>): Brief {
  const { language, brief } = output;
  if (language !== "Chinese" && language !== "English") {
    return { ok: false, reason: "the brief writer's answer named no language" };
  }
  if (typeof brief !== "string" || !brief.trim()) {
    return { ok: false, reason: "the brief writer's answer had no brief" };
  }
  return { ok: true, language, text: brief.trim() };
}

export interface WriteBriefOptions {
  signal?: AbortSignal;
  // The CLI call; tests fake it.
  run?: (systemPrompt: string, stdin: string, options: CliOptions) => Promise<CliResult>;
}

// The pure core: an input already gathered, one CLI call, one brief. Never throws.
export async function writeBrief(
  input: BriefWriterInput,
  options: WriteBriefOptions = {}
): Promise<Brief> {
  try {
    const run = options.run ?? runJsonPrompt;
    const result = await run(SYSTEM_PROMPT, JSON.stringify(input), { signal: options.signal });
    if (!result.ok) return result;
    return parseBrief(result.output);
  } catch (err) {
    return { ok: false, reason: reasonOf(err) };
  }
}

// What the orchestrator calls: gathers the material for the instance itself, then
// writes. Never throws. Aborting the signal kills the CLI and resolves
// { ok: false, reason: "aborted" }.
//
// With no transcript to read (no session found, or the file unreadable), a dialog
// is still briefed from the tool call and its options, which say what is being
// asked. A finished turn, or a dialog that didn't decode, with nothing since the
// builder's message is not: the model would have only the session's name, and a
// brief made of that would be invented.
export async function writeBriefFor(
  instanceId: string,
  event: SecretaryEvent,
  signal?: AbortSignal
): Promise<Brief> {
  try {
    if (signal?.aborted) return { ok: false, reason: ABORTED_REASON };
    const source = processManager.secretarySource(instanceId);
    if (!source) return { ok: false, reason: "no such session" };

    const jsonlPath = source.sessionId ? findJsonlBySessionId(source.sessionId) : null;
    const read: BuilderTurn | null = jsonlPath ? await readBuilderTurn(jsonlPath) : null;
    if (signal?.aborted) return { ok: false, reason: ABORTED_REASON };

    const turn = read ?? { builderEarlierMessages: [], turn: [] };
    if (turn.turn.length === 0 && !(event.kind === "needs-you" && event.prompt)) {
      return {
        ok: false,
        reason: read
          ? "nothing to brief from: the transcript has nothing since your last message"
          : "nothing to brief from: no transcript for this session",
      };
    }

    const input = buildBriefInput({ session: source.name, event, ...turn });
    return await writeBrief(input, { signal });
  } catch (err) {
    return { ok: false, reason: reasonOf(err) };
  }
}

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
