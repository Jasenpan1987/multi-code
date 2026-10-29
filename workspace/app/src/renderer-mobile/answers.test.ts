// Every shape of `answer` the phone builds, checked against the secretary's own
// checkChoice (the desktop holds each answer to it), and what each ack means on
// screen.

import { describe, expect, it } from "vitest";
import { checkChoice, type Choice, type Dialog } from "../main/secretary/dialog";
import type { AnswerFrame, RemoteChoice, RemoteDialog, RemoteQuestion } from "../shared/remote-protocol";
import {
  ALREADY_ANSWERED,
  MAY_NOT_HAVE_ARRIVED,
  answerLine,
  answerView,
  closedNote,
  effectAnswer,
  fieldOf,
  isAnswered,
  isUnexpected,
  lastAnswer,
  needsConfirm,
  nextPage,
  NO_PICK,
  outcomeSaid,
  questionsAnswer,
  tapOption,
  tapTyping,
  typeText,
  type QuestionPick,
} from "./answers";
import type { OutboxItem, OutboxStatus } from "./outbox";

type Permission = Extract<RemoteDialog, { kind: "permission" }>;
type Plan = Extract<RemoteDialog, { kind: "plan" }>;
type Questions = Extract<RemoteDialog, { kind: "questions" }>;

const claudePermission = (reasonAllowed = true): Permission => ({
  kind: "permission",
  tool: "Bash",
  subject: "rm -rf dist && pnpm build",
  description: "Clean and rebuild the bundle",
  options: [
    { effect: "allow-once", label: "Yes" },
    { effect: "allow-always", label: "Yes, and don't ask again for rm commands in multi-code" },
    { effect: "deny", label: "No, and tell Claude what to do differently" },
  ],
  reasonAllowed,
});

const askRule: Permission = {
  kind: "permission",
  tool: "Bash",
  subject: "touch a.txt",
  options: [
    { effect: "allow-once", label: "Yes" },
    { effect: "deny", label: "No, and tell Claude what to do differently" },
  ],
  reasonAllowed: true,
};

const opencodePermission: Permission = {
  kind: "permission",
  tool: "bash",
  subject: "pnpm run deploy:preview",
  options: [
    { effect: "allow-once", label: "Allow once" },
    { effect: "allow-always", label: "Always allow", description: "OpenCode saves \"pnpm *\" for this project" },
    { effect: "deny", label: "Reject" },
  ],
  reasonAllowed: true,
};

const plan: Plan = {
  kind: "plan",
  plan: "## Plan\n\n1. Do it.",
  options: [
    { effect: "approve-auto", label: "Yes, auto-accept edits" },
    { effect: "approve", label: "Yes, manually approve edits" },
    { effect: "revise", label: "Tell Claude what to change" },
  ],
};

const storage: RemoteQuestion = {
  header: "Storage",
  question: "Where does the refresh token go?",
  multiSelect: false,
  options: [{ label: "httpOnly cookie" }, { label: "localStorage" }, { label: "Memory" }],
};
const clients: RemoteQuestion = {
  header: "Clients",
  question: "Which clients first?",
  multiSelect: true,
  options: [{ label: "Web" }, { label: "iOS" }, { label: "Android" }, { label: "Admin console" }],
};
const questions = (textAllowed = true, list = [storage, clients]): Questions => ({
  kind: "questions",
  questions: list,
  textAllowed,
});

// The desktop's view of the same dialog (remote-host.ts projects it from this).
function secretary(d: RemoteDialog, backend: "claude" | "opencode" = "claude"): Dialog {
  if (d.kind === "permission") return { kind: "permission", backend, toolName: d.tool, toolInput: {}, options: d.options };
  if (d.kind === "plan") return { kind: "plan", plan: d.plan, options: d.options };
  return { kind: "questions", backend, questions: d.questions };
}

// As remote-host.ts's choiceOf hands a phone's choice to checkChoice.
const asChoice = (choice: RemoteChoice): Choice => ("effect" in choice ? { ...choice, explicit: true } : choice);

function accepted(d: RemoteDialog, choice: RemoteChoice, confirmed = false, backend: "claude" | "opencode" = "claude") {
  return checkChoice(secretary(d, backend), asChoice(choice), confirmed);
}

const option = (d: Permission | Plan, effect: string) => d.options.find((o) => o.effect === effect)!;

