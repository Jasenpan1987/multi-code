// The terminal fallback (mockup 4.1): the session's real terminal, for what the
// chat can't show (an MCP form, a TUI of the CLI's own), with the keys a phone
// keyboard lacks and a line that types into it.
//
// The terminal is xterm.js at the PTY's own size (`snapshot` / `resize`), never
// fitted to the phone: the CLIs paint absolutely positioned cells for that width,
// so a narrower terminal would scramble them. It scrolls sideways instead.
//
// App keeps this screen mounted, hidden, while the session's chat is on screen, so
// going to the chat and back keeps the xterm, its scrollback and the typed line:
// no resubscribe, no replay. It goes when the session is closed.
//
// Keys and the line go out as `input` on an open link only (`sendInput` is false
// otherwise; nothing is queued), so offline they are disabled and the screen says
// why.

import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef, useState, type RefObject } from "react";
import type { RemoteSessionState } from "../../shared/remote-protocol";
import { ConnectionBanner } from "../components/Connection";
import { navigate } from "../routes";
import { useActions, useApp } from "../store";
import { sessionOf } from "../state";
import { KEYS, TERMINAL_THEME } from "../terminal";
import "./terminal.css";

const PILLS: Record<RemoteSessionState, { label: string; className: string }> = {
  "needs-you": { label: "Needs you", className: "need" },
  working: { label: "Working", className: "work" },
  finished: { label: "Finished", className: "done" },
  idle: { label: "Idle", className: "idle" },
};

export function TerminalScreen({ id, hidden = false }: { id: string; hidden?: boolean }) {
  const actions = useActions();
  const instance = useApp((s) => s.instances?.find((i) => i.id === id));
  const session = useApp((s) => sessionOf(s, id));
  const connected = useApp((s) => s.connection.state === "connected");
  const [text, setText] = useState("");
  const [typing, setTyping] = useState(false);
  const screenRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Marked text of an IME (pinyin before it becomes characters) isn't sent, and
  // the line isn't cleared under it (WebKit 255857).
  const composing = useRef(false);

  // Live only for a session the Mac lists as running: one it no longer lists has
  // nothing to type into (the desktop drops input for it).
  const listed = useApp((s) => s.instances !== null);
  const running = instance?.status === "running";
  const live = connected && running;
  const why = !connected
    ? "Not connected to your Mac: keys and text can't reach the terminal."
    : running || !listed
      ? null
      : instance
        ? "This session isn't running."
        : "This session isn't on your Mac any more.";

  // As the chat's header has it (SessionScreen.tsx).
  const pill = instance ? (running ? PILLS[instance.state] : { className: "idle", label: "Stopped" }) : null;

  useKeyboardFrame(screenRef, typing && !hidden);

  const send = () => {
    if (!live || !text || composing.current) return;
    if (actions.sendInput(id, text)) setText("");
  };

  return (
    <div ref={screenRef} className={`screen terminal-screen${typing ? " typing" : ""}`} hidden={hidden}>
      <div className="topbar">
        <a className="tap back" href="#/" aria-label="Sessions">
          ‹
        </a>
        <div className="title">
          {instance?.name ?? id}
          <span className="sub">Terminal</span>
        </div>
        {pill && <span className={`pill ${pill.className}`}>{pill.label}</span>}
        <button className="tap chat" aria-label="Chat" onClick={() => navigate({ screen: "session", id })}>
          ☰
        </button>
      </div>
      <ConnectionBanner since={session.refreshedAt} />
      <TerminalView id={id} input={inputRef} />
      <div className="screen-foot term-foot">
        {why && (
          <div className="term-why" role="status">
            {why}
          </div>
        )}
        <div className="keyrow" onMouseDown={keepFocus}>
          {KEYS.map((key) => (
            <button
              key={key.name}
              type="button"
              tabIndex={-1}
              className={key.danger ? "key r" : "key"}
              aria-label={key.name}
              data-key={key.name}
              aria-disabled={!live}
              onClick={() => live && actions.sendInput(id, key.data)}
            >
              {key.label}
            </button>
          ))}
        </div>
        <div className="tinput">
          {/* Return on the keyboard does nothing here: an IME's commit Return can't be
              told from a real one on iOS, so the line goes with Send. */}
          <input
            ref={inputRef}
            type="text"
            value={text}
            placeholder="Type into the terminal…"
            autoCapitalize="off"
            autoCorrect="off"
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setText(e.target.value)}
            onFocus={() => setTyping(true)}
            onBlur={() => setTyping(false)}
            onCompositionStart={() => (composing.current = true)}
            onCompositionEnd={() => (composing.current = false)}
          />
          <button
            type="button"
            tabIndex={-1}
            className="send"
            aria-disabled={!live || !text}
            onMouseDown={keepFocus}
            onClick={send}
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}

// A tap on a key or on Send leaves the focus in the input line: moving it, even to
// nothing, puts the iPhone's keyboard away (Orca #5106). Focus moves as the default
// of mousedown, so that is cancelled. Not pointerdown's: in WebKit that cancels the
// mouse events of a touch, the click included, and the key would do nothing.
function keepFocus(e: { preventDefault(): void }) {
  e.preventDefault();
}

