// The compose box (PRD Story 4, mockups 2.1 and 2.3): a textarea and a Send button,
// and only the button sends. Return is a new line, so a Chinese IME's Return (which
// commits the composition) can never send half a message: the textarea has no key
// handler at all. The text is the parent's (the session's draft, drafts.ts), so a
// refused message can be put back in it; this component has no state or hooks.

import type { MouseEvent } from "react";
import "./compose.css";

export interface ComposeProps {
  text: string;
  onText: (text: string) => void;
  onSend: () => void;
  placeholder: string;
  // A line above the box ("Queued until this turn ends").
  hint?: string;
}

// The textarea keeps the focus, and the keyboard stays up, when Send is tapped.
const keepFocus = (e: MouseEvent) => e.preventDefault();

export function Compose({ text, onText, onSend, placeholder, hint }: ComposeProps) {
  return (
    <div className="compose-box">
      {hint && <div className="hint">{hint}</div>}
      <div className="compose">
        {/* The wrapper grows with the text (its ::after holds a copy), and the
            textarea fills it: no measuring, up to the CSS's max-height. */}
        <div className="grow" data-value={text}>
          <textarea
            value={text}
            rows={1}
            placeholder={placeholder}
            aria-label="Message"
            enterKeyHint="enter"
            autoCapitalize="sentences"
            onChange={(e) => onText(e.target.value)}
          />
        </div>
        <button className="send" aria-label="Send" disabled={text.trim() === ""} onMouseDown={keepFocus} onClick={onSend}>
          <span>↑</span>
        </button>
      </div>
    </div>
  );
}
