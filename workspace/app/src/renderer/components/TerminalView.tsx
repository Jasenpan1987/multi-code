import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import type { IDisposable, IMarker } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { THEMES, getCurrentTheme } from "../themes";
import { useTheme } from "../hooks/useTheme";
import { findMdPaths } from "./mdPathMatch";
import {
  awayFromLatest,
  findReplyStart,
  replyNeedle,
  replyOnScreen,
} from "../../shared/replyStart";
import type { OpencodeViewCommand } from "../../shared/replyStart";
import type { BackendName } from "../../shared/types";

interface TerminalViewProps {
  instanceId: string;
  active: boolean;
}

const terminals = new Map<string, { terminal: Terminal; fitAddon: FitAddon }>();

// Lines kept above the screen. xterm's default, 1000, is less than one long turn
// in Claude Code's classic renderer, and the builder scrolls up through the steps
// by hand. A full line of 150 columns is about 1.8 KB, so 9 MB a terminal at most.
const SCROLLBACK_LINES = 5000;

// A finished turn whose terminal was out of sight: the needle of its conclusion,
// shown from the first line once the terminal is (see jumpToReplyStart). Dropped
// when the next turn starts (cancelReplyJump).
const pendingReplyJumps = new Map<string, { needle: string; opencode: boolean }>();

// Each terminal's latest jump, numbered across all terminals. One still waiting for
// the screen gives up once a newer one starts or it is cancelled.
const replyJumps = new Map<string, number>();
let replyJumpSeq = 0;

// Keys that only start a chord. Pressed on their own they aren't the builder at work.
const MODIFIER_KEYS = new Set(["Meta", "Alt", "Shift", "Control"]);

// OpenCode redraws the end of a turn as it reports it, and redraws again as a
// terminal shown at a new size is fitted: its screen is read once the output has
// been quiet this long, or after the longest wait.
const SCREEN_QUIET_MS = 300;
const SCREEN_SETTLE_MAX_MS = 2000;
// How long one of OpenCode's view commands gets to show on screen, read this often.
const VIEW_KEY_WAIT_MS = 1500;
const SCREEN_POLL_MS = 50;

// The row each terminal's last jump put at the top, so the next turn's end can tell
// the builder hasn't scrolled since. A message sent from the compose box or the
// phone leaves the screen there, and that isn't reading higher up.
const parkedAt = new Map<string, IMarker>();

// Number of lines of slack allowed when deciding "at the bottom". xterm's
// viewportY equals baseY only when fully scrolled down; a couple of lines of
// tolerance keeps the stuck-prompt workaround firing when the user is
// effectively (but not exactly) at the bottom, while still treating a
// deliberate scroll-up as "away from bottom".
const AT_BOTTOM_SLACK = 2;

// True when the viewport is at (or within a couple of lines of) the last
// screenful of the buffer. Used to decide whether scrolling to the bottom is
// wanted: when the user has scrolled up to read/select, this is false and we
// leave the viewport alone.
function isAtBottom(terminal: Terminal): boolean {
  const buf = terminal.buffer.active;
  return buf.baseY - buf.viewportY <= AT_BOTTOM_SLACK;
}

/**
 * Sizes the scroll area from the terminal's real height. xterm 5.5 sizes it from
 * the viewport's height as output arrives, and out of sight (display: none) that
 * height is 0: the area comes out a screen short, and the wheel stops a screen
 * above the bottom until the next line of output. Call it once the terminal shows.
 * Not in xterm's public API; nothing happens if a later xterm moves it.
 */
export function syncScrollArea(terminal: Terminal): void {
  const core = (terminal as unknown as {
    _core?: { viewport?: { syncScrollArea(immediate: boolean): void } };
  })._core;
  core?.viewport?.syncScrollArea(true);
}

export function getTerminal(instanceId: string): Terminal | undefined {
  return terminals.get(instanceId)?.terminal;
}

// Out of sight: an unselected contact's terminal, or the folded terminal pane.
function isShown(terminal: Terminal): boolean {
  return (terminal.element?.offsetWidth ?? 0) > 0;
}