describe("permission answers", () => {
  it("sends Yes as its effect alone, unconfirmed", () => {
    const d = claudePermission();
    const answer = effectAnswer(d, option(d, "allow-once"));
    expect(answer).toEqual({ choice: { effect: "allow-once" }, confirmed: false });
    expect(accepted(d, answer!.choice, answer!.confirmed).ok).toBe(true);
  });

  it("sends a denial with its reason as feedback, trimmed", () => {
    const d = claudePermission();
    const answer = effectAnswer(d, option(d, "deny"), "  use pnpm clean instead \n");
    expect(answer).toEqual({ choice: { effect: "deny", feedback: "use pnpm clean instead" }, confirmed: false });
    const checked = accepted(d, answer!.choice);
    expect(checked.ok && checked.plan.followUp).toBe("use pnpm clean instead");
  });

  it("sends a denial without a reason when none was typed", () => {
    const d = claudePermission();
    expect(effectAnswer(d, option(d, "deny"), "   ")).toEqual({ choice: { effect: "deny" }, confirmed: false });
    expect(effectAnswer(d, option(d, "deny"))).toEqual({ choice: { effect: "deny" }, confirmed: false });
  });

  it("opens a reason field for the denial only where the reason reaches the agent", () => {
    expect(fieldOf(claudePermission(true), "deny")).toEqual({ required: false });
    expect(fieldOf(claudePermission(false), "deny")).toBeNull();
    expect(fieldOf(claudePermission(true), "allow-once")).toBeNull();
    // Nothing typed can ride along where there is no field.
    const d = claudePermission(false);
    expect(effectAnswer(d, option(d, "deny"), "a reason")).toEqual({ choice: { effect: "deny" }, confirmed: false });
  });

  it("sends the wider option confirmed, and the desk takes it only so", () => {
    const d = claudePermission();
    const answer = effectAnswer(d, option(d, "allow-always"));
    expect(answer).toEqual({ choice: { effect: "allow-always" }, confirmed: true });
    expect(accepted(d, answer!.choice, true).ok).toBe(true);
    expect(accepted(d, answer!.choice, false)).toEqual({ ok: false, ask: "confirm-always" });
  });

  it("answers an ask rule's Yes / No box", () => {
    expect(effectAnswer(askRule, option(askRule, "allow-once"))).toEqual({ choice: { effect: "allow-once" }, confirmed: false });
    // An option the dialog doesn't have can't be sent.
    expect(effectAnswer(askRule, { effect: "allow-always", label: "Always" })).toBeNull();
  });

  it("answers OpenCode's Allow once / Always allow / Reject, a Reject's reason with it", () => {
    const d = opencodePermission;
    const once = effectAnswer(d, option(d, "allow-once"))!;
    expect(accepted(d, once.choice, once.confirmed, "opencode")).toMatchObject({
      ok: true,
      plan: { answer: { kind: "permission", decision: "once" } },
    });
    const always = effectAnswer(d, option(d, "allow-always"))!;
    expect(always.confirmed).toBe(true);
    expect(accepted(d, always.choice, always.confirmed, "opencode")).toMatchObject({
      ok: true,
      plan: { answer: { kind: "permission", decision: "always" } },
    });
    const reject = effectAnswer(d, option(d, "deny"), "not on Fridays")!;
    expect(reject.choice).toEqual({ effect: "deny", feedback: "not on Fridays" });
    expect(accepted(d, reject.choice, reject.confirmed, "opencode")).toMatchObject({
      ok: true,
      plan: { answer: { kind: "permission", decision: "reject", message: "not on Fridays" } },
    });
  });
});

