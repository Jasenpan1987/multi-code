// The secretary bar (epic secretary-bar, PRD Stories 1-4 and 7, desktop side): one
// strip across the top of the window while Secretary Mode is on, above the sidebar
// and the terminal, whichever session is selected. It shows one brief at a time,
// chosen by shared/secretaryQueue.ts: the waiting ones in turn, Needs you first, and
// the latest when nothing waits. It never changes the brief under the builder's eyes
// (`hold`): not while it plays or loads, while the bar is open, or while a reply is
// with the secretary.
//
// Nothing plays without a click on Play: not when a brief arrives, not for the session
// on screen, not when the bar moves on. One brief plays at a time (audio/briefPlayer);
// moving to another brief, the brief being replaced, or the mode going off (the bar
// unmounts) stops it.
//
// "Got it" on a waiting Finished brief, and a Finished brief that played to the end,
// read its session (`onRead`): main marks the brief seen and the bar moves on. A
// Needs you leaves the queue only when its dialog is answered.
//
// Folded, the bar is one row of title, state and controls over three lines of the
// brief, the same height for every brief, so the terminal below isn't resized with
// every brief. Opened, it shows the full text, the exchanges and, on a Needs-you the
// secretary can answer, the reply box (voice-secretary T-510): what the builder types
// or dictates goes to the secretary, which answers the dialog, asks back or answers
// their question. Its buttons never take focus, so the terminal keeps the keyboard;
// input on the bar doesn't count as reading the session on screen
// (audio/attentionPolicy). Any change of its height refits the terminal.

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { FormEvent, KeyboardEvent, MouseEvent, ReactNode } from "react";
import type { Instance } from "../../shared/types";
import { isWaiting, queuePlace, shownBrief, stepBrief } from "../../shared/secretaryQueue";
import type { BriefRef } from "../../shared/secretaryQueue";
import {
  briefPlaybackFailed,
  isBriefPlaying,
  playBrief,
  releaseBrief,
  replayBrief,
  stopBrief,
  subscribeBriefEnded,
  subscribeBriefPlayback,
} from "../audio/briefPlayer";
import {
  barControls,
  barState,
  briefLang,
  queueLabel,
  readsOnEnd,
  replyView,
} from "./secretaryBrief";
import type { BriefMap } from "./secretaryBrief";

interface SecretaryBarProps {
  briefs: BriefMap;
  instances: Instance[];
  // The title: select that contact. Plays nothing.
  onOpenSession: (instanceId: string) => void;
  // "Got it", or a Finished brief played to the end: read its session.
  onRead: (instanceId: string) => void;
}

// Buttons act on mouse up; swallowing mouse down keeps focus where it was, so a click
// on the bar never pulls focus out of the terminal.
const keepFocus = (e: MouseEvent) => e.preventDefault();

const keyOf = (ref: BriefRef) => `${ref.instanceId}#${ref.seq}`;

const sameRef = (a: BriefRef | null, b: BriefRef | null) =>
  a === b || (!!a && !!b && a.instanceId === b.instanceId && a.seq === b.seq);

