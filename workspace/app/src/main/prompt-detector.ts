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

// Markers that mean the CLI is asking a question and WAITING for the user to
// answer. These must be specific to the question itself — NOT the input-box
// footer. The "Esc to cancel · Tab to amend · ctrl+e to explain" hint is drawn
// on every keystroke while you type a normal message too, so matching on it
// beeps on every character typed and every time a project's terminal repaints.
// "do you want to proceed?" only appears on a real permission/choice box.
const PROMPT_MARKERS = ["do you want to proceed?"];

// How much recent output to keep for cross-chunk matching. A prompt box and
// its question line can arrive in separate PTY writes, so we match against a
// rolling tail rather than each chunk in isolation.
const TAIL_LIMIT = 4096;

export class PromptDetector {
  private tail = "";
  // Edge-triggered: we beep once when the prompt first appears, then latch
  // until it disappears. While the box stays on screen it redraws on every
  // arrow-key press / keystroke, but the latch swallows those redraws. Only
  // when the marker is gone (user answered, new output flowed) do we re-arm,
  // so the next genuine prompt beeps again.
  private armed = true;

  constructor(private readonly onPrompt: () => void) {}

  feed(chunk: string) {
    const text = stripAnsi(chunk).toLowerCase();
    this.tail = (this.tail + text).slice(-TAIL_LIMIT);

    const showing = PROMPT_MARKERS.some((m) => this.tail.includes(m));

    if (!showing) {
      // Marker gone — re-arm so the next prompt can fire.
      this.armed = true;
      return;
    }

    if (!this.armed) return;
    this.armed = false;
    this.onPrompt();
  }
}