describe("plan answers", () => {
  it("asks for confirmation of auto-accept only", () => {
    expect(needsConfirm("approve-auto")).toBe(true);
    expect(needsConfirm("allow-always")).toBe(true);
    for (const effect of ["approve", "revise", "allow-once", "deny"] as const) expect(needsConfirm(effect)).toBe(false);
  });

  it("sends approve-auto confirmed and approve plain", () => {
    const auto = effectAnswer(plan, option(plan, "approve-auto"))!;
    expect(auto).toEqual({ choice: { effect: "approve-auto" }, confirmed: true });
    expect(accepted(plan, auto.choice, true)).toEqual({ ok: true, plan: { keys: ["1"] } });
    expect(accepted(plan, auto.choice, false)).toEqual({ ok: false, ask: "confirm-auto" });
    const manual = effectAnswer(plan, option(plan, "approve"))!;
    expect(manual).toEqual({ choice: { effect: "approve" }, confirmed: false });
    expect(accepted(plan, manual.choice)).toEqual({ ok: true, plan: { keys: ["2"] } });
  });

  it("needs what to change before it revises", () => {
    expect(fieldOf(plan, "revise")).toEqual({ required: true });
    expect(fieldOf(plan, "approve")).toBeNull();
    expect(effectAnswer(plan, option(plan, "revise"), "")).toBeNull();
    expect(effectAnswer(plan, option(plan, "revise"), "  \n ")).toBeNull();
    const revise = effectAnswer(plan, option(plan, "revise"), " keep the old cookie for two weeks ")!;
    expect(revise).toEqual({ choice: { effect: "revise", feedback: "keep the old cookie for two weeks" }, confirmed: false });
    expect(accepted(plan, revise.choice)).toEqual({
      ok: true,
      plan: { keys: ["3", "keep the old cookie for two weeks", "\r"] },
    });
  });
});

