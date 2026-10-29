// A session as a chat (PRD Stories 3, 4 and 6; mockups 2.1–2.3 and 4.2): the
// builder's messages as bubbles, the agent's text as Markdown, each turn's tool
// calls folded into one line (turns.ts), the messages still on their way from the
// outbox, and at the bottom the compose box, the working bar with Stop, or, while a
// dialog is open, the dialog slot in place of both.

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { RemoteSessionState, TranscriptEntry } from "../../shared/remote-protocol";
import { Compose } from "../components/Compose";
import { ConnectionBanner } from "../components/Connection";
import { lastAnswer } from "../answers";
import { AnswerOutcome, DialogSlot } from "../components/DialogSlot";
import { Markdown } from "../components/Markdown";
import { useDraft } from "../drafts";
import { duration, useNow } from "../format";
import { canCancel, idOf, instanceOf, type OutboxItem } from "../outbox";
import { navigate } from "../routes";
import { sessionOf } from "../state";
import { shallowEqual, useActions, useApp } from "../store";
import {
  foldLabel,
  groupTurns,
  landingOf,
  runningTool,
  toolMark,
  toolVerb,
  type Landing,
  type ToolMark,
  type Turn,
} from "../turns";
import "./session.css";

const PILLS: Record<RemoteSessionState, { className: string; label: string }> = {
  "needs-you": { className: "need", label: "Needs you" },
  working: { className: "work", label: "Working" },
  finished: { className: "done", label: "Finished" },
  idle: { className: "idle", label: "Idle" },
};

