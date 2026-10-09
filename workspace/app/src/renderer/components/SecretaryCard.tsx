// The secretary's card for one brief (epic voice-secretary, PRD Stories 3 and 7):
// the brief text, marked as the secretary's, with replay, stop and close. App opens
// it (see secretaryBrief.ts for when) and closes it when it stops being the shown
// contact's latest brief; it is keyed by instance and seq, so one card only ever
// shows one brief.
//
// Opened with `autoplay`, it plays the brief once on its own, as soon as the audio
// is ready: at once when it opens on a ready brief, or later while the text shows
// with the voice on its way. Stop before then cancels that. It sits over the top of
// the terminal area and never takes focus, so the terminal below stays usable;
// typing there marks the brief handled in main but leaves this card, its text and
// its replay as they are (T-527).
//
// A Needs-you card the secretary can answer has its own reply box (T-510), not the
// compose box: what the builder types or dictates goes to the secretary, which
// answers the dialog, asks back, or answers their question (T-509). The box takes
// focus only when clicked, and goes once the dialog is dealt with; the exchanges
// stay on the card.

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { FormEvent, KeyboardEvent, MouseEvent } from "react";
import type { SecretaryBriefState } from "../../shared/types";
import {
  briefPlaybackFailed,
  isBriefPlaying,
  playBrief,
  releaseBrief,
  replayBrief,
  stopBrief,
  subscribeBriefPlayback,
} from "../audio/briefPlayer";
import { briefCardView, briefLang, replyView } from "./secretaryBrief";
import type { CardNote } from "./secretaryBrief";

interface SecretaryCardProps {
  instanceId: string;
  name: string;
  brief: SecretaryBriefState;
  autoplay: boolean;
  onClose: () => void;
}

// Buttons act on mouse up; swallowing mouse down keeps focus where it was, so a
// click on the card never pulls focus out of the terminal.
const keepFocus = (e: MouseEvent) => e.preventDefault();