describe("question answers", () => {
  const pickOf = (q: RemoteQuestion, ...taps: (number | "type" | { text: string })[]): QuestionPick =>
    taps.reduce<QuestionPick>(
      (p, tap) => (tap === "type" ? tapTyping(q, p) : typeof tap === "number" ? tapOption(q, p, tap) : typeText(tapTyping(q, p, true), tap.text)),
      NO_PICK
    );

  it("takes one option of a single choice, the last tapped", () => {
    const p = pickOf(storage, 2, 1);
    expect(p.picks).toEqual([1]);
    expect(isAnswered(p)).toBe(true);
  });

  it("ticks and unticks options of a multiple choice, kept in option order", () => {
    const p = pickOf(clients, 3, 1, 4, 4);
    expect(p.picks).toEqual([1, 3]);
    expect(isAnswered(pickOf(clients, 2, 2))).toBe(false);
  });

  it("sends every question in one answer, 1-based", () => {
    const d = questions();
    const choice = questionsAnswer(d, [pickOf(storage, 1), pickOf(clients, 2, 1)]);
    expect(choice).toEqual({
      answers: [
        { question: 1, picks: [1] },
        { question: 2, picks: [1, 2] },
      ],
    });
    const checked = accepted(d, choice!);
    expect(checked.ok && checked.plan.expect).toEqual({
      "Where does the refresh token go?": "httpOnly cookie",
      "Which clients first?": "Web, iOS",
    });
  });

  it("sends a single choice's typed text instead of an option", () => {
    const d = questions();
    // An option, then the "Type something" row: the row wins, and the option goes.
    const typed = pickOf(storage, 2, { text: " a signed cookie " });
    expect(typed.picks).toEqual([]);
    const choice = questionsAnswer(d, [typed, pickOf(clients, 1)]);
    expect(choice).toEqual({
      answers: [
        { question: 1, picks: [], text: "a signed cookie" },
        { question: 2, picks: [1] },
      ],
    });
    expect(accepted(d, choice!).ok).toBe(true);
    // An option tapped after typing takes over; the text is kept, but not sent.
    const back = tapOption(storage, typed, 3);
    expect(back).toMatchObject({ picks: [3], typing: false, text: " a signed cookie " });
    expect(questionsAnswer(d, [back, pickOf(clients, 1)])!).toEqual({
      answers: [
        { question: 1, picks: [3] },
        { question: 2, picks: [1] },
      ],
    });
  });

  it("sends a multiple choice's options and its typed text together", () => {
    const d = questions();
    const choice = questionsAnswer(d, [pickOf(storage, 1), pickOf(clients, 4, 2, { text: "Windows" })]);
    expect(choice).toEqual({
      answers: [
        { question: 1, picks: [1] },
        { question: 2, picks: [2, 4], text: "Windows" },
      ],
    });
    const checked = accepted(d, choice!);
    expect(checked.ok && checked.plan.expect?.["Which clients first?"]).toBe("iOS, Admin console, Windows");
    expect(accepted(d, choice!, false, "opencode")).toMatchObject({
      ok: true,
      plan: { answer: { kind: "form", answer: { q0: "httpOnly cookie", q1: ["iOS", "Admin console", "Windows"] } } },
    });
  });

  it("sends a multiple choice's typed text alone", () => {
    const d = questions();
    const choice = questionsAnswer(d, [pickOf(storage, 1), pickOf(clients, { text: "none yet" })]);
    expect(choice).toEqual({
      answers: [
        { question: 1, picks: [1] },
        { question: 2, picks: [], text: "none yet" },
      ],
    });
    expect(accepted(d, choice!).ok).toBe(true);
  });

  it("leaves out typed text whose box was unticked", () => {
    const p = tapTyping(clients, pickOf(clients, 1, { text: "Windows" }));
    expect(p.typing).toBe(false);
    expect(questionsAnswer(questions(), [pickOf(storage, 1), p])).toEqual({
      answers: [
        { question: 1, picks: [1] },
        { question: 2, picks: [1] },
      ],
    });
  });

  it("can't be sent with a question unanswered", () => {
    const d = questions();
    expect(questionsAnswer(d, [pickOf(storage, 1)])).toBeNull();
    expect(questionsAnswer(d, [pickOf(storage, 1), NO_PICK])).toBeNull();
    // The row chosen with nothing typed is no answer.
    expect(questionsAnswer(d, [pickOf(storage, "type"), pickOf(clients, 1)])).toBeNull();
    expect(questionsAnswer(d, [pickOf(storage, { text: "   " }), pickOf(clients, 1)])).toBeNull();
    // And the desk refuses what the phone won't send.
    expect(accepted(d, { answers: [{ question: 1, picks: [1] }] })).toEqual({ ok: false, ask: "unanswered" });
  });

  it("sends no text where the box takes none", () => {
    const d = questions(false);
    const choice = questionsAnswer(d, [pickOf(storage, 1), pickOf(clients, 2, { text: "Windows" })]);
    expect(choice).toEqual({
      answers: [
        { question: 1, picks: [1] },
        { question: 2, picks: [2] },
      ],
    });
  });

  it("answers a single question box", () => {
    const d = questions(true, [storage]);
    const choice = questionsAnswer(d, [pickOf(storage, 3)])!;
    expect(choice).toEqual({ answers: [{ question: 1, picks: [3] }] });
    expect(accepted(d, choice)).toEqual({ ok: true, plan: { keys: ["3"], expect: { [storage.question]: "Memory" } } });
  });

  it("folds an answered question to its picks and text", () => {
    expect(answerLine(storage, pickOf(storage, 1))).toBe("httpOnly cookie");
    expect(answerLine(clients, pickOf(clients, 2, 1, { text: "Windows" }))).toBe("Web, iOS, “Windows”");
    expect(answerLine(storage, pickOf(storage, { text: "a signed cookie" }))).toBe("“a signed cookie”");
  });

  it("goes on to the next unanswered page, and to Submit once no other page is open", () => {
    const one = pickOf(storage, 1);
    const two = pickOf(clients, 1);
    expect(nextPage([NO_PICK, NO_PICK], 2, 0)).toBe(1);
    expect(nextPage([one, NO_PICK], 2, 0)).toBe(1);
    expect(nextPage([one, NO_PICK, NO_PICK], 3, 1)).toBe(2);
    // Back on page 1 to edit, page 3 still open: Next skips the answered page 2.
    expect(nextPage([one, two, NO_PICK], 3, 0)).toBe(2);
    // An open page before this one is next once the later ones are done.
    expect(nextPage([NO_PICK, two], 2, 1)).toBe(0);
    expect(nextPage([one, two], 2, 1)).toBeNull();
    expect(nextPage([one, two], 2, 0)).toBeNull();
    // The last open page is this one: Submit, held until it is answered.
    expect(nextPage([one, NO_PICK], 2, 1)).toBeNull();
    expect(nextPage([NO_PICK], 1, 0)).toBeNull();
  });
});