/**
 * Whether the CLI draws into the terminal's scrollback, which a reply can be
 * scrolled to in: Claude Code's classic renderer. Its fullscreen renderer and
 * OpenCode draw on the alternate screen and scroll themselves.
 */
export function showsScrollback(instanceId: string): boolean {
  return terminals.get(instanceId)?.terminal.buffer.active.type === "normal";
}

// Puts the conclusion's first row at the top of the screen, a row of space above
// it. Left alone when that row is on screen already, or can't be found.
function scrollToReplyStart(instanceId: string, terminal: Terminal, needle: string): void {
  const buf = terminal.buffer.active;
  if (buf.type !== "normal") return;
  const at = findReplyStart(
    (i) => buf.getLine(i)?.translateToString(true),
    buf.length,
    needle
  );
  if (at < 0) return;
  // On screen already: at the bottom, a short conclusion is there whole.
  if (at >= buf.viewportY && at < buf.viewportY + terminal.rows) return;
  const top = Math.max(0, at - 1);
  terminal.scrollToLine(top);
  // A marker rather than the row's number: it follows the row when old lines are
  // dropped off the top of the scrollback.
  parkedAt.get(instanceId)?.dispose();
  const marker = terminal.registerMarker(top - (buf.baseY + buf.cursorY));
  if (marker) parkedAt.set(instanceId, marker);
  else parkedAt.delete(instanceId);
}

// Still where the last jump left it: the builder hasn't scrolled since.
function isParked(instanceId: string, terminal: Terminal): boolean {
  const marker = parkedAt.get(instanceId);
  return (
    marker !== undefined &&
    !marker.isDisposed &&
    terminal.buffer.active.viewportY === marker.line
  );
}

