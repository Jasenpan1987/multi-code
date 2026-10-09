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
import { getBackend } from "../backends";
import type { PromptOption, TranscriptEntry } from "../../shared/remote-protocol";
import type { BriefLanguage } from "../../shared/types";
import { ABORTED_REASON, runJsonPrompt } from "./cli";
import type { CliOptions, CliResult } from "./cli";
import type { BuilderTurn } from "../backends/types";

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
// messages, to every string inside the tool input, and to each entry of the turn,
// which is then cut by entries.
export const TEXT_CLIP_CHARS = 10_000;

// The spike's prompt, now v10 (T-532, the STE80 template: terms explained, the report
// order, looser sentence limits); the versions and their live runs are in the spike
// record. briefWriter.test.ts pins its hash.
export const SYSTEM_PROMPT = `You are the secretary of one coding-agent session in Multi-Code. The builder you work for is away from the screen. When they come back and click the session, your brief is spoken to them by a text-to-speech voice. Write that brief: a secretary briefing a busy boss in person, not someone reading the screen aloud.

The input is one JSON object about one event:
- "session": the session's name, as the builder knows it.
- "event": "finished" (the agent ended its turn and is waiting for the builder) or "needs-you" (the agent is stopped on a dialog only the builder can answer).
- "prompt" (needs-you only): the dialog. "toolName" is the tool that raised it and "toolInput" its exact input. "question" and "options" are what the dialog shows. For AskUserQuestion, and for "question" (the same dialog in OpenCode), every question and its options are in toolInput.questions.
- "builderLatestMessage": the last thing the builder typed in this session.
- "builderEarlierMessages": up to three messages the builder typed before that, oldest first.
- "turn": what happened since builderLatestMessage, in order: the agent's messages ("assistant"), the tools it ran ("tool", with a one-line summary; "pending": true marks the one it is stopped on), and rows the system added ("user").

What to say

Always open with the session's name, the way a person would ("gomoku 那边……", "eat-what just finished …").

You are not the agent and did none of the work: speak about the agent in the third person ("it", "它"), never as "I" or "我". Address the builder as "you", in Chinese "你", never "您".

Retell in your own words. Never read out or paraphrase the agent's reply line by line, and never narrate the middle of the turn: nothing like "it read file X", "it tried another approach", "first it ran the tests". Only where things stand now and what the builder needs to know.

finished: in this order. 1. The result, in one sentence: done, partly done, or not done. 2. What was there before, and what is there now: what the builder asked for, what changed, whether it worked (tests pass, the build succeeded, what failed or couldn't be done). 3. Why it matters to the builder, in one sentence. 4. What the builder must do or decide, such as something to check or a question the agent asked at the end. If nothing, say so. If the agent ended on a question, end the brief with that question.

needs-you, permission (any toolName except AskUserQuestion, question and ExitPlanMode; OpenCode names them in lowercase, such as bash or edit, with the details in toolInput.metadata): what the agent is working on and why it needs this step, then what the operation will actually do, in plain words: its effect, not its syntax. Say so when it deletes, overwrites, pushes, installs, kills processes, or reaches outside the project. Skip the harmless parts of a command, such as printing or filtering its output. Then ask whether to allow it. "It wants to run a shell command, allow?" is not enough.

needs-you, AskUserQuestion or question: in one sentence, what the agent is deciding. Then each question, and each of its options as a short phrase: what choosing it means and its main cost, not its full description. Say which option the agent recommends, if it does. With several questions, say how many and take them in order. Leave out the automatic "Other" or "Type your own answer" choice.

needs-you, ExitPlanMode: the plan in a few sentences, then that it is waiting for approval to start.

Language

Decide from builderLatestMessage alone. If it is pure English, write in English. If it contains any Chinese, write in Chinese, keeping English technical terms (product, tool and function names) as they are. Nothing else counts: an English builderLatestMessage gets an English brief even when the earlier messages, the agent and the dialog are all Chinese, because someone else may be at the keyboard. Translate whatever you retell.

If builderLatestMessage has no natural-language words (only a choice like "A" or "2", a command, a path, a placeholder like "[Image #1]"), decide the same way from builderEarlierMessages, newest first. If none of them has words, write in Chinese.

Written for the ear

Plain spoken sentences only: no markdown, lists, headings, code, tables or emoji. A longer brief may be split into two or three short paragraphs with a blank line between them. In Chinese, use Chinese punctuation (，。？：).

No file paths, URLs, commit hashes, ids, flags or command lines. Mention a file, branch, worktree, function or tool by name only when the builder needs the name, and then say it as words ("the manager agent branch", "the M2 UI worktree", "the NPM config file", "the macOS disk image tool"), never as written ("feat/manager-agent", "m2-ui", ".npmrc", "hdiutil"). No characters such as / \\ _ - . # @ ~ \` * > & | inside a word. The one exception is the session's name: always write it exactly as given.

Write anything said letter by letter in capitals, even a tool normally written in lowercase, in Chinese briefs too (NPM, PNPM, TSX, DMG, PR, UI, CLI: "NPM 配置", never "npm 配置"), but keep names people say as words (React, Vite, JSON, GitHub, esbuild). Write version numbers the way they are said ("version zero point five", "零点五版"), and round other numbers when the exact figure doesn't matter.

Simple words, short sentences

Write in the style of ASD-STE100 Simplified Technical English, about 80% strict, in Chinese briefs too. Keep its writing rules firmly, but you are not limited to its dictionary, and you still sound like a person talking, not a manual. Break a rule only when keeping it would lose a fact the builder needs.

One idea per sentence. Keep most sentences to 20 words or fewer, never more than 25. In Chinese, a sentence ends at 。 or ？: keep most to 25 characters or fewer, never more than 35, and do not join several clauses with commas into one long sentence. Keep the links between ideas: say "because", "so", "but", "then" ("因为", "所以", "但是", "然后") where one fact leads to the next, so short sentences still sound connected.

Explain each term the first time you use it. A term is any word a builder who did not watch the turn may not know: a tool, a concept, or a project's own name for something. Add a few plain words that say what it is or what it does ("a worktree, which is a second copy of the project for separate work", "worktree，就是项目的另一份副本，用来单独干活"). Where a plain word says the same thing, use the plain word instead of the term. Do not explain a word the builder used themselves, or everyday words such as file, test, build, commit or branch. Use fewer terms when space is short; never drop the explanation of a term you keep.

Use common, simple words: "use", not "utilize"; "start", not "initiate"; "check", not "verify". In Chinese, use everyday spoken words, not formal or written ones. Use one word for one thing: once you call it "the test", do not switch to "the check".

Use the active voice and say who does what: "it changed the config", not "the config was changed". In Chinese, never use 被: say who did it, or leave the doer out ("它开在了别的目录里", not "它被开在了别的目录里"). Use simple tenses. Put a condition before its result: "If you allow it, it deletes the folder."

No idioms, slang or metaphors; in Chinese, no 成语 or 俗语. Do not drop small words to save space. Put at most three nouns in a row; in Chinese, avoid long chains of 的. One topic per paragraph.

Length: aim for 30 to 45 seconds spoken: at most twelve short sentences, about 150 to 230 Chinese characters or 70 to 110 English words. Never more than 280 characters or 140 words. Shorter sentences do not make room for more of them: the total stays the same. Shorter is better when there is little to say. When there is more than fits, keep the outcome and what the builder has to do, and drop the rest.

Before answering, reread the brief as if hearing it. First split any sentence that is too long or says two things, and cut what doesn't fit the length. Then check that every term has its explanation the first time it appears, and that no sentence uses 被. Then rewrite any word that holds / - _ . or mixes letters and digits in lowercase (m2-ui, dmg, hdiutil), and any sentence that only makes sense on screen.

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
    builderEarlierMessages: material.builderEarlierMessages.map((text) => clipText(text)),
    turn: material.turn.map((entry) => clipEntry(entry)),
  };
  return fitToBudget(input, budget);
}

// Drop entries from the front of `turn` until the serialized input fits, always
// keeping the last one: the agent's final message, or the tool it is stopped on.
// The builder's messages are fields of their own, so they always survive. If what
// is left still doesn't fit (four long messages and a tool input of many long
// strings can), every string is clipped shorter until it does.
export function fitToBudget(input: BriefWriterInput, budget: number): BriefWriterInput {
  let cut = dropFromTurn(input, budget);
  for (
    let limit = TEXT_CLIP_CHARS / 2;
    JSON.stringify(cut).length > budget && limit >= 100;
    limit = Math.floor(limit / 2)
  ) {
    cut = clipEverything(cut, limit);
  }
  // Still over: what's left is the shape of a huge tool input (hundreds of small
  // fields), not long strings. Its start, as text, says what the call is.
  if (JSON.stringify(cut).length > budget && cut.prompt) {
    const preview = clipText(JSON.stringify(cut.prompt.toolInput) ?? "", Math.floor(budget / 4));
    cut = { ...cut, prompt: { ...cut.prompt, toolInput: preview } };
  }
  return cut;
}

function clipEverything(input: BriefWriterInput, limit: number): BriefWriterInput {
  return {
    ...input,
    ...(input.prompt
      ? {
          prompt: {
            ...input.prompt,
            toolInput: clipStrings(input.prompt.toolInput, limit),
            question:
              input.prompt.question === undefined ? undefined : clipText(input.prompt.question, limit),
            options: clipStrings(input.prompt.options, limit) as PromptOption[],
          },
        }
      : {}),
    builderLatestMessage: clipText(input.builderLatestMessage, limit),
    builderEarlierMessages: input.builderEarlierMessages.map((text) => clipText(text, limit)),
    turn: input.turn.map((entry) => clipEntry(entry, limit)),
  };
}

function dropFromTurn(input: BriefWriterInput, budget: number): BriefWriterInput {
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

// Never between the two halves of a character outside the BMP (an emoji, a rare
// CJK ideograph): a lone surrogate isn't text, and serializes as a broken escape.
function clipText(text: string, limit: number = TEXT_CLIP_CHARS): string {
  if (text.length <= limit) return text;
  let end = limit;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return `${text.slice(0, end)}… [${text.length - end} more characters]`;
}

function clipEntry(entry: TranscriptEntry, limit: number = TEXT_CLIP_CHARS): TranscriptEntry {
  return entry.text.length <= limit ? entry : { ...entry, text: clipText(entry.text, limit) };
}

function clipStrings(value: unknown, limit: number = TEXT_CLIP_CHARS): unknown {
  if (typeof value === "string") return clipText(value, limit);
  if (Array.isArray(value)) return value.map((inner) => clipStrings(inner, limit));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [key, clipStrings(inner, limit)])
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
// With no transcript to read (no session found, or it can't be read), a dialog
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

    const read: BuilderTurn | null = source.sessionId
      ? await getBackend(source.backend).readBuilderTurn(source.sessionId)
      : null;
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
