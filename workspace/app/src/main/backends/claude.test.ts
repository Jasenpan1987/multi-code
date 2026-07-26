import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { ClaudeCompletionDetector } from "./claude";
import type { PromptDetail } from "../remote/promptExtract";

// Helpers to build the JSONL shapes the detector parses. Only the fields the
// detector actually inspects are populated; everything else is irrelevant.

function assistantToolUse(id: string, name = "Bash", input?: unknown): string {
  return JSON.stringify({
    type: "assistant",
    message: {
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id, name, input }],
    },
  });
}

function userToolResult(toolUseId: string): string {
  return JSON.stringify({
    type: "user",
    message: {
      content: [{ type: "tool_result", tool_use_id: toolUseId }],
    },
  });
}

interface Harness {
  jsonl: string;
  events: string[];
  // Full (type, detail) pairs, for the prompt payload a paired phone renders.
  calls: Array<{ type: string; detail?: PromptDetail }>;
  ptyIdle: boolean;
  detector: ClaudeCompletionDetector;
  append(line: string): void;
}

function makeHarness(): Harness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-detector-"));
  const jsonl = path.join(dir, "session.jsonl");
  fs.writeFileSync(jsonl, "");
  const events: string[] = [];
  const calls: Array<{ type: string; detail?: PromptDetail }> = [];
  const h: Harness = {
    jsonl,
    events,
    calls,
    ptyIdle: true,
    detector: null as unknown as ClaudeCompletionDetector,
    append(line: string) {
      fs.appendFileSync(jsonl, line + "\n");
    },
  };
  h.detector = new ClaudeCompletionDetector(
    jsonl,
    (type, detail) => {
      events.push(type);
      calls.push({ type, detail });
    },
    () => h.ptyIdle
  );
  return h;
}

describe("ClaudeCompletionDetector prompt detection", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires 'prompt' when a tool_use stays unpaired and PTY is idle", () => {
    const h = makeHarness();
    h.append(assistantToolUse("tu_1"));
    h.ptyIdle = true;

    // First poll picks up the line; tool_use is fresh, no fire.
    vi.advanceTimersByTime(500);
    expect(h.events).toEqual([]);

    // After 1.5s threshold + idle PTY, next poll fires "prompt" once.
    vi.advanceTimersByTime(1500);
    expect(h.events).toEqual(["prompt"]);

    h.detector.stop();
  });

  it("does NOT fire when PTY is still busy (spinner repainting)", () => {
    const h = makeHarness();
    h.append(assistantToolUse("tu_1"));
    h.ptyIdle = false; // subagent running, spinner ticking

    vi.advanceTimersByTime(5000);
    expect(h.events).toEqual([]);

    h.detector.stop();
  });

  it("does NOT fire for fast-paired auto-approved tools", () => {
    const h = makeHarness();
    h.append(assistantToolUse("tu_1", "Read"));
    h.append(userToolResult("tu_1"));
    h.ptyIdle = true;

    // Even after plenty of time, the pair was matched on the first poll
    // and removed from pending, so nothing should fire.
    vi.advanceTimersByTime(5000);
    expect(h.events).toEqual([]);

    h.detector.stop();
  });

  it("fires only once while the same prompt is on screen (latch)", () => {
    const h = makeHarness();
    h.append(assistantToolUse("tu_1"));
    h.ptyIdle = true;

    vi.advanceTimersByTime(2000);
    expect(h.events).toEqual(["prompt"]);

    // More polls while the user hasn't answered yet — must not re-fire.
    vi.advanceTimersByTime(5000);
    expect(h.events).toEqual(["prompt"]);

    h.detector.stop();
  });

  it("re-arms and fires again for a new prompt after the previous one clears", () => {
    const h = makeHarness();
    h.append(assistantToolUse("tu_1"));
    h.ptyIdle = true;

    vi.advanceTimersByTime(2000);
    expect(h.events).toEqual(["prompt"]);

    // User answers — tool_result clears the pending set, latch re-arms, and
    // "prompt-cleared" goes out so a paired phone drops its option buttons.
    h.append(userToolResult("tu_1"));
    vi.advanceTimersByTime(500);

    // New question arrives.
    h.append(assistantToolUse("tu_2"));
    vi.advanceTimersByTime(2000);
    expect(h.events).toEqual(["prompt", "prompt-cleared", "prompt"]);

    h.detector.stop();
  });

  it("emits 'prompt-cleared' exactly once when a prompt is answered", () => {
    const h = makeHarness();
    h.append(assistantToolUse("tu_1"));
    h.ptyIdle = true;
    vi.advanceTimersByTime(2000);

    h.append(userToolResult("tu_1"));
    vi.advanceTimersByTime(500);
    expect(h.events).toEqual(["prompt", "prompt-cleared"]);

    // Further idle polls with nothing pending must not repeat it — otherwise the
    // phone would churn on every tick.
    vi.advanceTimersByTime(5000);
    expect(h.events).toEqual(["prompt", "prompt-cleared"]);

    h.detector.stop();
  });

  it("does not emit 'prompt-cleared' for tools that never blocked", () => {
    const h = makeHarness();
    h.append(assistantToolUse("tu_1", "Read"));
    h.append(userToolResult("tu_1"));
    h.ptyIdle = true;

    vi.advanceTimersByTime(5000);
    expect(h.events).toEqual([]);

    h.detector.stop();
  });

  it("carries the decoded question and options on the prompt event", () => {
    const h = makeHarness();
    h.append(
      assistantToolUse("tu_1", "AskUserQuestion", {
        questions: [
          {
            question: "Which database?",
            options: [{ label: "Postgres" }, { label: "SQLite" }],
          },
        ],
      })
    );
    h.ptyIdle = true;
    vi.advanceTimersByTime(2000);

    const detail = h.calls.find((c) => c.type === "prompt")?.detail;
    expect(detail?.tool).toBe("AskUserQuestion");
    expect(detail?.question).toBe("Which database?");
    expect(detail?.options.map((o) => o.label)).toEqual([
      "Postgres",
      "SQLite",
      "Other",
    ]);

    h.detector.stop();
  });

  it("decodes the oldest pending tool_use, which is the one on screen", () => {
    const h = makeHarness();
    h.append(assistantToolUse("tu_1", "Bash", { command: "npm test" }));
    // A second tool_use written later must not steal the prompt payload from the
    // one the CLI is actually blocked on.
    vi.advanceTimersByTime(500);
    h.append(assistantToolUse("tu_2", "Write", { file_path: "/tmp/b.ts" }));
    h.ptyIdle = true;
    vi.advanceTimersByTime(2000);

    const detail = h.calls.find((c) => c.type === "prompt")?.detail;
    expect(detail?.tool).toBe("Bash");
    expect(detail?.question).toBe("Bash: npm test");

    h.detector.stop();
  });

  it("fires 'waiting' for end_turn (existing behavior preserved)", () => {
    const h = makeHarness();
    fs.appendFileSync(
      h.jsonl,
      JSON.stringify({
        type: "assistant",
        message: { stop_reason: "end_turn", content: [{ type: "text" }] },
      }) + "\n"
    );

    // checkForChanges reads the line and schedules a 2s notify.
    vi.advanceTimersByTime(500);
    expect(h.events).toEqual([]);
    vi.advanceTimersByTime(2000);
    expect(h.events).toContain("waiting");

    h.detector.stop();
  });
});
