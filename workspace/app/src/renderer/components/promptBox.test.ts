// Screens copied from real sessions on 2026-11-11 (Claude Code 2.1.322 classic
// renderer, OpenCode 2.2.2), trailing spaces trimmed.

import { describe, expect, it } from "vitest";
import { findPromptBox } from "./promptBox";

const RULE = "─".repeat(65);

describe("findPromptBox: Claude", () => {
  const idle = [
    "❯ Use the AskUserQuestion tool to ask me one question",
    "",
    "● Done.",
    "",
    RULE,
    "❯",
    RULE,
    "  0 (0.0%)",
    "  ⏵⏵ auto mode on (shift+tab to cycle) · ← 3 agents",
    "                                              ◉ xhigh · /effort",
    "",
  ];

  it("finds the empty input between its rules", () => {
    expect(findPromptBox("claude", idle)).toEqual({ top: 4, bottom: 6, typed: false });
  });

  it("is not fooled by a submitted prompt echoed above", () => {
    expect(findPromptBox("claude", idle)?.top).toBe(4);
  });

  it("says when the builder typed into it, over several rows", () => {
    const typed = [RULE, "❯ fix the login", "  redirect please", RULE, "  ⏵⏵ auto mode on"];
    expect(findPromptBox("claude", typed)).toEqual({ top: 0, bottom: 3, typed: true });
  });

  it("finds nothing while a question is open", () => {
    const question = [
      RULE,
      " ☐ Color",
      "",
      "Which color do you choose?",
      "",
      "❯ 1. Red",
      "     Choose the color red.",
      "  2. Blue",
      "  3. Type something.",
      RULE,
      "  4. Chat about this",
      "",
      "Enter to select · ↑/↓ to navigate · Esc to cancel",
    ];
    expect(findPromptBox("claude", question)).toBeNull();
  });

  it("finds nothing under the trust dialog at start", () => {
    const trust = [
      RULE,
      " Accessing workspace:",
      " /private/tmp/mc-gate-test/proj",
      " Claude Code'll be able to read, edit, and execute files here.",
      " ❯ No, exit",
      "   Yes, I trust this folder",
      " Enter to confirm · Esc to cancel",
    ];
    expect(findPromptBox("claude", trust)).toBeNull();
  });

  it("finds nothing when an option sits right under a rule", () => {
    expect(findPromptBox("claude", [RULE, "❯ 1. Yes", "  2. No", RULE])).toBeNull();
  });

  it("finds nothing on a blank screen", () => {
    expect(findPromptBox("claude", ["", "", ""])).toBeNull();
  });
});

describe("findPromptBox: OpenCode", () => {
  const BOTTOM = "  ╹" + "▀".repeat(60);

  it("finds the input on the start screen, its hint not counted as typed", () => {
    const home = [
      "             ▀▀▀▀ █▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀",
      "",
      "                    /update to install v2.2.7",
      "",
      "  ┃",
      '  ┃  Ask anything… "Fix broken tests"',
      "  ┃",
      "  ┃  Build · GPT-6.1 Sol GitHub Copilot",
      BOTTOM,
      "  /…/t…/mc-bar/opencode-test  shift+tab agents  ctrl+p commands",
    ];
    expect(findPromptBox("opencode", home)).toEqual({
      top: 4,
      bottom: 8,
      typed: false,
      status: "Build · GPT-6.1 Sol GitHub Copilot",
    });
  });

  it("finds the input in a session, not the builder's message with the same bar", () => {
    const session = [
      " • Single word reply test        +",
      "",
      "  ┃",
      "  ┃  Reply with the single word: ok",
      "  ┃",
      "",
      "     ok",
      "",
      "     Build · GPT-6.1 Sol · 4.4s · 1.6 tok/s",
      "",
      "  ┃",
      "  ┃",
      "  ┃",
      "  ┃  Build · GPT-6.1 Sol GitHub Copilot",
      BOTTOM,
      "  /private/tmp/mc-bar/opencode-test           5.9K (1%) · $0.01",
    ];
    expect(findPromptBox("opencode", session)).toMatchObject({ top: 10, bottom: 14, typed: false });
  });

  it("says when the builder typed into it", () => {
    const typed = ["  ┃", "  ┃  fix the login", "  ┃", "  ┃  Build · GPT-6.1 Sol GitHub Copilot", BOTTOM];
    expect(findPromptBox("opencode", typed)?.typed).toBe(true);
  });

  it("finds nothing without the agent line", () => {
    expect(findPromptBox("opencode", ["  ┃  Allow bash: rm -rf build?", "  ┃  1. Allow  2. Deny", BOTTOM])).toBeNull();
  });

  it("finds nothing without the closing line", () => {
    expect(findPromptBox("opencode", ["  ┃", "  ┃  Build · GPT-6.1 Sol GitHub Copilot", ""])).toBeNull();
  });
});
