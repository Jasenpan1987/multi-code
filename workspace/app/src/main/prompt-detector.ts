// Detects when an agent's terminal output is showing an interactive prompt
// that is WAITING for the user to answer (e.g. a yes/no permission box, or a
// "Do you want to proceed?" choice). The session JSONL cannot distinguish
// "tool_use awaiting approval" from "tool_use auto-approved" — both look the
// same on disk — so we read the raw PTY text stream instead, which always
// renders the prompt box on screen.

// Strip ANSI escape sequences (colors, cursor moves) so the marker text can be
// matched against the visible characters. Covers CSI (\x1b[...) and a few
// common single-char escapes; good enough for plain prompt detection.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[()][0-9A-Za-z]|\x1b[=>]|\r/g;

function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

// Markers that appear when the CLI is waiting on a user choice. We only need
// ONE of these to match. They are chosen to be specific to the "waiting"
// footer / question, not normal output. Matching is done on ANSI-stripped,
// lowercased text.
const PROMPT_MARKERS = [
  "do you want to proceed?",
  "esc to cancel",
  "tab to amend",
  "ctrl+e to explain",
];

// How much recent output to keep for cross-chunk matching. A prompt box and
// its footer can arrive in separate PTY writes, so we match against a rolling
// tail rather than each chunk in isolation.
const TAIL_LIMIT = 4096;

// Minimum gap between two beeps from the same detector. A prompt box redraws
// on every arrow-key press (Yes <-> No), which would otherwise re-fire on each
// redraw. Throttling collapses those into one beep while still letting a fresh
// prompt some seconds later fire again. The user is the one driving the
// redraws, so they're already looking — no need to beep again immediately.
const REFIRE_COOLDOWN_MS = 8000;

export class PromptDetector {
  private tail = "";
  // -Infinity means "never fired", so the first matching prompt always beeps
  // regardless of the clock's starting value.
  private lastFiredAt = -Infinity;
  private readonly now: () => number;

  // `now` is injectable so tests can control time; defaults to Date.now.
  constructor(
    private readonly onPrompt: () => void,
    now: () => number = () => Date.now()
  ) {
    this.now = now;
  }

  feed(chunk: string) {
    const text = stripAnsi(chunk).toLowerCase();
    this.tail = (this.tail + text).slice(-TAIL_LIMIT);

    // Match against the rolling tail so a marker split across two PTY writes
    // still matches on the chunk that completes it. The time-based cooldown
    // (not a "marker disappeared" check) prevents re-firing on every redraw of
    // the same box while still allowing a genuinely new prompt to beep later.
    const showing = PROMPT_MARKERS.some((m) => this.tail.includes(m));
    if (!showing) return;

    const t = this.now();
    if (t - this.lastFiredAt < REFIRE_COOLDOWN_MS) return;
    this.lastFiredAt = t;
    this.onPrompt();
  }
}