export function SessionScreen({ id }: { id: string }) {
  const actions = useActions();
  const instance = useApp((s) => s.instances?.find((i) => i.id === id));
  const listed = useApp((s) => s.instances !== null);
  const session = useApp((s) => sessionOf(s, id));
  const bubbles = useApp(
    (s) => s.outbox.filter((i) => i.frame.type === "prompt" && instanceOf(i) === id),
    shallowEqual
  );
  const [draft, setDraft] = useDraft(id);
  const [folds, setFolds] = useState<Record<string, boolean>>({});
  // The transcript on screen when "Earlier turns" was tapped: loading until it changes.
  const [earlierFrom, setEarlierFrom] = useState<TranscriptEntry[] | null | undefined>(undefined);

  const name = instance?.name ?? id;
  const working = instance?.state === "working";
  const needsYou = session.dialog !== null || instance?.state === "needs-you";
  // An answer's keys are still going in: its ack comes once the last is written, and
  // the dialog may have closed on the first. Text or Stop would still land in it.
  const answering = useApp((s) => lastAnswer(s.outbox, id)?.status === "sent");
  const stopped = instance?.status === "stopped";
  const gone = listed && !instance;
  const foot = footOf({ dialog: session.dialog !== null, needsYou, answering, stopped, gone });
  const shown = useShownState(instance?.state);

  const turns = useMemo(
    () => groupTurns(session.transcript ?? [], { working, waiting: needsYou }),
    [session.transcript, working, needsYou]
  );
  const landing = landingOf(turns, bubbles.length);
  // A fold is closed unless its turn is running, until tapped; kept by entry id, so
  // a refresh of the transcript leaves it as it was.
  const isOpen = (turn: Turn) => folds[turn.foldKey] ?? turn.live;
  const scroll = useChatScroll(landing, [session.transcript, bubbles, folds, needsYou, working, stopped]);

  const send = () => {
    const text = draft.replace(/\s+$/, "");
    if (!text) return;
    actions.sendPrompt(id, text);
    setDraft("");
    scroll.follow();
  };

  // A refused message goes back in the box, ahead of anything typed since.
  const edit = (item: OutboxItem) => {
    if (item.frame.type !== "prompt") return;
    setDraft(draft ? `${item.frame.text}\n${draft}` : item.frame.text);
    actions.dismiss(idOf(item));
  };

  // Whether the compose box is on screen (else the dialog slot, or a note).
  const composing = foot === "compose";
  const pill = stopped ? { className: "idle", label: "Stopped" } : shown ? PILLS[shown] : null;
  const loadingEarlier = earlierFrom !== undefined && earlierFrom === session.transcript;

  return (
    <div className="screen session-screen">
      <div className="topbar">
        <a className="tap back" href="#/" aria-label="Back">
          ‹
        </a>
        <div className="title">
          {name}
          {instance && <span className="sub">{instance.backend === "opencode" ? "OpenCode" : "Claude"}</span>}
        </div>
        {pill && <span className={`pill ${pill.className}`}>{pill.label}</span>}
        <button className="tap" aria-label="Terminal" onClick={() => navigate({ screen: "terminal", id })}>
          <span className="mono-icon">&gt;_</span>
        </button>
      </div>
      <ConnectionBanner since={session.refreshedAt} />
      <div className="screen-body" ref={scroll.ref} {...scroll.handlers}>
        <div className="chat">
          {session.hasEarlier && (
            <button
              className="earlier"
              disabled={loadingEarlier}
              onClick={() => {
                scroll.keep();
                setEarlierFrom(session.transcript);
                actions.loadEarlier(id);
              }}
            >
              {loadingEarlier ? "Loading earlier turns…" : "Earlier turns ↑"}
            </button>
          )}
          {session.transcript === null && bubbles.length === 0 && (
            <p className="empty">{listed ? "Loading the conversation…" : "Waiting for your Mac…"}</p>
          )}
          {turns.map((turn) => (
            <TurnView
              key={turn.key}
              turn={turn}
              open={isOpen(turn)}
              onToggle={() => {
                // The fold line stays under the finger; the tools open below it.
                scroll.keep();
                setFolds((f) => ({ ...f, [turn.foldKey]: !isOpen(turn) }));
              }}
              landing={landing.kind === "conclusion" && landing.turn === turn.key}
            />
          ))}
          {bubbles.map((item) => (
            <Sent key={idOf(item)} item={item} working={working} onEdit={composing ? edit : undefined} />
          ))}
        </div>
      </div>
      <div className="session-foot">
        {foot === "dialog" ? (
          <DialogSlot id={id} dialog={session.dialog} summary={session.dialog?.summary ?? instance?.preview ?? ""} />
        ) : foot === "answering" ? (
          <p className="foot-note">Sending your answer…</p>
        ) : foot === "ended" ? (
          <p className="foot-note">
            {gone ? "This session is no longer on your Mac." : "This session is stopped. Start it on your Mac to reply."}
          </p>
        ) : (
          <>
            <AnswerOutcome id={id} />
            {/* Keyed by the turn: a "Stop this turn?" asked in one turn doesn't stop the next. */}
            {working && (
              <WorkingBar
                key={turns[turns.length - 1]?.key}
                id={id}
                turn={turns[turns.length - 1]}
                since={instance?.since}
              />
            )}
            <Compose
              text={draft}
              onText={setDraft}
              onSend={send}
              placeholder={working ? "Queued until this turn ends…" : `Reply to ${name}…`}
              hint={working && draft ? "Queued until this turn ends" : undefined}
            />
          </>
        )}
      </div>
    </div>
  );
}

// What the bottom of the chat holds: the dialog slot (a dialog is open, or the
// list says one is and its prompt-state is on its way), a note while an answer's
// keys go in or once the session has ended, else the compose box (with the working
// bar while a turn runs). A dialog the Mac has described always shows.
export type Foot = "dialog" | "answering" | "ended" | "compose";

export function footOf(s: {
  dialog: boolean;
  needsYou: boolean;
  answering: boolean;
  stopped: boolean;
  gone: boolean;
}): Foot {
  if (s.dialog) return "dialog";
  if (s.answering) return "answering";
  if (s.needsYou) return "dialog";
  return s.stopped || s.gone ? "ended" : "compose";
}

// The header's state pill (T-802's call): opening a Finished session makes it Idle
// in the list, but the header keeps "Finished" until the state changes again; so
// does a turn that finishes while the screen is open.
function useShownState(live: RemoteSessionState | undefined): RemoteSessionState | undefined {
  const [shown, setShown] = useState(live);
  const next = shown === "finished" && live === "idle" ? "finished" : live;
  if (next !== shown) setShown(next);
  return next;
}