export function SecretaryBar({ briefs, instances, onOpenSession, onRead }: SecretaryBarProps) {
  const [shown, setShown] = useState<BriefRef | null>(null);
  const [open, setOpen] = useState(false);
  // Per brief, by key: a draft, a send or an audio fetch belongs to the brief it
  // started on, and reads as nothing on any other.
  const [draft, setDraft] = useState({ key: "", text: "" });
  const [sendingKey, setSendingKey] = useState<string | null>(null);
  const [loading, setLoading] = useState<{ key: string; request: number } | null>(null);
  const [staleKey, setStaleKey] = useState<string | null>(null);
  const [played, setPlayed] = useState<ReadonlySet<string>>(new Set());
  // Bumped by every play, stop and change of brief, so an audio fetch that comes back
  // after any of them is dropped.
  const request = useRef(0);
  // Set by "Reply": focus the box once it shows.
  const focusReply = useRef(false);

  const brief = shown && briefs[shown.instanceId]?.seq === shown.seq ? briefs[shown.instanceId] : null;
  const key = shown && brief ? keyOf(shown) : null;
  const playing = useSyncExternalStore(subscribeBriefPlayback, () => key !== null && isBriefPlaying(key));
  const playFailed = useSyncExternalStore(subscribeBriefPlayback, () =>
    key !== null && briefPlaybackFailed(key)
  );
  const isLoading = key !== null && loading?.key === key;
  const replies = brief ? replyView(brief) : null;
  const busy = key !== null && (sendingKey === key || !!replies?.pending);
  const hold = brief !== null && (playing || isLoading || open || busy);

  // Which brief the bar shows now, from the one it showed: set while rendering, so
  // a brief that was dealt with gives way before anything is drawn for it.
  const next = shownBrief(shown, briefs, hold);
  if (!sameRef(next, shown)) setShown(next);
  if (open && !brief && !next) setOpen(false);

  // Whatever stops being shown stops playing: stepping, a replacement, the mode off.
  useEffect(
    () => () => {
      request.current++;
      if (key) releaseBrief(key);
    },
    [key]
  );

  const instanceId = shown?.instanceId ?? null;
  const latest = useRef({ key, brief, instanceId, onRead });
  latest.current = { key, brief, instanceId, onRead };
  useEffect(
    () =>
      subscribeBriefEnded((ended) => {
        const now = latest.current;
        if (ended === now.key && now.instanceId && readsOnEnd(now.brief)) now.onRead(now.instanceId);
      }),
    []
  );

  // The terminal (and the toolbox's shell) refit only when told, and the bar's
  // height is the room they lose. Told at once when it opens, folds or gets its
  // first brief: those run while the window is hidden too, where neither a
  // ResizeObserver nor an animation frame does. The observer catches the rest, such
  // as an open bar growing with an exchange. App tells them when the bar comes and
  // goes with the mode.
  const root = useRef<HTMLElement>(null);
  const hasBrief = brief !== null;
  useEffect(() => {
    window.dispatchEvent(new Event("layout-resize"));
  }, [open, hasBrief]);
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    let height = el.getBoundingClientRect().height;
    const observer = new ResizeObserver(() => {
      const now = el.getBoundingClientRect().height;
      if (now === height) return;
      height = now;
      window.dispatchEvent(new Event("layout-resize"));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const exchangesRef = useRef<HTMLDivElement>(null);
  const exchangeCount = replies?.exchanges.length ?? 0;
  useEffect(() => {
    const el = exchangesRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [exchangeCount, replies?.pending, open]);

  const replyBox = useRef<HTMLTextAreaElement>(null);
  const boxShown = open && !!replies?.boxShown;
  useEffect(() => {
    if (!boxShown || !focusReply.current) return;
    focusReply.current = false;
    replyBox.current?.focus();
  }, [boxShown]);

  const play = useCallback(async () => {
    if (!shown || !key) return;
    const mine = ++request.current;
    setStaleKey(null);
    if (replayBrief(key)) {
      setPlayed((prev) => new Set(prev).add(key));
      return;
    }
    setLoading({ key, request: mine });
    // An IPC failure reads like no audio: the brief is then out of date.
    const wav = await window.electronAPI
      .getSecretaryAudio(shown.instanceId, shown.seq)
      .catch(() => null);
    setLoading((cur) => (cur?.request === mine ? null : cur));
    if (mine !== request.current) return;
    if (!wav) {
      setStaleKey(key);
      return;
    }
    playBrief(key, wav);
    setPlayed((prev) => new Set(prev).add(key));
  }, [shown, key]);

  const stop = () => {
    request.current++;
    setLoading(null);
    if (key) stopBrief(key);
  };

  const gotIt = () => {
    if (!instanceId) return;
    stop();
    // Folded, so nothing holds it: the bar moves on once main marks it seen.
    setOpen(false);
    onRead(instanceId);
  };

  const step = (delta: 1 | -1) => {
    const to = stepBrief(shown, briefs, delta);
    if (to) setShown(to);
  };

  const draftText = key !== null && draft.key === key ? draft.text : "";
  const send = (e?: FormEvent) => {
    e?.preventDefault();
    const text = draftText.trim();
    if (!shown || !key || !text || busy) return;
    const sent = key;
    setDraft({ key: sent, text: "" });
    setSendingKey(sent);
    void window.electronAPI
      .replyToSecretary(shown.instanceId, shown.seq, text)
      .catch(() => {})
      .finally(() => setSendingKey((cur) => (cur === sent ? null : cur)));
  };
  // Enter sends; Shift+Enter is a new line, as in the compose box. Not while an input
  // method is composing, where Enter picks the characters (Chinese pinyin, Japanese
  // kana).
  const onReplyKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
    e.preventDefault();
    send();
  };

  const playback = {
    playing,
    loading: isLoading,
    failed: playFailed,
    stale: key !== null && staleKey === key,
  };
  const state = barState(brief, playback);
  const controls = barControls(brief, playback);
  const place = queuePlace(brief ? shown : null, briefs);
  const queue = queueLabel(place);
  const name = instanceId ? (instances.find((i) => i.id === instanceId)?.name ?? "A session") : null;
  const language = brief?.status === "ready" ? brief.language : null;
  const chinese = language === "Chinese";
  // On a Needs-you the secretary can answer, the bar opens to the reply box.
  const replyable = !!replies?.boxShown;

  let body: ReactNode;
  if (!brief) {
    body = (
      <div className="secretary-bar-placeholder">
        When a session finishes or needs you, the secretary&apos;s brief shows here. Press Play to hear it.
      </div>
    );
  } else if (brief.status === "ready") {
    body = (
      <div className="secretary-bar-text" lang={briefLang(language)}>
        {brief.text}
      </div>
    );
  } else if (brief.status === "preparing") {
    body = <div className="secretary-bar-placeholder">The secretary is writing the brief for {name}.</div>;
  } else {
    body = (
      <div className="secretary-bar-placeholder" data-tone="warn">
        No brief could be written for {name}: {brief.reason}
      </div>
    );
  }

  return (
    <section
      ref={root}
      className="secretary-bar"
      data-open={open ? "true" : undefined}
      data-kind={brief?.kind}
      data-empty={brief ? undefined : "true"}
      data-waiting={brief ? String(isWaiting(brief)) : undefined}
      aria-label="Secretary"
    >
      <header className="secretary-bar-head">
        {brief && name && instanceId ? (
          <button
            type="button"
            className="secretary-bar-title"
            onMouseDown={keepFocus}
            onClick={() => onOpenSession(instanceId)}
            title={`Open ${name}`}
          >
            <span className="secretary-bar-name">{name}</span>
            <span className="secretary-bar-role"> · Secretary</span>
          </button>
        ) : (
          <span className="secretary-bar-title">
            <span className="secretary-bar-role">Secretary</span>
          </span>
        )}
        {brief ? (
          <span className="secretary-bar-kind" data-kind={brief.kind}>
            {brief.kind === "finished" ? "Finished" : "Needs you"}
          </span>
        ) : null}
        {brief && !isWaiting(brief) ? <span className="secretary-bar-handled">Handled</span> : null}
        <span
          className="secretary-bar-state"
          data-tone={state.tone}
          title={state.detail ? `${state.text}: ${state.detail}` : undefined}
        >
          {state.text}
          {state.detail ? <span className="secretary-bar-detail">{state.detail}</span> : null}
        </span>
        <span className="secretary-bar-spacer" />
        {queue ? (
          <span className="secretary-bar-queue">
            <button
              type="button"
              className="secretary-bar-step"
              onMouseDown={keepFocus}
              onClick={() => step(-1)}
              disabled={!stepBrief(shown, briefs, -1)}
              title="The brief before"
              aria-label="Previous brief"
            >
              ‹
            </button>
            <span className="secretary-bar-place" title="Waiting briefs: Needs you first, then the oldest">
              {queue}
            </span>
            <button
              type="button"
              className="secretary-bar-step"
              onMouseDown={keepFocus}
              onClick={() => step(1)}
              disabled={!stepBrief(shown, briefs, 1)}
              title="The next brief"
              aria-label="Next brief"
            >
              ›
            </button>
          </span>
        ) : null}
        {controls.playShown ? (
          <button
            type="button"
            className="secretary-bar-btn"
            data-action="play"
            onMouseDown={keepFocus}
            onClick={() => void play()}
            disabled={!controls.canPlay}
            title={controls.canPlay ? "Play the brief from the start" : "The voice isn't ready yet"}
          >
            {key && played.has(key) ? "▶ Replay" : "▶ Play"}
          </button>
        ) : null}
        {controls.playShown || controls.canStop ? (
          <button
            type="button"
            className="secretary-bar-btn"
            data-action="stop"
            onMouseDown={keepFocus}
            onClick={stop}
            disabled={!controls.canStop}
            title="Stop the brief"
          >
            ■ Stop
          </button>
        ) : null}
        {controls.canDismiss ? (
          <button
            type="button"
            className="secretary-bar-btn"
            data-action="got-it"
            onMouseDown={keepFocus}
            onClick={gotIt}
            title="Mark this session read and go to the next brief"
          >
            Got it
          </button>
        ) : null}
        {brief ? (
          <button
            type="button"
            className="secretary-bar-btn"
            data-action="toggle"
            onMouseDown={keepFocus}
            onClick={() => {
              if (!open && replyable) focusReply.current = true;
              setOpen((o) => !o);
            }}
            title={open ? "Fold the bar" : replyable ? "Answer the dialog in words" : "Show the whole brief"}
          >
            {open ? "Less ▴" : replyable ? "Reply ▾" : "More ▾"}
          </button>
        ) : null}
      </header>
      <div className="secretary-bar-body">
        {body}
        {open && replies && exchangeCount > 0 ? (
          <div className="secretary-bar-exchanges" ref={exchangesRef}>
            {replies.exchanges.map((x, i) => (
              <div key={i} className="secretary-bar-exchange">
                <div className="secretary-bar-reply">{x.reply}</div>
                <div
                  className="secretary-bar-response"
                  data-outcome={x.outcome ?? "pending"}
                  title={x.detail}
                >
                  {x.response ?? (chinese ? "想一下…" : "Working on it…")}
                </div>
              </div>
            ))}
          </div>
        ) : null}
      </div>
      {boxShown ? (
        <form className="secretary-bar-replybox" onSubmit={send}>
          <textarea
            ref={replyBox}
            className="secretary-bar-input"
            rows={1}
            value={draftText}
            onChange={(e) => key && setDraft({ key, text: e.target.value })}
            onKeyDown={onReplyKey}
            placeholder={chinese ? "回复秘书：可以、不行、以后都可以……" : "Reply to the secretary: yes, no, always…"}
            aria-label="Reply to the secretary"
          />
          <button
            type="submit"
            className="secretary-bar-btn"
            onMouseDown={keepFocus}
            disabled={busy || !draftText.trim()}
          >
            Send
          </button>
        </form>
      ) : null}
    </section>
  );
}