// What the screen shows now, a row a line.
function screenRows(terminal: Terminal): string[] {
  const buf = terminal.buffer.active;
  const rows: string[] = [];
  for (let i = 0; i < terminal.rows; i++) {
    rows.push(buf.getLine(buf.viewportY + i)?.translateToString(true) ?? "");
  }
  return rows;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function outputSettled(terminal: Terminal): Promise<void> {
  return new Promise((resolve) => {
    const deadline = Date.now() + SCREEN_SETTLE_MAX_MS;
    let timer: ReturnType<typeof setTimeout>;
    const done = () => {
      sub.dispose();
      clearTimeout(timer);
      resolve();
    };
    const sub = terminal.onWriteParsed(() => {
      clearTimeout(timer);
      timer = setTimeout(done, Math.min(SCREEN_QUIET_MS, Math.max(0, deadline - Date.now())));
    });
    timer = setTimeout(done, SCREEN_QUIET_MS);
  });
}

async function screenShows(terminal: Terminal, test: (rows: string[]) => boolean): Promise<boolean> {
  const deadline = Date.now() + VIEW_KEY_WAIT_MS;
  while (Date.now() < deadline) {
    if (test(screenRows(terminal))) return true;
    await sleep(SCREEN_POLL_MS);
  }
  return test(screenRows(terminal));
}

// A jump's own number; the function says whether it is still the terminal's latest.
function startReplyJump(instanceId: string): () => boolean {
  const job = ++replyJumpSeq;
  replyJumps.set(instanceId, job);
  return () => replyJumps.get(instanceId) === job;
}

/**
 * Stops a jump still waiting for the screen and drops one waiting for the terminal to
 * show: the builder is at work in the terminal (a key, a click, the wheel), or the
 * next turn started (a message typed, or from the compose box or the phone). Not
 * on what xterm sends the CLI by itself: focus and mouse-motion reports, and its
 * replies to the CLI's queries, which OpenCode makes on a resize.
 */
export function cancelReplyJump(instanceId: string): void {
  replyJumps.set(instanceId, ++replyJumpSeq);
  pendingReplyJumps.delete(instanceId);
}

// OpenCode draws on the alternate screen and scrolls itself, so its own commands do
// it, on the keys Multi-Code binds in its terminals (shared/replyStart.ts). Left alone
// when the conclusion's first row is on screen already, and, when it was shown as the
// turn ended, when OpenCode says the view is away from the bottom: the builder
// scrolled up to read. Otherwise to the bottom if needed, then to the last message.
// Back to the bottom when that isn't the conclusion after all, as it was. Stops
// pressing once cancelled or a newer jump starts.
async function showOpencodeReply(
  instanceId: string,
  terminal: Terminal,
  needle: string,
  shownAsItEnded: boolean,
  current: () => boolean
): Promise<void> {
  const press = (command: OpencodeViewCommand) => window.electronAPI.sendViewKey(instanceId, command);

  await outputSettled(terminal);
  if (!current() || replyOnScreen(screenRows(terminal), needle)) return;
  if (awayFromLatest(screenRows(terminal))) {
    if (shownAsItEnded) return;
    press("session.last");
    // OpenCode hides "Jump to latest" at once and scrolls 50 ms later (`toBottom` in
    // packages/tui/src/routes/session/index.tsx, 2.0.32), so its redraw is waited for
    // too: "previous" pressed before the scroll goes from the old place.
    await screenShows(terminal, (rows) => !awayFromLatest(rows));
    await outputSettled(terminal);
    if (!current() || replyOnScreen(screenRows(terminal), needle)) return;
  }
  press("session.message.previous");
  if (await screenShows(terminal, (rows) => replyOnScreen(rows, needle))) return;
  if (current()) press("session.last");
}

// Claude Code's classic renderer: xterm's own scrollback, once the CLI has finished
// drawing (its "Worked for" line comes after the turn's end is reported, and a
// terminal shown at a new size is redrawn after its fit). Out of sight by then, it
// waits for the terminal to show. Shown as the turn ended, only from the bottom or
// from where the last jump left it; shown later, wherever it was left.
async function showScrollbackReply(
  instanceId: string,
  terminal: Terminal,
  needle: string,
  shownAsItEnded: boolean,
  current: () => boolean
): Promise<void> {
  await outputSettled(terminal);
  if (!current()) return;
  if (!isShown(terminal)) {
    pendingReplyJumps.set(instanceId, { needle, opencode: false });
    return;
  }
  if (!shownAsItEnded || isAtBottom(terminal) || isParked(instanceId, terminal)) {
    scrollToReplyStart(instanceId, terminal, needle);
  }
}

// Whether a finished turn can be shown from its conclusion's first line here.
function canJumpToReply(instanceId: string, backend: BackendName | undefined): boolean {
  return backend === "opencode" ? terminals.has(instanceId) : showsScrollback(instanceId);
}

/**
 * A turn just finished: show its conclusion from its first line. Shown, at once, if
 * the screen is at the bottom or still where the last jump left it. Shown and
 * scrolled up by the builder, not at all: they are reading there. Out of sight, once
 * it next shows, wherever it was left.
 *
 * The jump is claimed before the transcript is read, so a cancel that comes while the
 * read is in flight (a message sent at the chime) stops it too.
 */
export function showReplyOnFinish(instanceId: string, backend: BackendName | undefined): void {
  if (!canJumpToReply(instanceId, backend)) return;
  const current = startReplyJump(instanceId);
  void window.electronAPI.readReplyConclusion(instanceId).then((conclusion) => {
    const terminal = terminals.get(instanceId)?.terminal;
    const needle = conclusion ? replyNeedle(conclusion) : null;
    if (!terminal || !needle || !current()) return;
    const opencode = backend === "opencode";
    if (!isShown(terminal)) {
      pendingReplyJumps.set(instanceId, { needle, opencode });
      return;
    }
    if (opencode) void showOpencodeReply(instanceId, terminal, needle, true, current);
    else void showScrollbackReply(instanceId, terminal, needle, true, current);
  });
}

export function applyMainThemeToAll() {
  const palette = THEMES[getCurrentTheme()].mainTerminal;
  for (const { terminal } of terminals.values()) {
    terminal.options.theme = palette;
  }
}

/**
 * Everything a terminal sends goes to its session as it is: the builder's keys and
 * pastes, and xterm's own replies to the CLI's queries (cursor position, device
 * attributes), which a CLI can be waiting on. Nothing is filtered here: a drop
 * holds the builder's input where it starts (dropFlow's holdInput). Exported for
 * the tests.
 */
export function forwardToSession(
  terminal: Terminal,
  instanceId: string,
  write = (id: string, data: string) => window.electronAPI.writeToInstance(id, data)
): IDisposable {
  return terminal.onData((data) => write(instanceId, data));
}

export function TerminalView({ instanceId, active }: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const initializedRef = useRef(false);
  const { theme } = useTheme();

  useEffect(() => {
    if (!containerRef.current || initializedRef.current) return;
    initializedRef.current = true;

    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "Menlo, Monaco, 'Courier New', monospace",
      minimumContrastRatio: 7,
      theme: THEMES[getCurrentTheme()].mainTerminal,
      allowProposedApi: true,
      scrollback: SCROLLBACK_LINES,
    });

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(new WebLinksAddon());

    // Make .md / .markdown paths in the output clickable: clicking opens the
    // file in the Markdown View (and expands it) via the same open-path bridge
    // the Git section uses. The buffer line text is scanned per line; ranges
    // are 1-based (xterm convention) and inclusive.
    terminal.registerLinkProvider({
      provideLinks(bufferLineNumber, callback) {
        const line = terminal.buffer.active.getLine(bufferLineNumber - 1);
        if (!line) {
          callback(undefined);
          return;
        }
        const text = line.translateToString(true);
        const matches = findMdPaths(text);
        if (matches.length === 0) {
          callback(undefined);
          return;
        }
        callback(
          matches.map((match) => ({
            text: match.path,
            range: {
              start: { x: match.start + 1, y: bufferLineNumber },
              end: { x: match.end + 1, y: bufferLineNumber },
            },
            activate(_event, path) {
              window.dispatchEvent(
                new CustomEvent("md-open", {
                  detail: { id: instanceId, path },
                })
              );
            },
          }))
        );
      },
    });

    terminals.set(instanceId, { terminal, fitAddon });

    // macOS terminal emulators (Terminal.app, iTerm2) translate a few Cmd+
    // shortcuts to readline-equivalent control bytes before forwarding to the
    // PTY. xterm.js does not do this by default, so we replicate the
    // translation here. Both Claude Code and OpenCode honor these.
    terminal.attachCustomKeyEventHandler((e) => {
      // The builder typing here: a jump waiting for the screen leaves it to them.
      if (e.type === "keydown" && !MODIFIER_KEYS.has(e.key)) cancelReplyJump(instanceId);
      if (e.type === "keydown" && e.metaKey) {
        // Cmd+Backspace / Cmd+Delete -> Ctrl+U (clear input line).
        if (e.key === "Backspace" || e.key === "Delete") {
          window.electronAPI.writeToInstance(instanceId, "\x15");
          return false;
        }
        // Cmd+Left -> Ctrl+A (jump to line start).
        if (e.key === "ArrowLeft") {
          window.electronAPI.writeToInstance(instanceId, "\x01");
          return false;
        }
        // Cmd+Right -> Ctrl+E (jump to line end).
        if (e.key === "ArrowRight") {
          window.electronAPI.writeToInstance(instanceId, "\x05");
          return false;
        }
        // Cmd+L summons the compose box. Swallow it (return false) so xterm
        // never forwards an `l` or escape sequence to the PTY, then ask the
        // app to open the box for this instance. Chosen over Ctrl+L to avoid
        // the terminal's clear-screen binding.
        if (e.key.toLowerCase() === "l") {
          window.dispatchEvent(
            new CustomEvent("compose-open", { detail: { id: instanceId } })
          );
          return false;
        }
      }
      return true;
    });

    terminal.open(containerRef.current);
    // The builder clicking or scrolling here; mouse motion alone isn't them at work.
    const container = containerRef.current;
    const builderAtWork = () => cancelReplyJump(instanceId);
    container.addEventListener("mousedown", builderAtWork, true);
    container.addEventListener("wheel", builderAtWork, { capture: true, passive: true });
    // Not when it opens out of sight (a folded or unselected pane): there it
    // measures a few columns wide. It is fitted once it shows.
    if (containerRef.current.offsetWidth > 0) fitAddon.fit();

    // Notify main process of initial size
    window.electronAPI.resizeInstance(instanceId, terminal.cols, terminal.rows);

    // Send terminal input to main process
    forwardToSession(terminal, instanceId);

    // Handle resize
    terminal.onResize(({ cols, rows }) => {
      window.electronAPI.resizeInstance(instanceId, cols, rows);
    });

    // Listen for PTY output destined for this terminal
    const handlePtyData = (event: Event) => {
      const { id, data } = (event as CustomEvent).detail;
      if (id === instanceId) {
        terminal.write(data);
      }
    };
    window.addEventListener("pty-data", handlePtyData);

    return () => {
      window.removeEventListener("pty-data", handlePtyData);
      container.removeEventListener("mousedown", builderAtWork, true);
      container.removeEventListener("wheel", builderAtWork, true);
    };
  }, [instanceId]);

  // Re-apply theme to this instance's terminal when the app theme changes.
  useEffect(() => {
    const entry = terminals.get(instanceId);
    if (!entry) return;
    entry.terminal.options.theme = THEMES[theme].mainTerminal;
  }, [theme, instanceId]);

  // Handle fit on visibility change and window resize
  useEffect(() => {
    if (!active) return;

    const entry = terminals.get(instanceId);
    if (!entry) return;

    const { terminal, fitAddon } = entry;

    // Fit when becoming active (delay to ensure container is sized).
    // Scroll to the bottom afterwards ONLY when the user was already at/near
    // the bottom: when the viewport got out of sync after a resize /
    // hide-show cycle the prompt row can end up below the visible area until
    // the next PTY redraw — most easily reproduced by scrolling to the bottom
    // and then losing the prompt. scrollToBottom forces the viewport back onto
    // the last buffer line. If the user has deliberately scrolled up (to read
    // or select), leave the viewport where it is. The scroll area is resized
    // too: output that came while hidden left it a screen short.
    const refit = () => {
      // Not while its pane is folded away: hidden, it measures a few columns
      // wide, and fitting it would shrink the session to that. Unfolding refits.
      if (!containerRef.current?.offsetWidth) return;
      const atBottom = isAtBottom(terminal);
      try {
        fitAddon.fit();
      } catch {
        // ignore — container may not be ready yet
      }
      syncScrollArea(terminal);
      if (atBottom) terminal.scrollToBottom();
      // A turn that finished while this terminal was out of sight.
      const pending = pendingReplyJumps.get(instanceId);
      if (pending) {
        pendingReplyJumps.delete(instanceId);
        const current = startReplyJump(instanceId);
        if (pending.opencode) void showOpencodeReply(instanceId, terminal, pending.needle, false, current);
        else void showScrollbackReply(instanceId, terminal, pending.needle, false, current);
      }
    };
    requestAnimationFrame(refit);

    window.addEventListener("resize", refit);
    window.addEventListener("layout-resize", refit);
    return () => {
      window.removeEventListener("resize", refit);
      window.removeEventListener("layout-resize", refit);
    };
  }, [instanceId, active]);

  // When the user clicks back into the terminal, force the viewport to the
  // bottom in case it got stuck mid-buffer (rare xterm.js race that hides the
  // prompt until the next redraw). Skip this when the user is copying/pasting
  // (an active selection) or has scrolled up to read — otherwise a single
  // click would yank the viewport down and interrupt them.
  const handleClick = () => {
    const entry = terminals.get(instanceId);
    if (!entry) return;
    const { terminal } = entry;
    if (terminal.hasSelection()) return;
    if (!isAtBottom(terminal)) return;
    terminal.scrollToBottom();
  };

  return (
    <div
      ref={containerRef}
      className="terminal-container"
      style={{ display: active ? "block" : "none", width: "100%", height: "100%" }}
      onClick={handleClick}
    />
  );
}

export function cleanupTerminal(instanceId: string) {
  const entry = terminals.get(instanceId);
  if (entry) {
    entry.terminal.dispose();
    terminals.delete(instanceId);
  }
  pendingReplyJumps.delete(instanceId);
  parkedAt.delete(instanceId);
  // A jump still running for it gives up at its next look.
  replyJumps.delete(instanceId);
}
