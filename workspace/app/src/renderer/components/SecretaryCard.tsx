// The secretary's card for one brief (epic voice-secretary, PRD Stories 3 and 7):
// the brief text, marked as the secretary's, with replay, stop and close. App opens
// it from a red-dot click and closes it when it stops being the shown contact's
// current brief (see secretaryBrief.ts); it is keyed by instance and seq, so one
// card only ever shows one brief.
//
// It plays the brief once on its own, as soon as the audio is ready: at once when
// the click finds it ready, or later while the text shows with the voice on its
// way. Stop before then cancels that. It sits over the top of the terminal area and
// never takes focus, so the terminal below stays usable; typing into it is the
// builder dealing with the event, which drops the brief in main and closes this.

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { MouseEvent } from "react";
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
import { briefCardView, briefLang } from "./secretaryBrief";
import type { CardNote } from "./secretaryBrief";

interface SecretaryCardProps {
  instanceId: string;
  name: string;
  brief: SecretaryBriefState;
  onClose: () => void;
}

// Buttons act on mouse up; swallowing mouse down keeps focus where it was, so a
// click on the card never pulls focus out of the terminal.
const keepFocus = (e: MouseEvent) => e.preventDefault();

export function SecretaryCard({ instanceId, name, brief, onClose }: SecretaryCardProps) {
  const { seq } = brief;
  const key = `${instanceId}#${seq}`;
  const view = briefCardView(brief);
  const playing = useSyncExternalStore(subscribeBriefPlayback, () => isBriefPlaying(key));
  const playFailed = useSyncExternalStore(subscribeBriefPlayback, () =>
    briefPlaybackFailed(key)
  );
  // Still to play on its own once the audio is ready.
  const [autoplay, setAutoplay] = useState(true);
  // Main had no audio for this seq any more: the brief was replaced or dropped, and
  // its update is on the way to close this card.
  const [stale, setStale] = useState(false);
  // Bumped by every play, stop and the close, so an audio fetch that comes back
  // after any of them is dropped.
  const request = useRef(0);

  const play = useCallback(async () => {
    const mine = ++request.current;
    if (replayBrief(key)) return;
    const wav = await window.electronAPI.getSecretaryAudio(instanceId, seq);
    if (mine !== request.current) return;
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
    stopBrief(key);
  };

  const canReplay = view.audioReady && !stale;
  // While it plays, or while it is still waiting to play on its own.
  const canStop = playing || (autoplay && view.voiceComing);
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