export function SecretaryCard({
  instanceId,
  name,
  brief,
  autoplay: playWhenReady,
  onClose,
}: SecretaryCardProps) {
  const { seq } = brief;
  const key = `${instanceId}#${seq}`;
  const view = briefCardView(brief);
  const replies = replyView(brief);
  const [draft, setDraft] = useState("");
  // Sent and not yet answered, as far as this card knows: main's pending exchange
  // takes a round trip to arrive, and a second reply meanwhile would be refused.
  const [sending, setSending] = useState(false);
  const busy = sending || replies.pending;
  const exchangesEnd = useRef<HTMLDivElement>(null);
  const exchangeCount = replies.exchanges.length;
  useEffect(() => {
    exchangesEnd.current?.scrollIntoView({ block: "nearest" });
  }, [exchangeCount, replies.pending]);

  const send = (e?: FormEvent) => {
    e?.preventDefault();
    const text = draft.trim();
    if (!text || busy) return;
    setDraft("");
    setSending(true);
    void window.electronAPI
      .replyToSecretary(instanceId, seq, text)
      .finally(() => setSending(false));
  };
  // Enter sends; Shift+Enter is a new line. Not while an input method is composing,
  // where Enter picks the characters (Chinese pinyin, Japanese kana).
  const onReplyKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
    e.preventDefault();
    send();
  };
  const playing = useSyncExternalStore(subscribeBriefPlayback, () => isBriefPlaying(key));
  const playFailed = useSyncExternalStore(subscribeBriefPlayback, () =>
    briefPlaybackFailed(key)
  );
  // Still to play on its own once the audio is ready.
  const [autoplay, setAutoplay] = useState(playWhenReady);
  // Main had no audio for this seq any more: the brief was replaced or dropped, and
  // its update is on the way to close this card.
  const [stale, setStale] = useState(false);
  // Bumped by every play, stop and the close, so an audio fetch that comes back
  // after any of them is dropped.
  const request = useRef(0);
  // An audio fetch is on its way: Stop must work then too, or the fetch would
  // start the brief right after the builder asked it not to.
  const [fetching, setFetching] = useState(false);

  const play = useCallback(async () => {
    const mine = ++request.current;
    if (replayBrief(key)) return;
    setFetching(true);
    const wav = await window.electronAPI.getSecretaryAudio(instanceId, seq);
    if (mine !== request.current) return;
    setFetching(false);
    if (!wav) {
      setStale(true);
      return;
    }
    playBrief(key, wav);
  }, [instanceId, seq, key]);

  useEffect(() => {
    if (!autoplay || !view.audioReady) return;
    setAutoplay(false);
    void play();
  }, [autoplay, view.audioReady, play]);

  useEffect(
    () => () => {
      request.current++;
      releaseBrief(key);
    },
    [key]
  );

  const stop = () => {
    request.current++;
    setAutoplay(false);
    setFetching(false);
    stopBrief(key);
  };

  const canReplay = view.audioReady && !stale;
  // While it plays, while its audio is being fetched, or while it is still
  // waiting to play on its own.
  const canStop = playing || fetching || (autoplay && view.voiceComing);
  const note: CardNote | null = stale
    ? { tone: "muted", text: "This brief is out of date" }
    : playFailed
      ? { tone: "warn", text: "Couldn't play the voice" }
      : view.note;

  return (
    <section className="secretary-card" data-kind={brief.kind} aria-label="Secretary brief">
      <header className="secretary-card-head">
        <span className="secretary-card-badge">Secretary</span>
        <span className="secretary-card-name" title={name}>
          {name}
        </span>
        <span className="secretary-card-kind" data-kind={brief.kind}>
          {view.kindLabel}
        </span>
        {playing ? <span className="secretary-card-playing">Playing</span> : null}
        <span className="secretary-card-spacer" />
        <button
          type="button"
          className="secretary-card-btn"
          data-action="replay"
          onMouseDown={keepFocus}
          onClick={() => void play()}
          disabled={!canReplay}
          title="Play the brief from the start"
        >
          ▶ Replay
        </button>
        <button
          type="button"
          className="secretary-card-btn"
          data-action="stop"
          onMouseDown={keepFocus}
          onClick={stop}
          disabled={!canStop}
          title={playing ? "Stop the brief" : "Don't play it when the voice is ready"}
        >
          ■ Stop
        </button>
        <button
          type="button"
          className="secretary-card-close"
          onMouseDown={keepFocus}
          onClick={onClose}
          title="Close the card"
        >
          ×
        </button>
      </header>
      {view.text !== null ? (
        <div className="secretary-card-text" lang={briefLang(view.language)}>
          {view.text}
        </div>
      ) : null}
      {exchangeCount > 0 ? (
        <div className="secretary-card-exchanges">
          {replies.exchanges.map((x, i) => (
            <div key={i} className="secretary-card-exchange">
              <div className="secretary-card-reply">{x.reply}</div>
              <div
                className="secretary-card-response"
                data-outcome={x.outcome ?? "pending"}
                title={x.detail}
              >
                {x.response ?? (brief.status === "ready" && brief.language === "Chinese" ? "想一下…" : "Working on it…")}
              </div>
            </div>
          ))}
          <div ref={exchangesEnd} />
        </div>
      ) : null}
      {replies.boxShown ? (
        <form className="secretary-card-replybox" onSubmit={send}>
          <textarea
            className="secretary-card-input"
            rows={1}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onReplyKey}
            placeholder={
              brief.status === "ready" && brief.language === "Chinese"
                ? "回复秘书：可以、不行、以后都可以……"
                : "Reply to the secretary: yes, no, always…"
            }
            aria-label="Reply to the secretary"
          />
          <button
            type="submit"
            className="secretary-card-btn"
            onMouseDown={keepFocus}
            disabled={busy || !draft.trim()}
          >
            Send
          </button>
        </form>
      ) : null}
      {note ? (
        <div
          className="secretary-card-note"
          data-tone={note.tone}
          title={note.detail ? `${note.text}: ${note.detail}` : undefined}
        >
          {note.text}
          {note.detail ? (
            <span className="secretary-card-detail">{note.detail}</span>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
