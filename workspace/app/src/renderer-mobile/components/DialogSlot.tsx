// What sits in place of the compose box and the working bar while the session is
// stopped on a dialog (PRD Story 5; mockups 3.1–3.3): there is no compose box then,
// so typed text never lands in the dialog, and no Stop, since Esc would answer it.
//
//   - A permission is a card docked at the bottom: the tool, what it acts on, the
//     CLI's description, "Do you want to proceed?" and one button per option.
//   - A question box and a plan are sheets over the chat, which can be pulled down
//     to read the chat (and are then a bar at the bottom) and pulled up again.
//   - A dialog the phone can't draw, or one whose prompt-state hasn't come yet, says
//     so and offers the terminal.
//
// answers.ts builds every `answer` frame and says what each ack means; this file
// only draws them. Answers go out on an open link or not at all, so with no link
// nothing can be pressed.

import { useCallback, useEffect, useRef, useState, type ReactNode, type TouchEvent } from "react";
import type { RemoteChoice, RemoteDialog, RemoteEffectOption } from "../../shared/remote-protocol";
import {
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
  type AnswerNote,
  type QuestionPick,
} from "../answers";
import { idOf, type OutboxItem } from "../outbox";
import { navigate } from "../routes";
import type { OpenDialog } from "../state";
import { useActions, useApp } from "../store";
import { Markdown } from "./Markdown";
import "./dialog-slot.css";

export interface DialogSlotProps {
  // The instance the dialog belongs to.
  id: string;
  // The last `prompt-state` (seq, summary and, when the phone can draw it, the
  // dialog in full). Null while the list says Needs you but no prompt-state has
  // arrived yet (it comes right after subscribe): nothing can be answered then.
  dialog: OpenDialog | null;
  // One line: the dialog's summary, else the list row's preview.
  summary: string;
}

type EffectDialog = Extract<RemoteDialog, { kind: "permission" | "plan" }>;
type QuestionsDialog = Extract<RemoteDialog, { kind: "questions" }>;

// The protocol carries no question line for a permission: Claude's own wording,
// for every permission card (T-808's note).
const PERMISSION_QUESTION = "Do you want to proceed?";

// What the card's top line calls a tool's call, as Claude's own dialog titles do.
const TOOL_TITLES: Record<string, string> = {
  bash: "Bash command",
  shell: "Shell command",
  edit: "Edit file",
  multiedit: "Edit file",
  write: "Write file",
  notebookedit: "Edit notebook",
  webfetch: "Fetch",
};

const toolTitle = (tool: string) => TOOL_TITLES[tool.toLowerCase()] ?? tool;

// Answers whose refusal the slot has had on screen (answers.ts `outcomeSaid`), so
// the line above the compose box (AnswerOutcome) doesn't say it again once the
// dialog has closed; and the unexpected refusals already logged. For the life of
// the page, like the drafts.
const shownOutcomes = new Set<string>();
const logged = new Set<string>();