describe("after sending", () => {
  const frame = (seq: number, clientMsgId = `m${seq}`): AnswerFrame => ({
    type: "answer",
    instanceId: "s1",
    seq,
    choice: { effect: "allow-once" },
    clientMsgId,
  });
  const item = (status: OutboxStatus, seq = 7, refusal?: OutboxItem["refusal"]): OutboxItem => ({
    frame: frame(seq),
    createdAt: 1,
    status,
    sentOnce: true,
    ...(refusal ? { refusal } : {}),
  });

  it("finds the session's newest answer, whatever dialog it named", () => {
    const prompt: OutboxItem = {
      frame: { type: "prompt", instanceId: "s1", text: "hi", clientMsgId: "p" },
      createdAt: 3,
      status: "acked",
      sentOnce: true,
    };
    const other: OutboxItem = { ...item("sent", 9), frame: { ...frame(9), instanceId: "s2" } };
    const older = item("acked", 6);
    const newer = item("refused", 7, { reason: "gone", message: "x" });
    expect(lastAnswer([older, newer, prompt, other], "s1")).toBe(newer);
    expect(lastAnswer([prompt], "s1")).toBeUndefined();
  });

  it("locks the dialog while the answer is on its way and once it is taken", () => {
    expect(answerView(undefined, 7)).toEqual({ locked: false, closed: false, note: null });
    expect(answerView(item("sent"), 7)).toMatchObject({ locked: true, closed: false, note: { error: false } });
    expect(answerView(item("acked"), 7)).toMatchObject({ locked: true, closed: false, note: { text: "Answered." } });
  });

  it("closes the card on gone: the dialog was already answered", () => {
    const view = answerView(item("refused", 7, { reason: "gone", message: "This dialog is no longer open" }), 7);
    expect(view).toEqual({ locked: true, closed: true, note: { text: ALREADY_ANSWERED, error: false, terminal: false } });
  });

  it("shows the Mac's message and the terminal for failed and unsupported, and lets the builder try again", () => {
    for (const reason of ["failed", "unsupported", "not-running"] as const) {
      const view = answerView(item("refused", 7, { reason, message: `msg ${reason}` }), 7);
      expect(view).toEqual({ locked: false, closed: false, note: { text: `msg ${reason}`, error: true, terminal: true } });
    }
  });

  it("says an answer whose link dropped may not have arrived", () => {
    expect(answerView(item("unknown"), 7)).toEqual({
      locked: false,
      closed: false,
      note: { text: MAY_NOT_HAVE_ARRIVED, error: true, terminal: true },
    });
  });

  it("flags needs-confirm, which should never come back", () => {
    const refused = item("refused", 7, { reason: "needs-confirm", message: "Confirm first" });
    expect(isUnexpected(refused)).toBe(true);
    expect(answerView(refused, 7)).toMatchObject({ locked: false, note: { text: "Confirm first", error: true, terminal: true } });
    expect(isUnexpected(item("refused", 7, { reason: "failed", message: "" }))).toBe(false);
    expect(isUnexpected(item("acked"))).toBe(false);
  });

  it("leaves a newer dialog free, saying when the answer went to the one it replaced", () => {
    expect(answerView(item("acked", 6), 7)).toEqual({ locked: false, closed: false, note: null });
    expect(answerView(item("sent", 6), 7)).toEqual({ locked: false, closed: false, note: null });
    expect(answerView(item("refused", 6, { reason: "gone", message: "A new dialog came up" }), 7)).toMatchObject({
      locked: false,
      closed: false,
      note: { text: "That dialog was already answered. This is a new one." },
    });
  });

  it("counts a refusal shown in the slot as said, never a doubt", () => {
    // A refusal of this dialog's answer, or the gone of the one before it.
    expect(outcomeSaid(item("refused", 7, { reason: "failed", message: "x" }), 7)).toBe(true);
    expect(outcomeSaid(item("refused", 7, { reason: "gone", message: "x" }), 7)).toBe(true);
    expect(outcomeSaid(item("refused", 6, { reason: "gone", message: "x" }), 7)).toBe(true);
    // Another refusal of an earlier dialog's answer isn't drawn on this one.
    expect(outcomeSaid(item("refused", 6, { reason: "failed", message: "x" }), 7)).toBe(false);
    // Whether it landed is still open once the dialog closes: said again there.
    expect(outcomeSaid(item("unknown", 7), 7)).toBe(false);
    expect(outcomeSaid(item("sent", 7), 7)).toBe(false);
    expect(outcomeSaid(item("acked", 7), 7)).toBe(false);
  });

  it("says above the compose box what became of an answer once its dialog closed", () => {
    expect(closedNote(undefined)).toBeNull();
    expect(closedNote(item("sent"))).toBeNull();
    expect(closedNote(item("acked"))).toBeNull();
    expect(closedNote(item("refused", 7, { reason: "gone", message: "x" }))).toEqual({
      text: ALREADY_ANSWERED,
      error: false,
      terminal: false,
    });
    expect(closedNote(item("refused", 7, { reason: "failed", message: "check the terminal" }))).toEqual({
      text: "check the terminal",
      error: true,
      terminal: true,
    });
    expect(closedNote(item("unknown"))).toMatchObject({ text: MAY_NOT_HAVE_ARRIVED, terminal: true });
  });
});
