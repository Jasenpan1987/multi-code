import { describe, it, expect } from "vitest";
import { PromptDetector } from "./prompt-detector";

function detector() {
  let fires = 0;
  let clock = 0;
  const d = new PromptDetector(
    () => {
      fires++;
    },
    () => clock
  );
  return {
    feed: (s: string) => d.feed(s),
    fires: () => fires,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

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
    d.advance(200);
    d.feed(REAL_PROMPT); // redraw after pressing down-arrow
    d.advance(200);
    d.feed(REAL_PROMPT); // redraw after pressing up-arrow
    expect(d.fires()).toBe(1);
  });

  it("beeps again for a genuinely new prompt after the cooldown", () => {
    const d = detector();
    d.feed(REAL_PROMPT);
    expect(d.fires()).toBe(1);
    d.advance(9000); // past the 8s cooldown
    d.feed("more work happened\n" + REAL_PROMPT);
    expect(d.fires()).toBe(2);
  });
});