export function DialogSlot({ id, dialog, summary }: DialogSlotProps) {
  const actions = useActions();
  const online = useApp((s) => s.connection.state === "connected");
  const backend = useApp((s) => s.instances?.find((i) => i.id === id)?.backend);
  const item = useApp((s) => lastAnswer(s.outbox, id));
  const agent = backend === "opencode" ? "OpenCode" : "Claude";
  const terminal = () => navigate({ screen: "terminal", id });

  const seq = dialog?.seq;
  const view = seq !== undefined ? answerView(item, seq) : null;
  // A refusal on screen here (in the card, the sheet, or the bar a pulled-down sheet
  // leaves) needn't be said again above the compose box. The loading and "can't
  // show" cards say nothing of answers.
  const drawn = dialog?.dialog !== undefined;
  useEffect(() => {
    if (!item || seq === undefined) return;
    if (drawn && outcomeSaid(item, seq)) shownOutcomes.add(idOf(item));
    if (isUnexpected(item) && !logged.has(idOf(item))) {
      logged.add(idOf(item));
      console.warn(`Multi-Code: the Mac asked to confirm an answer the phone had confirmed: ${item.refusal?.message}`);
    }
  }, [item, seq, drawn]);

  if (!dialog) {
    return (
      <Dock kind="loading">
        <NeedsYou />
        <p className="q">{summary}</p>
        <p className="desc">Loading the dialog…</p>
        <button className="btn ghost block" onClick={terminal}>
          Open terminal
        </button>
      </Dock>
    );
  }
  const full = dialog.dialog;
  if (!full) {
    return (
      <Dock kind="none">
        <NeedsYou />
        <p className="q">{summary}</p>
        <p className="desc">The phone can't show this dialog. Answer it in the terminal.</p>
        <button className="btn primary block" onClick={terminal}>
          Open terminal
        </button>
      </Dock>
    );
  }
  if (view?.closed) {
    return (
      <Dock kind="closed">
        <Notes note={view.note} online onTerminal={terminal} />
      </Dock>
    );
  }

  const answer = (choice: RemoteChoice, confirmed: boolean) => actions.answer(id, dialog.seq, choice, confirmed);
  const props = {
    id,
    seq: dialog.seq,
    agent,
    locked: view?.locked ?? false,
    online,
    notes: <Notes note={view?.note ?? null} online={online} onTerminal={terminal} />,
  };
  // Keyed by seq: a new dialog starts from nothing, whatever was put together for
  // the one before.
  switch (full.kind) {
    case "permission":
      return <PermissionCard key={dialog.seq} {...props} dialog={full} send={answer} />;
    case "plan":
      return <PlanSheet key={dialog.seq} {...props} dialog={full} send={answer} />;
    case "questions":
      return <QuestionSheet key={dialog.seq} {...props} dialog={full} send={answer} />;
  }
}

