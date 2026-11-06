// The secretary bar (epic secretary-bar, Stories 1 to 4 and 7), under the top bar of
// every screen while Secretary Mode is on. Folded it is one line: the brief's session
// as its title ("Shop · Secretary"), the brief's first sentence and Play. A tap opens
// its panel: the whole brief, the secretary's state, Play / Replay / Stop, the queue
// ("‹ 1 / 3 ›"), "Got it" on a Finished brief that waits, the exchanges, and on a
// Needs-you brief the secretary can answer, a reply box. Which brief it shows is
// bar.ts's; this file only draws it.
//
// Nothing plays without a tap on Play. The title opens the brief's session and plays
// nothing. Offline the text stays (from the cache) and Play, "Got it" and Send say
// they need the Mac.
//
// Also here: the Secretary Mode switch on the list (Story 5), the desktop's own.

import { useState, type MouseEvent } from "react";
import type { RemoteBrief } from "../../shared/remote-protocol";
import type { SecretaryExchange } from "../../shared/types";
import { isWaiting, queuePlace, stepBrief, type BriefRef } from "../../shared/secretaryQueue";
import { briefOf, foldedLine, playOffer, refKey, stateLine, type PlayOffer } from "../bar";
import { shortAge, useNow } from "../format";
import { idOf } from "../outbox";
import { navigate } from "../routes";
import { EMPTY_REPLY } from "../state";
import { useActions, useApp } from "../store";
import "./compose.css";
import "./secretary-bar.css";

export function SecretaryBar() {
  const actions = useActions();
  const on = useApp((s) => s.secretary?.on === true);
  const bar = useApp((s) => s.bar);
  const brief = useApp((s) => briefOf(s, s.bar.shown));
  const briefs = useApp((s) => s.secretary?.briefs);
  const name = useApp((s) => {
    const id = s.bar.shown?.instanceId;
    return id ? (s.instances?.find((i) => i.id === id)?.name ?? null) : null;
  });
  const player = useApp((s) => s.player);
  const played = useApp((s) => s.played);
  const connection = useApp((s) => s.connection);
  const secretaryLive = useApp((s) => s.secretaryLive);
  if (!on || !briefs) return null;

  const ref = bar.shown;
  const offer = playOffer(brief, { player, played, connection, secretaryLive }, ref);
  const waiting = brief ? isWaiting(brief) : false;
  const title = ref ? (name ?? "Session") : null;
  const openSession = () => {
    if (ref) navigate({ screen: "session", id: ref.instanceId });
  };
  const toggle = () => {
    if (ref) actions.openBar(!bar.open);
  };

  return (
    <section className={bar.open ? "sbar open" : "sbar"} aria-label="Secretary" data-waiting={waiting || undefined}>
      <div className="sbar-line">
        <span className="sbar-mark" aria-hidden="true">
          <VoiceMark />
        </span>
        {title ? (
          <button className="sbar-title" onClick={openSession} aria-label={`Open ${title}`}>
            <b>{title}</b>
            <span className="who"> · Secretary</span>
          </button>
        ) : (
          <span className="sbar-title">
            <b>Secretary</b>
          </span>
        )}
        {bar.open ? (
          <>
            <span className="sbar-gap" />
            <Steps current={ref} briefs={briefs} />
            <button className="sbar-icon" aria-label="Fold" aria-expanded onClick={toggle}>
              <span className="chev up" />
            </button>
          </>
        ) : (
          <>
            <button className="sbar-say" aria-expanded={false} disabled={!ref} onClick={toggle}>
              {!waiting && brief && <span className="done">Handled · </span>}
              {foldedLine(brief)}
            </button>
            <PlayButton offer={offer} ref_={ref} />
          </>
        )}
      </div>
      {bar.open && brief && ref && <Panel brief={brief} ref_={ref} offer={offer} waiting={waiting} />}
    </section>
  );
}

