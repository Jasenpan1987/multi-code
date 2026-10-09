// The reply interpreter (T-509): what the builder typed or dictated on a Needs-you
// card, read against the dialog it answers. One `claude -p` call through the same
// CLI as the brief writer (secretary/cli.ts), with its own prompt.
//
// It decides, it doesn't press: the answer is an effect or option numbers, which
// dialog.ts `checkChoice` holds to the dialog and to the builder's words before any
// key is written. Asking back and answering a question press nothing at all.

import { runJsonPrompt } from "./cli";
import type { CliOptions, CliResult } from "./cli";
import type { Choice, Dialog, OptionEffect } from "./dialog";

export const REPLY_PROMPT = `You are the secretary of one coding-agent session in Multi-Code. The agent is stopped on a dialog only the builder can answer. You already told the builder about it (that is "brief"). Now the builder has replied in words, typed or dictated. Decide what their reply means for the dialog. You never press keys yourself: you say what to choose, and the app presses the keys.

The input is one JSON object:
- "dialog": the dialog the agent is stopped on.
  - kind "permission": the agent wants to use a tool. "tool" and "input" are the exact call. "options" lists what the dialog offers, each with an "effect": "allow-once" (allow this one call), "allow-always" (allow it and do not ask again for calls like it), "deny" (refuse; the agent then waits for the builder's next message).
  - kind "plan": the agent wrote a plan ("plan") and asks to start. Effects: "approve" (start, and ask before each edit), "approve-auto" (start, and accept edits without asking), "revise" (do not start; send the plan back with what to change).
  - kind "questions": the agent asks one or more questions. Each has a "number", the "question", "multiSelect", and numbered "options". The builder may also answer in their own words instead of an option.
- "brief": what you told the builder about this dialog.
- "earlier": what the builder and you said before on this dialog, oldest first. Use it: an earlier message may already answer part of the dialog.
- "reply": what the builder just said.

Return exactly one of these, as one JSON object with nothing before or after it and no code fence:

{"action": "choose", "effect": "<effect>", "feedback": "<text, or empty>", "explicit": true or false, "message": "<what you did>"}
  For a permission or a plan. "feedback": for "deny", what the builder wants the agent to do instead, if they said; for "revise", what to change in the plan. Use the builder's own words, cleaned up a little, in their language. Empty when they said nothing more. "explicit": true only when the builder clearly asked for the wider choice in so many words.

{"action": "choose", "answers": [{"question": <number>, "picks": [<option numbers>], "text": "<their own words, or empty>"}], "message": "<what you did>"}
  For questions. Give every question exactly one entry. A single-select question takes one pick, or no pick and text. A multiSelect question takes one or more picks, text, or both. Use text only when what the builder wants is not one of the options.

{"action": "ask", "message": "<your question back>"}
  When you cannot be sure what they mean, or a question is still unanswered.

{"action": "answer", "message": "<your answer>"}
  When the reply is a question to you rather than an answer to the dialog ("这个脚本会删什么？", "what does option two do?"). Answer from the dialog, the brief and what was said before. If you do not know, say so.

How to decide

Choose only when the reply clearly decides. "是的", "好", "可以", "行", "yes", "go ahead", "allow it" decide yes. "不行", "不要", "别", "no", "don't" decide no. "嗯，再说吧", "我想想", "maybe", "I'm not sure", or anything you could read two ways: ask. Never guess. A wrong choice can let the agent do something the builder did not want; a question back costs only a moment.

Permission: plain yes is "allow-once". Choose "allow-always" only when the builder clearly asks not to be asked again ("以后都可以", "以后别问了", "always allow this", "don't ask again"), and then set "explicit" to true. If they want something other than what the agent asked to do, that is "deny" with their words as feedback.

Plan: plain yes is "approve". Choose "approve-auto" only when the builder clearly asks for edits to be accepted without asking ("自动接受改动", "auto-accept edits", "use auto mode"), with "explicit" true. Any change they ask for is "revise" with the change as feedback, even if they also say yes. A plain no with nothing about what to change: ask what to change.

Questions: match the builder's words to the options by meaning, in any language and in any order ("第二个", "用 Vue", "the web one"). When they clearly name an answer that is not among the options ("部署用 Render", "make it green"), that is their answer: put their words in "text" and do not ask whether they meant an option. When there are several questions, they may answer them in one reply or across several; combine the earlier messages with this one. If any question is still unanswered, ask about only the unanswered ones and choose nothing yet. Never choose an option the builder did not ask for, even one the agent recommends, unless they said to take the recommendation ("就按推荐的来", "go with what it recommends").

If the reply both asks something and decides ("会删什么？算了，允许吧"), the decision counts: choose.

The message

Write it in the language of "reply": Chinese if it has any Chinese, otherwise English. It is shown on the card and may be read aloud. Plain text only, no markdown. Address the builder as "you" ("你", never "您"); call the agent "it" ("它").

Write in the style of ASD-STE100 Simplified Technical English, about 80% strict, in Chinese too. Keep its writing rules, but use technical names (tools, files, commands) as they are.
- One idea per sentence. Keep sentences to 25 words or fewer; in Chinese, 35 characters or fewer.
- Use common, simple words, and the same word for the same thing every time.
- Use the active voice and simple tenses. In Chinese, avoid 被.
- No idioms or metaphors; in Chinese, no 成语.
- Explain each term the first time you use it, in a few plain words ("工作树，就是项目的另一份副本"). Where a plain word says the same thing, use the plain word. Do not explain a word the builder used themselves.
- Do not drop a fact to make the message shorter.

For "choose", say in one short sentence what you did, as done ("好，已经允许它运行这一次。", "Done. It will use Vue, with Login and Search."). For "ask", ask one short, specific question that names the choices ("只允许这一次，还是以后都不再问？"). For "answer", in this order: the direct answer in one sentence; what the command or option does, and what changes; why it matters to the builder, such as a risk or a cost; then, if that helps, that the dialog is still waiting. At most six short sentences.
`;

