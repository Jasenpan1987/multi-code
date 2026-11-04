// What the phone sends to answer a dialog (PRD Story 5), and what it says about the
// answer once it is sent. Pure, so every shape of `answer` frame and every ack is
// tested on its own (answers.test.ts); components/DialogSlot.tsx draws them.
//
// The desktop holds every answer to the dialog with the secretary's checkChoice
// (main/secretary/dialog.ts), so the frames built here follow its rules exactly:
//   - a permission or plan is answered with one option's effect; a denial's reason
//     and a plan's "what to change" travel as `feedback`, and the plan's needs one;
//   - a question box is answered whole, every question in one frame, with 1-based
//     question and option numbers. A single-choice question takes one option or the
//     typed text, never both; a multiple-choice one any options plus the text;
//   - the two options that widen what the agent may do (`allow-always`,
//     `approve-auto`) are sent with `confirmed` only, after the phone's "Are you sure?".

import type {
  AnswerFrame,
  RemoteChoice,
  RemoteDialog,
  RemoteEffect,
  RemoteEffectOption,
  RemoteQuestion,
} from "../shared/remote-protocol";
import { instanceOf, type OutboxItem } from "./outbox";

type EffectDialog = Extract<RemoteDialog, { kind: "permission" | "plan" }>;
type QuestionsDialog = Extract<RemoteDialog, { kind: "questions" }>;

// secretary/dialog.ts ESCALATING: pressed only after "Are you sure?".
const WIDENING: ReadonlySet<RemoteEffect> = new Set(["allow-always", "approve-auto"]);

export const needsConfirm = (effect: RemoteEffect) => WIDENING.has(effect);

// What tapping an option opens before anything is sent: a field for a denial's
// reason (optional, and only where the reason reaches the agent) or for what a plan
// should change (required).
export function fieldOf(dialog: EffectDialog, effect: RemoteEffect): { required: boolean } | null {
  if (dialog.kind === "plan") return effect === "revise" ? { required: true } : null;
  return effect === "deny" && dialog.reasonAllowed ? { required: false } : null;
}

// The `answer` for one option of a permission or plan, with what was typed in its
// field. Null when it can't be sent: an option the dialog doesn't have, or a plan
// to revise with nothing said about what to change.
export function effectAnswer(
  dialog: EffectDialog,
  option: RemoteEffectOption,
  typed = ""
): { choice: RemoteChoice; confirmed: boolean } | null {
  if (!dialog.options.some((o) => o.effect === option.effect)) return null;
  const field = fieldOf(dialog, option.effect);
  const feedback = field ? typed.trim() : "";
  if (field?.required && !feedback) return null;
  return {
    choice: feedback ? { effect: option.effect, feedback } : { effect: option.effect },
    confirmed: needsConfirm(option.effect),
  };
}

// ---------------------------------------------------------------------------
// Question boxes
// ---------------------------------------------------------------------------

// One question's answer as the builder is putting it together. `picks` are 1-based
// option numbers in option order. `typing`: the "Type something" row is chosen (a
// radio for a single choice, a box for a multiple one); its `text` is kept while
// another row is chosen, so choosing the row again brings it back.
export interface QuestionPick {
  picks: number[];
  typing: boolean;
  text: string;
}

export const NO_PICK: QuestionPick = Object.freeze({ picks: [], typing: false, text: "" }) as QuestionPick;

// Option `n` (1-based) tapped: a single choice takes it alone, a multiple one
// ticks or unticks it.
export function tapOption(question: RemoteQuestion, pick: QuestionPick, n: number): QuestionPick {
  if (!question.multiSelect) return { ...pick, picks: [n], typing: false };
  const picks = pick.picks.includes(n) ? pick.picks.filter((p) => p !== n) : [...pick.picks, n].sort((a, b) => a - b);
  return { ...pick, picks };
}

// The "Type something" row tapped, or its field focused (`on`): a single choice
// takes it alone; a multiple one ticks it (or unticks it, on a tap of its box).
export function tapTyping(question: RemoteQuestion, pick: QuestionPick, on = !pick.typing): QuestionPick {
  if (!question.multiSelect) return { ...pick, picks: [], typing: true };
  return { ...pick, typing: on };
}

export const typeText = (pick: QuestionPick, text: string): QuestionPick => ({ ...pick, text });

// The text that goes with the answer: the row's, while it is chosen and says
// something.
export function typedOf(pick: QuestionPick): string | undefined {
  const text = pick.text.trim();
  return pick.typing && text ? text : undefined;
}

export const isAnswered = (pick: QuestionPick) => pick.picks.length > 0 || typedOf(pick) !== undefined;

// The one `answer` for the whole box, or null while a question is unanswered.
export function questionsAnswer(dialog: QuestionsDialog, picks: readonly QuestionPick[]): RemoteChoice | null {
  const answers: Extract<RemoteChoice, { answers: unknown }>["answers"] = [];
  for (let q = 0; q < dialog.questions.length; q++) {
    const pick = picks[q] ?? NO_PICK;
    const text = dialog.textAllowed ? typedOf(pick) : undefined;
    const chosen = dialog.questions[q].multiSelect ? pick.picks : pick.typing ? [] : pick.picks.slice(0, 1);
    if (chosen.length === 0 && !text) return null;
    answers.push(text ? { question: q + 1, picks: chosen, text } : { question: q + 1, picks: chosen });
  }
  return { answers };
}

