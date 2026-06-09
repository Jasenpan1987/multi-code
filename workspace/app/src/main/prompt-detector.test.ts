import { describe, it, expect } from "vitest";
import { PromptDetector } from "./prompt-detector";

function detector() {
  let fires = 0;
  const d = new PromptDetector(() => {
    fires++;
  });
  return {
    feed: (s: string) => d.feed(s),
    fires: () => fires,
  };
}

// A long stretch of ordinary output — enough to push the prompt marker out of
// the detector's rolling tail so it re-arms.
const SCROLL = "x".repeat(5000);

// The standard input-box footer hint. The CLI redraws this on every keystroke
// while you type a normal message, so it must NOT be treated as a prompt.
const INPUT_FOOTER = "  Esc to cancel · Tab to amend · ctrl+e to explain";

// The real waiting-prompt box, as it appears in the terminal.
const REAL_PROMPT = [
  "Do you want to proceed?",
  "❯ 1. Yes",
  "  2. No",
  "",
  "Esc to cancel · Tab to amend · ctrl+e to explain",
].join("\n");

describe("PromptDetector", () => {
  it("fires on a yes/no permission prompt", () => {
    const d = detector();
    d.feed(REAL_PROMPT);
    expect(d.fires()).toBe(1);
  });

  it("does not fire on ordinary output", () => {
    const d = detector();
    d.feed("Running tests...\nAll 42 passed.\n$ ");
    expect(d.fires()).toBe(0);
  });

  it("matches even when ANSI color/cursor codes are interleaved", () => {
    const d = detector();
    // Bold + color around the question, cursor moves between lines.
    d.feed(
      "\x1b[1m\x1b[33mDo you want to proceed?\x1b[0m\r\n" +
        "\x1b[36m❯ 1. Yes\x1b[0m\r\n  2. No\r\n"
    );
    expect(d.fires()).toBe(1);
  });

  it("matches a marker split across two PTY chunks", () => {
    const d = detector();
    d.feed("...some output...\nDo you want to pro");
    expect(d.fires()).toBe(0);
    d.feed("ceed?\n❯ 1. Yes\n  2. No\n");
    expect(d.fires()).toBe(1);
  });

  it("only beeps once while the user arrows between Yes/No (redraws)", () => {
    const d = detector();
    d.feed(REAL_PROMPT); // initial render
    d.feed(REAL_PROMPT); // redraw after pressing down-arrow
    d.feed(REAL_PROMPT); // redraw after pressing up-arrow
    expect(d.fires()).toBe(1);
  });

  it("does NOT beep on the input-box footer while typing a normal message", () => {
    const d = detector();
    // Each keystroke redraws the footer hint. None of these is a real prompt.
    for (let i = 0; i < 10; i++) {
      d.feed("h" + INPUT_FOOTER);
    }
    expect(d.fires()).toBe(0);
  });

  it("does NOT beep when a project's terminal repaints its footer", () => {
    const d = detector();
    // Switching to a project repaints its input box (footer + content),
    // but there is no pending question.
    d.feed("Some earlier output\n" + INPUT_FOOTER);
    expect(d.fires()).toBe(0);
  });

  it("beeps again for a genuinely new prompt once the old one is gone", () => {
    const d = detector();
    d.feed(REAL_PROMPT);
    expect(d.fires()).toBe(1);
    // User answers; lots of new output scrolls the old prompt out of the tail.
    d.feed(SCROLL);
    d.feed("more work happened\n" + REAL_PROMPT);
    expect(d.fires()).toBe(2);
  });

  it("does not re-beep across redraws separated by minor output", () => {
    const d = detector();
    d.feed(REAL_PROMPT);
    d.feed("\x1b[2K"); // a clear-line redraw, marker still in tail
    d.feed(REAL_PROMPT);
    expect(d.fires()).toBe(1);
  });
});