// The xterm, in a box that scrolls both ways: sideways across the PTY's width, and
// down to the bottom rows when the keyboard leaves less room than the rows need.
// The box stays at the bottom, where the CLIs draw their input box and dialogs,
// unless it is scrolled away.
function TerminalView({ id, input }: { id: string; input: RefObject<HTMLInputElement | null> }) {
  const actions = useActions();
  const areaRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  // This xterm's width, once a snapshot has painted it.
  const [cols, setCols] = useState<number | null>(null);
  const [wide, setWide] = useState(false);

  useEffect(() => {
    const area = areaRef.current;
    const box = boxRef.current;
    const host = hostRef.current;
    if (!area || !box || !host) return;

    const term = new Terminal({
      fontFamily: "Menlo, 'SF Mono', monospace",
      fontSize: 10.5,
      lineHeight: 1.15,
      theme: TERMINAL_THEME,
      scrollback: 1000,
      cursorBlink: false,
      disableStdin: true,
    });
    term.open(host);
    // Typing goes through the line below. xterm's own textarea would take the focus
    // on a tap and open a keyboard that types nowhere.
    if (term.textarea) {
      term.textarea.readOnly = true;
      term.textarea.tabIndex = -1;
      term.textarea.inputMode = "none";
    }

    // Where the box was scrolled, kept while it is on screen: hidden (the chat is
    // up) it has no size, and coming back it is put where it was. At the bottom it
    // stays there until scrolled up: WebKit also fires a scroll event, at the top,
    // when the box first overflows, and that must not count as leaving the bottom.
    let atBottom = true;
    let left = 0;
    let top = 0;
    const showsEnd = () =>
      area.classList.toggle("at-end", box.scrollLeft + box.clientWidth >= box.scrollWidth - 2);
    const onScroll = () => {
      if (box.clientHeight === 0) return;
      const bottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 2;
      atBottom = bottom || (atBottom && box.scrollTop >= top);
      left = box.scrollLeft;
      top = box.scrollTop;
      showsEnd();
    };
    const layout = () => {
      if (box.clientHeight === 0) return;
      box.scrollTop = atBottom ? box.scrollHeight : top;
      box.scrollLeft = left;
      setWide(host.offsetWidth > box.clientWidth);
      showsEnd();
    };
    const resized = new ResizeObserver(layout);
    resized.observe(box);
    resized.observe(host);
    box.addEventListener("scroll", onScroll, { passive: true });

    // Every drag on the terminal is a native scroll, so a sideways swipe always
    // moves the box. The touch lands on xterm's viewport, its own native scroller
    // for the scrollback (terminal.css lets touches through the screen above it):
    // up and down scroll the scrollback, sideways (and up or down at its ends) the
    // box. xterm's script scrolling is kept out: it would move the scrollback a
    // second time, and cancelling the touch to do so would stop the box from
    // scrolling sideways at the first bit of vertical jitter.
    const keepFromXterm = (e: TouchEvent) => e.stopPropagation();
    // A tap on the terminal puts the keyboard away (it covers half of the terminal)
    // and does nothing else: xterm would focus its textarea.
    const onMouseDown = (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      input.current?.blur();
    };
    box.addEventListener("touchstart", keepFromXterm, { capture: true, passive: true });
    box.addEventListener("touchmove", keepFromXterm, { capture: true, passive: true });
    box.addEventListener("mousedown", onMouseDown, { capture: true });

    // The snapshot replaces the screen: on attach (the store's buffer so far) and
    // after every resubscribe (a reconnect). The CLIs repaint on every update, so
    // the replayed tail ends on the current screen. xterm parses what it is given
    // later, in order, so the replacement goes in band: CAN abandons a sequence a
    // dropped link left half written, then RIS resets the terminal. A resize joins
    // the same order (a write's callback runs once everything before it is
    // parsed), so output still waiting isn't parsed at a width it wasn't painted
    // for.
    let disposed = false;
    const resizeInOrder = (c: number, r: number) => term.write("", () => disposed || term.resize(c, r));
    const detach = actions.attachTerminal(id, {
      snapshot(data, c, r) {
        term.write("\x18\x1bc");
        resizeInOrder(c, r);
        term.write(data);
        setCols(c);
      },
      output(data) {
        term.write(data);
      },
      resize(c, r) {
        resizeInOrder(c, r);
        setCols(c);
      },
    });

    return () => {
      detach();
      resized.disconnect();
      box.removeEventListener("scroll", onScroll);
      box.removeEventListener("touchstart", keepFromXterm, { capture: true });
      box.removeEventListener("touchmove", keepFromXterm, { capture: true });
      box.removeEventListener("mousedown", onMouseDown, { capture: true });
      disposed = true;
      term.dispose();
    };
  }, [actions, id, input]);

  return (
    <div ref={areaRef} className="term-area">
      <div ref={boxRef} className="term-box">
        <div ref={hostRef} className="term-host" />
      </div>
      {cols === null && <p className="term-waiting">Waiting for the terminal…</p>}
      {wide && cols !== null && (
        <>
          <div className="term-edge" />
          <div className="term-cols">{cols} cols · swipe ⇆</div>
        </>
      )}
    </div>
  );
}

// The key row and the line sit right above the keyboard. iOS has no VirtualKeyboard
// API and doesn't shrink the page for the keyboard: it pans the visual viewport.
// So while the line has focus the screen takes the visual viewport's height and
// follows its pan. Only then: in a Home Screen app on iOS 27 visualViewport.height
// stays ~68 px short after the first keyboard (WebKit 322900), so with the keyboard
// down the screen goes back to the full height its CSS gives it.
function useKeyboardFrame(screen: RefObject<HTMLDivElement | null>, active: boolean) {
  useEffect(() => {
    const viewport = window.visualViewport;
    const el = screen.current;
    if (!active || !viewport || !el) return;
    const place = () => {
      el.style.height = `${viewport.height}px`;
      el.style.transform = `translateY(${viewport.offsetTop}px)`;
    };
    place();
    viewport.addEventListener("resize", place);
    viewport.addEventListener("scroll", place);
    return () => {
      viewport.removeEventListener("resize", place);
      viewport.removeEventListener("scroll", place);
      el.style.height = "";
      el.style.transform = "";
    };
  }, [screen, active]);
}