// An answered question folded to one line: the options picked, in order, then the
// typed text in quotes.
export function answerLine(question: RemoteQuestion, pick: QuestionPick): string {
  const labels = pick.picks.map((p) => question.options[p - 1]?.label ?? `#${p}`);
  const text = typedOf(pick);
  return [...labels, ...(text ? [`“${text}”`] : [])].join(", ");
}

// Where "Next" goes from `page`: the first unanswered page after it, else the first
// before it. Null when no other page is unanswered: the button is "Submit answers"
// then, ready once this page is answered too.
export function nextPage(picks: readonly QuestionPick[], count: number, page: number): number | null {
  const open = (i: number) => i !== page && !isAnswered(picks[i] ?? NO_PICK);
  for (let i = page + 1; i < count; i++) if (open(i)) return i;
  for (let i = 0; i < page; i++) if (open(i)) return i;
  return null;
}

// ---------------------------------------------------------------------------
// After sending: the ack
// ---------------------------------------------------------------------------

// The newest answer the phone sent for an instance, whatever dialog it named.
export function lastAnswer(outbox: readonly OutboxItem[], id: string): OutboxItem | undefined {
  return outbox.findLast((i) => i.frame.type === "answer" && instanceOf(i) === id);
}

export const seqOf = (item: OutboxItem) => (item.frame as AnswerFrame).seq;

export interface AnswerNote {
  text: string;
  // A refusal or a doubt, drawn in red; else a plain status line.
  error: boolean;
  // Offer the terminal: the phone can't settle this itself.
  terminal: boolean;
}

// What the dialog slot shows of the last answer, for the dialog `seq` it shows:
//   locked — an answer to it is on its way or was taken: nothing more can be sent
//   closed — the Mac says it has gone: the card goes, the note stays
//   note   — a line about that answer, or about one sent to the dialog before it
// After a refusal or a doubt nothing is locked: the dialog may still be open, and
// an answer to one that isn't is refused (`gone`) without pressing anything.
export interface AnswerView {
  locked: boolean;
  closed: boolean;
  note: AnswerNote | null;
}

const FREE: AnswerView = { locked: false, closed: false, note: null };

export const ALREADY_ANSWERED = "This dialog was already answered.";
export const MAY_NOT_HAVE_ARRIVED = "Your answer may not have arrived. Check the session.";

export function answerView(item: OutboxItem | undefined, seq: number): AnswerView {
  if (!item || item.frame.type !== "answer") return FREE;
  if (seqOf(item) !== seq) {
    // The dialog the builder answered was replaced by this one before the answer
    // got there: nothing was pressed in this one.
    return item.status === "refused" && item.refusal?.reason === "gone"
      ? { ...FREE, note: { text: "That dialog was already answered. This is a new one.", error: false, terminal: false } }
      : FREE;
  }
  switch (item.status) {
    case "waiting":
    case "sent":
      return { locked: true, closed: false, note: { text: "Sending your answer…", error: false, terminal: false } };
    case "acked":
      return { locked: true, closed: false, note: { text: "Answered.", error: false, terminal: false } };
    case "unknown":
      return { ...FREE, note: { text: MAY_NOT_HAVE_ARRIVED, error: true, terminal: true } };
    case "refused":
      if (item.refusal?.reason === "gone") {
        return { locked: true, closed: true, note: { text: ALREADY_ANSWERED, error: false, terminal: false } };
      }
      return { ...FREE, note: { text: refusalText(item), error: true, terminal: true } };
  }
}

// Whether the slot showing dialog `seq` has said all there is to say about this
// answer, so the line above the compose box doesn't say it again once the dialog
// closes: a refusal of an answer to this dialog, or the `gone` of one to the
// dialog before it. A doubt (`unknown`) is never settled by being shown: whether
// the answer landed is still open after the dialog closes, so that line says it.
export function outcomeSaid(item: OutboxItem, seq: number): boolean {
  if (item.frame.type !== "answer" || item.status !== "refused") return false;
  return seqOf(item) === seq || item.refusal?.reason === "gone";
}

// The line the chat shows above the compose box for an answer whose outcome the
// dialog slot didn't say (it came after the dialog had closed, or is a doubt). Null
// for one that went through, or is still on its way.
export function closedNote(item: OutboxItem | undefined): AnswerNote | null {
  if (!item || item.frame.type !== "answer") return null;
  if (item.status === "unknown") return { text: MAY_NOT_HAVE_ARRIVED, error: true, terminal: true };
  if (item.status !== "refused") return null;
  if (item.refusal?.reason === "gone") return { text: ALREADY_ANSWERED, error: false, terminal: false };
  return { text: refusalText(item), error: true, terminal: true };
}

// The Mac's own words for a refusal.
function refusalText(item: OutboxItem): string {
  return item.refusal?.message || "Your Mac didn't take this answer.";
}

// `needs-confirm` should never come back: the phone asks "Are you sure?" before it
// sends a widening option, and sends it `confirmed`. The slot logs one that does.
export const isUnexpected = (item: OutboxItem | undefined) =>
  item?.status === "refused" && item.refusal?.reason === "needs-confirm";