// ---------------------------------------------------------------------------
// Scrolling
// ---------------------------------------------------------------------------

// The space left above where the screen lands on a turn: its fold line, so what the
// turn did is in view just above the conclusion (or the conclusion, with no fold).
const LANDING_MARGIN = 8;
// How close to the end counts as at the bottom.
const BOTTOM_SLACK = 40;

// Where the chat is scrolled: on the landing (turns.ts `landingOf`) until the
// builder touches it, and whenever the landing moves while they are at the bottom
// (a turn ends: its conclusion; a turn starts: the bottom, following it as it
// grows). Otherwise what they were reading stays put, whatever arrives above or
// below it: the first turn on screen is kept at its place (Safari has no CSS scroll
// anchoring).
function useChatScroll(landing: Landing, content: unknown[]) {
  const ref = useRef<HTMLDivElement>(null);
  const at = useRef({ touched: false, bottom: true, landed: "", anchor: null as Anchor | null });
  const target = landing.kind === "conclusion" ? `conclusion:${landing.turn}` : "bottom";

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const s = at.current;
    if (!s.touched || (s.bottom && target !== s.landed)) {
      land(el, landing);
      s.landed = target;
    } else if (s.bottom) {
      el.scrollTop = el.scrollHeight;
    } else if (s.anchor) {
      restore(el, s.anchor);
    }
    // Now, not at the scroll event, which comes after the next resize may have.
    s.bottom = atBottom(el);
    // `landing` is read through `target`, which names it.
  }, [target, ...content]);

  // The chat's own height changes under it (the compose box grows with its text,
  // the working bar comes and goes): a view at the bottom stays at the bottom.
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let height = el.clientHeight;
    const observer = new ResizeObserver(() => {
      if (el.clientHeight === height) return;
      height = el.clientHeight;
      if (at.current.bottom) el.scrollTop = el.scrollHeight;
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const touch = () => {
    at.current.touched = true;
  };
  return {
    ref,
    handlers: {
      onTouchStart: touch,
      onWheel: touch,
      onScroll: () => {
        const el = ref.current;
        if (!el) return;
        at.current.bottom = atBottom(el);
        at.current.anchor = anchorOf(el);
      },
    },
    // The builder sent a message: show it, and follow what it starts.
    follow: () => {
      at.current.touched = true;
      at.current.bottom = true;
    },
    // Content is about to change around what is on screen (earlier turns coming
    // in above, a fold opening): keep it where it is.
    keep: () => {
      const el = ref.current;
      at.current.touched = true;
      at.current.bottom = false;
      if (el) at.current.anchor = anchorOf(el);
    },
  };
}

const atBottom = (el: HTMLElement) => el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_SLACK;

function land(el: HTMLElement, landing: Landing) {
  const target =
    landing.kind === "conclusion" ? el.querySelector<HTMLElement>(`[data-landing="${CSS.escape(landing.turn)}"]`) : null;
  if (!target) {
    el.scrollTop = el.scrollHeight;
    return;
  }
  el.scrollTop += target.getBoundingClientRect().top - el.getBoundingClientRect().top - LANDING_MARGIN;
}

// The first turn or bubble whose end is on screen, and where its top is.
interface Anchor {
  key: string;
  top: number;
}

function anchorOf(el: HTMLElement): Anchor | null {
  const top = el.getBoundingClientRect().top;
  for (const child of el.querySelectorAll<HTMLElement>("[data-anchor]")) {
    const box = child.getBoundingClientRect();
    if (box.bottom > top) return { key: child.dataset.anchor ?? "", top: box.top - top };
  }
  return null;
}

function restore(el: HTMLElement, anchor: Anchor) {
  const child = el.querySelector<HTMLElement>(`[data-anchor="${CSS.escape(anchor.key)}"]`);
  if (!child) return;
  el.scrollTop += child.getBoundingClientRect().top - el.getBoundingClientRect().top - anchor.top;
}

// ---------------------------------------------------------------------------
// Turns
// ---------------------------------------------------------------------------

function TurnView({
  turn,
  open,
  onToggle,
  landing,
}: {
  turn: Turn;
  open: boolean;
  onToggle: () => void;
  // The screen lands on this turn: its fold line (when closed) or its conclusion.
  landing: boolean;
}) {
  const folded = turn.fold.length > 0;
  return (
    <div className="turn" data-anchor={turn.key}>
      {turn.user && <div className="u">{turn.user.text}</div>}
      {turn.lead.map((e, i) => (
        <Markdown key={e.id ?? i} className="a" text={e.text} />
      ))}
      {folded && <Fold turn={turn} open={open} onToggle={onToggle} landing={landing && !open} />}
      {landing && folded && !open && (
        <div className="jumpmark">
          <span>conclusion</span>
        </div>
      )}
      {turn.conclusion.length > 0 && (
        <div className="a" data-landing={landing && (!folded || open) ? turn.key : undefined}>
          {turn.conclusion.map((e, i) => (
            <Markdown key={e.id ?? i} text={e.text} />
          ))}
        </div>
      )}
    </div>
  );
}

function Fold({ turn, open, onToggle, landing }: { turn: Turn; open: boolean; onToggle: () => void; landing: boolean }) {
  const took = turn.startAt !== undefined && turn.endAt !== undefined ? duration(turn.endAt - turn.startAt) : null;
  return (
    <div className={open ? "fold open" : "fold"} data-live={turn.live || undefined}>
      <button className="fh" aria-expanded={open} onClick={onToggle} data-landing={landing ? turn.key : undefined}>
        <span className="chev">{open ? "▾" : "▸"}</span>
        <span className="t">{foldLabel(turn.fold, turn.live)}</span>
        <span className="d">{turn.live ? <Elapsed since={turn.startAt} /> : took}</span>
      </button>
      {open && (
        <div className="tools">
          {turn.fold.map((e, i) =>
            e.kind === "tool" ? (
              <ToolLine key={e.id ?? i} entry={e} live={turn.live} />
            ) : (
              <Markdown key={e.id ?? i} className="say" text={e.text} />
            )
          )}
        </div>
      )}
    </div>
  );
}

function ToolLine({ entry, live }: { entry: TranscriptEntry; live: boolean }) {
  const mark = toolMark(entry, live);
  return (
    <div className="tool" data-mark={mark.kind}>
      <span className="v">{toolVerb(entry.tool)}</span>
      <span className="tg">{entry.text}</span>
      <Mark mark={mark} since={entry.at} />
    </div>
  );
}

function Mark({ mark, since }: { mark: ToolMark; since?: number }) {
  switch (mark.kind) {
    case "running":
      return (
        <span className="run">
          ● <Elapsed since={since} />
        </span>
      );
    case "stalled":
      return <span className="faint">●</span>;
    case "failed":
      return <span className="bad">✗ failed</span>;
    case "lines":
      return (
        <span className="lines">
          {mark.added > 0 && <span className="add">+{mark.added}</span>}
          {mark.removed > 0 && <span className="del">−{mark.removed}</span>}
        </span>
      );
    case "done":
      return <span className="ok">✓</span>;
    case "unknown":
      return <span className="faint">✓</span>;
  }
}

// A running time, ticking each second on its own so nothing else re-renders.
function Elapsed({ since }: { since?: number }) {
  const now = useNow(1000);
  return since === undefined ? null : <>{duration(now - since)}</>;
}

// ---------------------------------------------------------------------------
// The builder's messages on their way (outbox.ts)
// ---------------------------------------------------------------------------

// `onEdit` (put a refused or doubtful message back in the compose box) only while
// there is one.
function Sent({ item, working, onEdit }: { item: OutboxItem; working: boolean; onEdit?: (item: OutboxItem) => void }) {
  const actions = useActions();
  if (item.frame.type !== "prompt") return null;
  const id = idOf(item);
  let status: ReactNode = null;
  if (item.status === "waiting") {
    status = canCancel(item) ? (
      <>
        ⏱ Waiting to send ·{" "}
        <button className="link" onClick={() => actions.cancelPrompt(id)}>
          Cancel
        </button>
      </>
    ) : (
      "⏱ Waiting to send · sends when your Mac is back"
    );
  } else if (item.status === "sent") {
    status = "Sending…";
  } else if (item.status === "acked" && working) {
    // The CLI holds it until the turn ends; the transcript shows it then.
    status = "Queued until this turn ends";
  } else if (item.status === "unknown") {
    // It went out before the phone paired again (outbox.ts `newDevice`), so it isn't
    // sent again; the transcript shows it if it arrived.
    status = "May not have arrived. Check the session.";
  }
  return (
    <div className="sent" data-anchor={id} data-status={item.status}>
      <div className="u">
        {item.frame.text}
        {status && <span className="st">{status}</span>}
      </div>
      {item.status === "unknown" && (
        <div className="refusal">
          {onEdit && (
            <>
              <button className="link" onClick={() => onEdit(item)}>
                Edit
              </button>{" "}
              ·{" "}
            </>
          )}
          <button className="link" onClick={() => actions.dismiss(id)}>
            Dismiss
          </button>
        </div>
      )}
      {item.status === "refused" && (
        <div className="refusal">
          ✗ {item.refusal?.message || "Your Mac didn't take this message."}{" "}
          {onEdit && (
            <>
              <button className="link" onClick={() => onEdit(item)}>
                Edit
              </button>{" "}
              ·{" "}
            </>
          )}
          <button className="link" onClick={() => actions.dismiss(id)}>
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The working bar (mockup 2.3)
// ---------------------------------------------------------------------------

// The desk's own STOP_SETTLE_MS (remote-host.ts): how long after a Stop it refuses
// another for the same turn, which may not have reported its end yet.
const STOP_SETTLE_MS = 3000;

// The running tool and how long the turn has run, and Stop: asked first ("Stop this
// turn?"), then an `interrupt`, which does what Esc does at the desk. Only on an
// open link (an interrupt is never queued), and never shown with a dialog open.
function WorkingBar({ id, turn, since }: { id: string; turn: Turn | undefined; since?: number }) {
  const actions = useActions();
  const online = useApp((s) => s.connection.state === "connected");
  const [confirming, setConfirming] = useState(false);
  const [stopId, setStopId] = useState<string | null>(null);
  const stop = useApp((s) => (stopId ? s.outbox.find((i) => idOf(i) === stopId) : undefined));
  const now = useNow(1000);
  const tool = runningTool(turn);
  const start = turn?.live ? (turn.startAt ?? since) : since;

  const confirm = () => {
    setConfirming(false);
    if (stopId) actions.dismiss(stopId);
    const item = actions.interrupt(id);
    setStopId(item ? idOf(item) : null);
  };

  if (confirming) {
    return (
      <div className="workbar" data-confirm>
        <span className="t">
          <b>Stop this turn?</b>
        </span>
        <button className="wbtn" onClick={() => setConfirming(false)}>
          Cancel
        </button>
        <button className="stopbtn solid" disabled={!online} onClick={confirm}>
          <i />
          Stop
        </button>
      </div>
    );
  }

  // The Mac took the Stop: the turn ends in a moment. One still running after
  // that really is, and may be stopped again.
  const stopping =
    stop?.status === "sent" || (stop?.status === "acked" && now - (stop.settledAt ?? 0) < STOP_SETTLE_MS);
  const note =
    stop?.status === "refused"
      ? stop.refusal?.message || "Your Mac couldn't stop this turn."
      : stop?.status === "unknown"
        ? "Stop may not have arrived. Check the session."
        : null;
  return (
    <div className="workbar">
      <span className="dot blue pulse" />
      {note ? (
        <span className="t err">{note}</span>
      ) : (
        <span className="t">
          <b>{tool ? toolVerb(tool.tool) : "Working"}</b>
          {tool?.text ? ` ${tool.text}` : ""}
          {start !== undefined && (
            <>
              {" · "}
              <Elapsed since={start} />
            </>
          )}
        </span>
      )}
      <button className="stopbtn" disabled={!online || stopping} onClick={() => setConfirming(true)}>
        <i />
        {stopping ? "Stopping…" : "Stop"}
      </button>
    </div>
  );
}