// The panel: everything the brief has, and what can be done with it.
function Panel({ brief, ref_, offer, waiting }: { brief: RemoteBrief; ref_: BriefRef; offer: PlayOffer; waiting: boolean }) {
  const actions = useActions();
  const player = useApp((s) => s.player);
  // Connected, to a Mac that has said it has a secretary.
  const online = useApp((s) => s.connection.state === "connected" && s.secretaryLive);
  const now = useNow(30_000);
  const gotIt = () => {
    if (!actions.secretarySeen(ref_.instanceId, ref_.seq)) return;
    actions.stopPlaying();
    // Dealt with: the bar moves on to the next one, silently.
    actions.openBar(false);
  };
  const replyable = brief.kind === "needs-you" && !brief.handled;

  return (
    <div className="sbar-panel">
      <div className="sbar-state">
        <span className={brief.kind === "needs-you" ? "k need" : "k done"}>
          {brief.kind === "needs-you" ? "Needs you" : "Finished"}
        </span>
        <span className="age">{shortAge(brief.at, now)}</span>
        {!waiting && <span className="handled">Handled</span>}
        <span className="st">{stateLine(brief, player, ref_)}</span>
      </div>
      {brief.status === "ready" && <p className="sbar-full">{brief.text}</p>}
      <div className="sbar-acts">
        {offer !== "none" && <PlayButton offer={offer} ref_={ref_} wide />}
        {brief.kind === "finished" && waiting && (
          <button className="btn ghost" disabled={!online} onClick={gotIt}>
            Got it
          </button>
        )}
      </div>
      {(offer === "offline" || (!online && brief.kind === "finished" && waiting)) && (
        <p className="sbar-note">Playing and "Got it" need your Mac.</p>
      )}
      {brief.exchanges && brief.exchanges.length > 0 && <Exchanges list={brief.exchanges} />}
      {replyable &&
        (brief.replyable ? (
          <ReplyBox key={refKey(ref_)} ref_={ref_} />
        ) : (
          <p className="sbar-note">The secretary can't answer this one in words. Use the dialog's buttons or the terminal.</p>
        ))}
    </div>
  );
}

function Steps({ current, briefs }: { current: BriefRef | null; briefs: Record<string, RemoteBrief> }) {
  const actions = useActions();
  const { index, count } = queuePlace(current, briefs);
  const back = stepBrief(current, briefs, -1);
  const next = stepBrief(current, briefs, 1);
  return (
    <span className="sbar-steps">
      <button className="sbar-icon" aria-label="Previous brief" disabled={!back} onClick={() => back && actions.showBrief(back)}>
        ‹
      </button>
      <span className="n">{index > 0 ? `${index} / ${count}` : count > 0 ? `${count} waiting` : "none waiting"}</span>
      <button className="sbar-icon" aria-label="Next brief" disabled={!next} onClick={() => next && actions.showBrief(next)}>
        ›
      </button>
    </span>
  );
}

// Play, Replay or Stop, from the tap itself (store.ts `play`).
function PlayButton({ offer, ref_, wide = false }: { offer: PlayOffer; ref_: BriefRef | null; wide?: boolean }) {
  const actions = useActions();
  if (offer === "none") {
    return wide ? null : <span className="sbar-textonly">text only</span>;
  }
  const label =
    offer === "stop"
      ? "Stop"
      : offer === "replay"
        ? "Replay"
        : offer === "wait"
          ? "Voice on its way"
          : offer === "offline"
            ? "Play needs your Mac"
            : "Play";
  const tap = () => {
    if (offer === "stop") actions.stopPlaying();
    else if (ref_) actions.play(ref_);
  };
  const disabled = offer === "wait" || offer === "offline";
  if (wide) {
    return (
      <button className={offer === "stop" ? "btn sbar-play stop" : "btn primary sbar-play"} disabled={disabled} onClick={tap}>
        <span className={offer === "stop" ? "glyph stop" : offer === "wait" ? "glyph wait" : "glyph play"} />
        {offer === "offline" ? "Play" : label}
      </button>
    );
  }
  return (
    <button className="sbar-round" aria-label={label} disabled={disabled} onClick={tap} data-offer={offer}>
      <span className={offer === "stop" ? "glyph stop" : offer === "wait" ? "glyph wait" : "glyph play"} />
    </button>
  );
}

const OUTCOMES: Record<NonNullable<SecretaryExchange["outcome"]>, string> = {
  pressed: "Answered the dialog",
  asked: "Asks back",
  answered: "Answered your question",
  refused: "Pressed nothing",
  failed: "Couldn't read it",
};

function Exchanges({ list }: { list: SecretaryExchange[] }) {
  return (
    <ol className="sbar-ex">
      {list.map((e, i) => (
        <li key={i}>
          <div className="you">{e.reply}</div>
          <div className="sec" data-outcome={e.outcome ?? "reading"}>
            {e.response ?? "Reading your reply…"}
            {e.outcome && <span className="o">{OUTCOMES[e.outcome]}</span>}
          </div>
        </li>
      ))}
    </ol>
  );
}

// The textarea keeps the focus, and the keyboard stays up, when Send is tapped.
const keepFocus = (e: MouseEvent) => e.preventDefault();