// What became of the last answer, above the compose box once its dialog has closed:
// a refusal that came after the card had gone (the desk answered first), or a doubt
// (the link dropped before the ack), which the dialog closing doesn't settle.
export function AnswerOutcome({ id }: { id: string }) {
  const actions = useActions();
  const outbox = useApp((s) => s.outbox);
  const item = lastAnswer(outbox, id);
  const note = item && !shownOutcomes.has(idOf(item)) ? closedNote(item) : null;
  if (!item || !note) return null;
  // Every settled answer of this session goes, so an older one doesn't take its place.
  const dismiss = () => {
    for (const i of outbox) {
      if (i.frame.type === "answer" && i.frame.instanceId === id && i.status !== "sent") actions.dismiss(idOf(i));
    }
  };
  return (
    <div className={note.error ? "answer-outcome err" : "answer-outcome"} role="status">
      <span className="t">{note.text}</span>
      {note.terminal && (
        <button className="link" onClick={() => navigate({ screen: "terminal", id })}>
          Terminal
        </button>
      )}
      <button className="link" onClick={dismiss}>
        Dismiss
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// What the builder has put together, per dialog
// ---------------------------------------------------------------------------

interface Draft {
  // The option whose field (a reason, what to change) or "Are you sure?" is open.
  open: RemoteEffectOption["effect"] | null;
  // What is typed in that field.
  text: string;
  // A question box's page (0-based) and each question's answer so far.
  page: number;
  picks: QuestionPick[];
  // A sheet pulled down to read the chat.
  collapsed: boolean;
}

const NEW_DRAFT: Draft = { open: null, text: "", page: 0, picks: [], collapsed: false };

// One draft per instance, for its open dialog's seq, for the life of the page: the
// terminal and back finds it as it was, and a new dialog starts afresh.
const drafts = new Map<string, { seq: number; draft: Draft }>();

function useDraft(id: string, seq: number): [Draft, (change: Partial<Draft>) => void] {
  const [draft, setDraft] = useState<Draft>(() => {
    const kept = drafts.get(id);
    return kept?.seq === seq ? kept.draft : NEW_DRAFT;
  });
  const update = (change: Partial<Draft>) => {
    const next = { ...draft, ...change };
    drafts.set(id, { seq, draft: next });
    setDraft(next);
  };
  return [draft, update];
}

interface ViewProps<D> {
  id: string;
  seq: number;
  dialog: D;
  agent: string;
  // An answer is on its way, or was taken.
  locked: boolean;
  online: boolean;
  notes: ReactNode;
  send: (choice: RemoteChoice, confirmed: boolean) => OutboxItem | null;
}

// ---------------------------------------------------------------------------
// Permission (mockup 3.1)
// ---------------------------------------------------------------------------

function PermissionCard(props: ViewProps<Extract<RemoteDialog, { kind: "permission" }>>) {
  const { dialog } = props;
  const [draft, update] = useDraft(props.id, props.seq);
  return (
    <Dock kind="permission">
      <NeedsYou title={toolTitle(dialog.tool)} />
      {dialog.subject && <pre className="cmd">{dialog.subject}</pre>}
      {dialog.description && <div className="desc">{dialog.description}</div>}
      <div className="q">{PERMISSION_QUESTION}</div>
      <EffectOptions {...props} draft={draft} update={update} />
      {props.notes}
    </Dock>
  );
}

// ---------------------------------------------------------------------------
// Plan (mockup 3.3)
// ---------------------------------------------------------------------------

function PlanSheet(props: ViewProps<Extract<RemoteDialog, { kind: "plan" }>>) {
  const [draft, update] = useDraft(props.id, props.seq);
  const [end, setEnd] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  // The fade says there is more below, until there isn't.
  const measure = useCallback(() => {
    const el = scroller.current;
    if (el) setEnd(el.scrollHeight - el.scrollTop - el.clientHeight < 4);
  }, []);
  useEffect(measure, [measure, props.dialog.plan, draft.collapsed, draft.open]);

  return (
    <Sheet
      kind="plan"
      collapsed={draft.collapsed}
      onCollapse={(collapsed) => update({ collapsed })}
      title={<b>Plan ready for review</b>}
      notes={props.notes}
    >
      <div className="plan-wrap">
        <div className="plan" ref={scroller} onScroll={measure}>
          {props.dialog.plan.trim() ? (
            <Markdown text={props.dialog.plan} />
          ) : (
            <p className="empty-plan">{props.agent} didn't write the plan out.</p>
          )}
        </div>
        {!end && <div className="fade" />}
      </div>
      {props.notes}
      <EffectOptions {...props} draft={draft} update={update} />
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// The options of a permission or a plan, with a field or "Are you sure?" when the
// option tapped needs one first
// ---------------------------------------------------------------------------

function EffectOptions({
  dialog,
  agent,
  locked,
  online,
  send,
  draft,
  update,
}: ViewProps<EffectDialog> & { draft: Draft; update: (change: Partial<Draft>) => void }) {
  const open = draft.open ? dialog.options.find((o) => o.effect === draft.open) : undefined;
  const disabled = locked || !online;
  const submit = (option: RemoteEffectOption) => {
    const answer = effectAnswer(dialog, option, draft.text);
    if (answer) send(answer.choice, answer.confirmed);
  };

  if (open && needsConfirm(open.effect)) {
    const explain =
      open.description ??
      (dialog.kind === "plan"
        ? `${agent} will make its edits without asking you.`
        : `${agent} won't ask again before calls like this one.`);
    return (
      <div className="sure">
        <div className="ct">Are you sure?</div>
        <div className="cl">{open.label}</div>
        <div className="cd">{explain}</div>
        <div className="btns">
          <button className="btn ghost" disabled={locked} onClick={() => update({ open: null })}>
            Cancel
          </button>
          <button className="btn primary" disabled={disabled} onClick={() => submit(open)}>
            Yes, I'm sure
          </button>
        </div>
      </div>
    );
  }

  const field = open ? fieldOf(dialog, open.effect) : null;
  if (open && field) {
    const placeholder =
      dialog.kind === "plan"
        ? `What should ${agent} change?`
        : `Tell ${agent} why, or what to do instead (optional)`;
    return (
      <div className="field">
        <div className="fl">{open.label}</div>
        <textarea
          className="reason"
          value={draft.text}
          rows={2}
          placeholder={placeholder}
          aria-label={open.label}
          autoFocus
          disabled={locked}
          onChange={(e) => update({ text: e.target.value })}
        />
        <div className="btns">
          <button className="btn ghost" disabled={locked} onClick={() => update({ open: null })}>
            Cancel
          </button>
          <button
            className="btn danger solid"
            disabled={disabled || (field.required && !draft.text.trim())}
            onClick={() => submit(open)}
          >
            Send
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="stack">
      {dialog.options.map((option, i) => {
        const opens = needsConfirm(option.effect) || fieldOf(dialog, option.effect) !== null;
        const danger = option.effect === "deny" || option.effect === "revise";
        // Mockup 3.1: the permission's first option centred, the rest left-aligned
        // as the CLI's longer labels read; a plan's three all left-aligned.
        const left = dialog.kind === "plan" || i > 0 || option.description !== undefined;
        const className = ["btn", "block", "opt-btn", i === 0 ? "primary" : danger ? "danger" : "", left ? "left" : ""]
          .filter(Boolean)
          .join(" ");
        return (
          <button
            key={option.effect}
            className={className}
            disabled={disabled}
            onClick={() => (opens ? update({ open: option.effect }) : submit(option))}
          >
            <span className="ol" data-more={fieldOf(dialog, option.effect) ? "" : undefined}>
              {option.label}
            </span>
            {option.description && !needsConfirm(option.effect) && <span className="od">{option.description}</span>}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Questions (mockup 3.2)
// ---------------------------------------------------------------------------

function QuestionSheet(props: ViewProps<QuestionsDialog>) {
  const { dialog, locked, online } = props;
  const [draft, update] = useDraft(props.id, props.seq);
  const count = dialog.questions.length;
  const page = Math.min(draft.page, count - 1);
  const picks = dialog.questions.map((_, i) => draft.picks[i] ?? NO_PICK);
  const question = dialog.questions[page];
  const pick = picks[page];
  const next = nextPage(picks, count, page);
  const choice = questionsAnswer(dialog, picks);
  const setPick = (value: QuestionPick) => update({ picks: picks.map((p, i) => (i === page ? value : p)) });
  const multi = question.multiSelect;
  const role = multi ? "checkbox" : "radio";
  const rule = multi ? "pick any" : "pick one";

  const folded = (from: number, to: number) =>
    dialog.questions.slice(from, to).map((q, offset) => {
      const i = from + offset;
      if (!isAnswered(picks[i])) return null;
      return (
        <div className="answered" key={i}>
          <span className="ok">✓</span>
          <span className="h">{q.header ?? `Question ${i + 1}`}</span>
          <span className="v">{answerLine(q, picks[i])}</span>
          <button className="e" disabled={locked} onClick={() => update({ page: i })}>
            Edit
          </button>
        </div>
      );
    });

  return (
    <Sheet
      kind="questions"
      collapsed={draft.collapsed}
      onCollapse={(collapsed) => update({ collapsed })}
      notes={props.notes}
      title={
        <>
          <b>{props.agent} is asking</b>
          <span>· {count === 1 ? "1 question" : `${count} questions`}</span>
        </>
      }
    >
      <div className="sheet-body">
        {folded(0, page)}
        <div className="qhead">
          {question.header && <span className="qtag">{question.header}</span>}
          <span className="qstep">{count > 1 ? `${page + 1} / ${count} · ${rule}` : rule}</span>
        </div>
        <div className="qtext">{question.question}</div>
        <div className="opts" role={multi ? "group" : "radiogroup"} aria-label={question.question}>
          {question.options.map((option, i) => {
            const on = pick.picks.includes(i + 1);
            return (
              <button
                key={i}
                className="opt"
                role={role}
                aria-checked={on}
                disabled={locked}
                onClick={() => setPick(tapOption(question, pick, i + 1))}
              >
                <Box multi={multi} on={on} />
                <span className="ot">
                  <span className="ol">{option.label}</span>
                  {option.description && <span className="od">{option.description}</span>}
                </span>
              </button>
            );
          })}
          {dialog.textAllowed && (
            <div className="opt type" data-on={pick.typing || undefined}>
              <button
                className="tbox"
                role={role}
                aria-checked={pick.typing}
                aria-label="Type something"
                disabled={locked}
                onClick={() => setPick(tapTyping(question, pick))}
              >
                <Box multi={multi} on={pick.typing} />
              </button>
              <input
                type="text"
                value={pick.text}
                placeholder="Type something…"
                aria-label={`${question.question}: type something`}
                enterKeyHint="done"
                disabled={locked}
                onFocus={() => {
                  if (!pick.typing) setPick(tapTyping(question, pick, true));
                }}
                onChange={(e) => setPick(typeText(tapTyping(question, pick, true), e.target.value))}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.nativeEvent.isComposing) e.currentTarget.blur();
                }}
              />
            </div>
          )}
        </div>
        {folded(page + 1, count)}
      </div>
      {props.notes}
      <div className="btns nav">
        {page > 0 && (
          <button className="btn ghost back" disabled={locked} onClick={() => update({ page: page - 1 })}>
            Back
          </button>
        )}
        {next !== null ? (
          <button
            className="btn primary go"
            disabled={locked || !isAnswered(pick)}
            onClick={() => update({ page: next })}
          >
            Next
          </button>
        ) : (
          <button
            className="btn primary go"
            disabled={locked || !online || !choice}
            onClick={() => choice && props.send(choice, false)}
          >
            Submit answers
          </button>
        )}
      </div>
    </Sheet>
  );
}

function Box({ multi, on }: { multi: boolean; on: boolean }) {
  return (
    <span className={`box${multi ? "" : " radio"}${on ? " on" : ""}`} aria-hidden>
      {multi && on ? "✓" : ""}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Frames: the docked card, the sheet, and the lines under them
// ---------------------------------------------------------------------------

function Dock({ kind, children }: { kind: string; children: ReactNode }) {
  return (
    <div className="dialog-slot dock" data-kind={kind}>
      {children}
    </div>
  );
}

function NeedsYou({ title }: { title?: string }) {
  return (
    <div className="kind">
      <span className="dot red" />
      NEEDS YOU
      {title && <span className="m">{title}</span>}
    </div>
  );
}

// How far a finger must move on the handle to pull the sheet down or up.
const PULL_PX = 30;

// A sheet over the chat (mockups 3.2, 3.3), and the bar it leaves at the bottom
// when pulled down. The bar is always in the page's flow, so the chat ends above it
// either way; the sheet and its scrim cover the screen only while it is up. A tap
// on the handle row, or on the scrim, pulls it down; a tap on the bar, or a pull
// upwards on it, brings it back. Pulled down, the bar still says what became of
// the answer (`notes`), which the sheet says while it is up.
function Sheet({
  kind,
  title,
  collapsed,
  onCollapse,
  notes,
  children,
}: {
  kind: string;
  title: ReactNode;
  collapsed: boolean;
  onCollapse: (collapsed: boolean) => void;
  notes: ReactNode;
  children: ReactNode;
}) {
  const start = useRef<number | null>(null);
  const pulled = useRef(false);
  const touch = {
    onTouchStart: (e: TouchEvent) => {
      start.current = e.touches[0]?.clientY ?? null;
      pulled.current = false;
    },
    onTouchEnd: (e: TouchEvent) => {
      const from = start.current;
      const to = e.changedTouches[0]?.clientY;
      start.current = null;
      if (from === null || to === undefined) return;
      if (!collapsed && to - from > PULL_PX) pulled.current = true;
      else if (collapsed && from - to > PULL_PX) pulled.current = true;
      if (pulled.current) onCollapse(!collapsed);
    },
  };
  // A pull also ends in a click on some browsers: it has already done its work.
  const toggle = () => {
    if (pulled.current) {
      pulled.current = false;
      return;
    }
    onCollapse(!collapsed);
  };

  return (
    <>
      <div className="dialog-slot sheet-bar" data-kind={kind} data-collapsed={collapsed || undefined}>
        <button className="grab" aria-expanded={!collapsed} aria-label="Show the dialog" onClick={toggle} {...touch}>
          <span className="handle" />
          <span className="sh">
            <span className="dot red" />
            {title}
            <span className="x" data-up />
          </span>
        </button>
        {collapsed && <div className="bar-notes">{notes}</div>}
      </div>
      {!collapsed && (
        <>
          <div className="dialog-scrim" onClick={() => onCollapse(true)} />
          <div className="dialog-slot sheet" data-kind={kind} role="dialog" aria-modal="false">
            <button className="grab" aria-expanded aria-label="Pull down to read the chat" onClick={toggle} {...touch}>
              <span className="handle" />
              <span className="sh">
                <span className="dot red" />
                {title}
                <span className="x" />
              </span>
            </button>
            {children}
          </div>
        </>
      )}
    </>
  );
}

function Notes({ note, online, onTerminal }: { note: AnswerNote | null; online: boolean; onTerminal: () => void }) {
  return (
    <>
      {note && (
        <div className={note.error ? "note err" : "note"} role="status">
          <span className="t">{note.text}</span>
          {note.terminal && (
            <button className="btn ghost sm" onClick={onTerminal}>
              Open terminal
            </button>
          )}
        </div>
      )}
      {!online && (
        <div className="note offline" role="status">
          <span className="t">No connection to your Mac. You can answer once it's back.</span>
        </div>
      )}
    </>
  );
}