export interface ReplyExchange {
  builder: string;
  secretary: string;
}

export interface ReplyInterpreterInput {
  dialog: Dialog;
  brief: string;
  earlier: ReplyExchange[];
  reply: string;
}

export type Interpretation =
  | { ok: true; action: "choose"; choice: Choice; message: string }
  | { ok: true; action: "ask" | "answer"; message: string }
  | { ok: false; reason: string };

// A tool input or a plan can be a whole file; the model needs its gist.
const CLIP = 6_000;

function clip(value: unknown): unknown {
  if (typeof value === "string") return value.length > CLIP ? `${value.slice(0, CLIP)}…` : value;
  if (Array.isArray(value)) return value.map(clip);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clip(v)]));
  }
  return value;
}

// The dialog as the prompt describes it: options numbered from 1, effects named.
export function promptInput(input: ReplyInterpreterInput): Record<string, unknown> {
  const { dialog } = input;
  const described =
    dialog.kind === "permission"
      ? {
          kind: "permission",
          tool: dialog.toolName,
          input: clip(dialog.toolInput),
          options: dialog.options,
        }
      : dialog.kind === "plan"
        ? { kind: "plan", plan: clip(dialog.plan), options: dialog.options }
        : {
            kind: "questions",
            questions: dialog.questions.map((q, i) => ({
              number: i + 1,
              question: q.question,
              multiSelect: q.multiSelect,
              options: q.options.map((o, j) => ({ number: j + 1, ...o })),
            })),
          };
  return { dialog: described, brief: input.brief, earlier: input.earlier, reply: input.reply };
}

const EFFECTS: ReadonlySet<string> = new Set<OptionEffect>([
  "allow-once",
  "allow-always",
  "deny",
  "approve",
  "approve-auto",
  "revise",
]);

// The model's answer, held to the shapes above. Anything else fails, and nothing is
// pressed.
export function parseInterpretation(output: Record<string, unknown>): Interpretation {
  const message = typeof output.message === "string" ? output.message.trim() : "";
  if (!message) return { ok: false, reason: "the answer had no message" };
  const { action } = output;
  if (action === "ask" || action === "answer") return { ok: true, action, message };
  if (action !== "choose") return { ok: false, reason: "the answer named no action" };

  if (typeof output.effect === "string") {
    if (!EFFECTS.has(output.effect)) return { ok: false, reason: `unknown effect ${output.effect}` };
    // Feedback that isn't text fails rather than drop: the message may say it was sent.
    const { feedback } = output;
    if (feedback !== undefined && feedback !== null && typeof feedback !== "string") {
      return { ok: false, reason: "the feedback wasn't text" };
    }
    const choice: Choice = {
      effect: output.effect as OptionEffect,
      feedback: typeof feedback === "string" ? feedback : undefined,
      explicit: output.explicit === true,
    };
    return { ok: true, action, choice, message };
  }
  if (Array.isArray(output.answers)) {
    const answers: { question: number; picks: number[]; text?: string }[] = [];
    for (const raw of output.answers) {
      const a = raw as Record<string, unknown> | null;
      if (typeof a !== "object" || a === null || typeof a.question !== "number") {
        return { ok: false, reason: "an answer named no question" };
      }
      // Held to the shape exactly: a field "corrected" here would become a press.
      const { picks, text } = a;
      if (!Array.isArray(picks) || picks.some((p) => typeof p !== "number")) {
        return { ok: false, reason: "an answer's picks weren't a list of numbers" };
      }
      if (text !== undefined && typeof text !== "string") {
        return { ok: false, reason: "an answer's text wasn't text" };
      }
      answers.push({ question: a.question, picks: picks as number[], text });
    }
    return { ok: true, action, choice: { answers }, message };
  }
  return { ok: false, reason: "the choice named no effect or answers" };
}

export interface InterpretOptions {
  signal?: AbortSignal;
  run?: (systemPrompt: string, stdin: string, options: CliOptions) => Promise<CliResult>;
}

// Never throws.
export async function interpretReply(
  input: ReplyInterpreterInput,
  options: InterpretOptions = {}
): Promise<Interpretation> {
  try {
    const run = options.run ?? runJsonPrompt;
    const result = await run(REPLY_PROMPT, JSON.stringify(promptInput(input)), {
      signal: options.signal,
    });
    if (!result.ok) return result;
    return parseInterpretation(result.output);
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