// The reply box (Story 7): as the compose box, only Send sends and Return is a new
// line, so dictation and a Chinese IME's Return never send half a reply. It needs the
// Mac: offline nothing is queued, and the text stays. What it holds and the reply it
// sent live in the store (state.ts `ReplyDraft`), so the panel folding or another
// screen showing it changes neither: an accepted reply never comes back as a draft,
// and a refusal is still said.
export function ReplyBox({ ref_ }: { ref_: BriefRef }) {
  const actions = useActions();
  const key = refKey(ref_);
  const online = useApp((s) => s.connection.state === "connected" && s.secretaryLive);
  const draft = useApp((s) => s.replies[key] ?? EMPTY_REPLY);
  const item = useApp((s) => (draft.sentId ? s.outbox.find((i) => idOf(i) === draft.sentId) : undefined));
  const reading = useApp((s) => briefOf(s, ref_)?.exchanges?.some((e) => !e.outcome) === true);
  const { text } = draft;

  const sending = item?.status === "sent";
  const note =
    item?.status === "refused"
      ? `${item.refusal?.message ?? "Your Mac didn't take it"}. Your text is kept.`
      : item?.status === "unknown"
        ? "It may not have reached your Mac. Look at the exchanges before sending again."
        : !online
          ? "Replies need your Mac."
          : sending
            ? "Sending…"
            : reading
              ? "The secretary is reading your reply…"
              : null;

  return (
    <div className="sbar-reply">
      {note && <div className={item?.status === "refused" ? "hint err" : "hint"}>{note}</div>}
      <div className="compose">
        <div className="grow" data-value={text}>
          <textarea
            value={text}
            rows={1}
            placeholder="Answer in words…"
            aria-label="Reply to the secretary"
            enterKeyHint="enter"
            autoCapitalize="sentences"
            onChange={(e) => actions.editReply(ref_, e.target.value)}
          />
        </div>
        <button
          className="send"
          aria-label="Send to the secretary"
          disabled={text.trim() === "" || sending || !online || reading}
          onMouseDown={keepFocus}
          onClick={() => actions.sendReply(ref_)}
        >
          <span>↑</span>
        </button>
      </div>
    </div>
  );
}

// The secretary's mark: three bars of a voice.
function VoiceMark() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16">
      <rect x="2" y="6" width="2.4" height="4" rx="1.2" />
      <rect x="6.8" y="3" width="2.4" height="10" rx="1.2" />
      <rect x="11.6" y="5" width="2.4" height="6" rx="1.2" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// The switch (Story 5)
// ---------------------------------------------------------------------------

// Secretary Mode, as the desktop's toolbox switch: a change on either side shows on
// the other. It can't move offline, nor on without the Claude Code CLI on the Mac,
// and it says why.
export function SecretarySwitch() {
  const actions = useActions();
  const secretary = useApp((s) => s.secretary);
  const online = useApp((s) => s.connection.state === "connected");
  // This connection's Mac has said what its secretary is: a cached state may be from
  // another version of it.
  const live = useApp((s) => s.secretaryLive);
  const [sentId, setSentId] = useState<string | null>(null);
  const item = useApp((s) => (sentId ? s.outbox.find((i) => idOf(i) === sentId) : undefined));
  if (!secretary) return null;

  const pending = item?.status === "sent" && item.frame.type === "secretary-mode";
  const on = pending && item.frame.type === "secretary-mode" ? item.frame.enabled : secretary.on;
  const noClaude = !secretary.on && !secretary.claudeFound;
  const why = !online
    ? "Needs your Mac."
    : !live
      ? "Waiting for your Mac…"
      : noClaude
      ? "Your Mac needs Claude Code for the secretary."
      : item?.status === "refused"
        ? `${item.refusal?.message ?? "Your Mac didn't take it"}.`
        : item?.status === "unknown"
          ? "It may not have reached your Mac."
          : null;
  const flip = () => {
    if (item) actions.dismiss(idOf(item));
    const sent = actions.setSecretaryMode(!secretary.on);
    setSentId(sent ? idOf(sent) : null);
  };

  return (
    <div className="sswitch" data-on={on || undefined}>
      <span className="t">
        <span className="l">Secretary Mode</span>
        {why && <span className="why">{why}</span>}
      </span>
      <button
        className="toggle"
        role="switch"
        aria-checked={on}
        aria-label="Secretary Mode"
        disabled={!online || !live || pending || noClaude}
        onClick={flip}
      >
        <i />
      </button>
    </div>
  );
}
