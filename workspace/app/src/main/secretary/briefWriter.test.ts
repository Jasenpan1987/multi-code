// The brief writer with the CLI faked: the input it builds from an event, how a
// long turn is cut to fit, how the model's answer is held to the contract, and
// that `writeBriefFor` gathers the material for an instance and never throws.

import { beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import type { SecretaryEvent } from "../process-manager";
import type { TranscriptEntry } from "../../shared/remote-protocol";
import type { BuilderTurn } from "../backends/types";
import type { CliOptions, CliResult } from "./cli";

const fakes = vi.hoisted(() => ({
  source: (_id: string): { name: string; backend?: string; sessionId?: string } | null => null,
  // A Claude session's JSONL, read by the real reader.
  jsonlFor: (_sessionId: string): string | null => null,
  // An OpenCode session's turn, as its backend would read it.
  opencodeTurn: (_sessionId: string): BuilderTurn | null => null,
  readFrom: [] as { backend: string; sessionId: string }[],
  calls: [] as { systemPrompt: string; stdin: string; options: CliOptions }[],
  answer: async (): Promise<CliResult> => ({
    ok: true,
    output: { language: "English", brief: "eat-what is done." },
  }),
}));

vi.mock("../process-manager", () => ({
  processManager: { secretarySource: (id: string) => fakes.source(id) },
}));
vi.mock("../backends", () => ({
  getBackend: (backend: string) => ({
    readBuilderTurn: async (sessionId: string) => {
      fakes.readFrom.push({ backend, sessionId });
      if (backend === "opencode") return fakes.opencodeTurn(sessionId);
      const file = fakes.jsonlFor(sessionId);
      if (!file) return null;
      const { readBuilderTurn } = await import("../backends/claudeTranscript");
      return readBuilderTurn(file);
    },
  }),
}));
vi.mock("./cli", async (orig) => ({
  ...(await orig<typeof import("./cli")>()),
  runJsonPrompt: (systemPrompt: string, stdin: string, options: CliOptions) => {
    fakes.calls.push({ systemPrompt, stdin, options });
    return fakes.answer();
  },
}));

const {
  INPUT_BUDGET_CHARS,
  SYSTEM_PROMPT,
  TEXT_CLIP_CHARS,
  buildBriefInput,
  parseBrief,
  writeBrief,
  writeBriefFor,
} = await import("./briefWriter");
type BriefWriterInput = import("./briefWriter").BriefWriterInput;

const finished: SecretaryEvent = { kind: "finished", seq: 1, at: 0 };
const bashPermission: SecretaryEvent = {
  kind: "needs-you",
  seq: 2,
  at: 0,
  prompt: {
    toolName: "Bash",
    toolInput: { command: "git push origin main", description: "Push to main" },
    detail: {
      tool: "Bash",
      question: "Push to main",
      options: [{ label: "Yes" }, { label: "Yes, and don't ask again" }, { label: "No" }],
    },
  },
};
// An MCP elicitation: the agent is stopped, but no dialog decoded into options.
const elicitation: SecretaryEvent = { kind: "needs-you", seq: 3, at: 0 };

const material = (event: SecretaryEvent, turn: TranscriptEntry[] = []) => ({
  session: "eat-what",
  event,
  builderLatestMessage: "push it",
  builderEarlierMessages: ["fix the build", "now the tests"],
  turn,
});

const entry = (i: number, size = 100): TranscriptEntry => ({
  kind: "assistant",
  text: `${i}:${"x".repeat(size)}`,
});

beforeEach(() => {
  fakes.source = () => null;
  fakes.jsonlFor = () => null;
  fakes.opencodeTurn = () => null;
  fakes.readFrom = [];
  fakes.calls = [];
  fakes.answer = async () => ({
    ok: true,
    output: { language: "English", brief: "eat-what is done." },
  });
});

describe("the prompt", () => {
  it("is the spike's prompt as of v10 (the STE80 template), byte for byte", () => {
    // docs/timeline/2026-10-08_brief-writer-spike.md, "Final system prompt" (v7), its
    // T-522 addendum (v8), its T-528 addendum (v9) and its T-532 addendum (v10). A
    // deliberate change gets a new hash here and a line there.
    expect(crypto.createHash("sha256").update(SYSTEM_PROMPT).digest("hex")).toBe(
      "afa401f1c547c31138fd9f528846b63d3dbaa3f83014a22868cd6f91485399a3"
    );
  });
});

describe("buildBriefInput", () => {
  it("builds a finished event's input in the spike's format", () => {
    const turn = [entry(1, 3)];
    expect(buildBriefInput(material(finished, turn))).toEqual({
      session: "eat-what",
      event: "finished",
      builderLatestMessage: "push it",
      builderEarlierMessages: ["fix the build", "now the tests"],
      turn,
    });
  });

  it("passes a dialog's tool, its raw input, the question and every option", () => {
    const input = buildBriefInput(material(bashPermission));
    expect(input.event).toBe("needs-you");
    expect(input.prompt).toEqual({
      toolName: "Bash",
      toolInput: { command: "git push origin main", description: "Push to main" },
      question: "Push to main",
      options: [{ label: "Yes" }, { label: "Yes, and don't ask again" }, { label: "No" }],
    });
  });

  it("has no prompt for a needs-you that didn't decode, such as an MCP elicitation", () => {
    const input = buildBriefInput(material(elicitation, [entry(1)]));
    expect(input.event).toBe("needs-you");
    expect(input).not.toHaveProperty("prompt");
  });

  it("sends an empty latest message when the builder typed none", () => {
    const input = buildBriefInput({
      session: "x",
      event: finished,
      builderEarlierMessages: [],
      turn: [entry(1)],
    });
    expect(input.builderLatestMessage).toBe("");
  });

  it("leaves an input that fits untouched", () => {
    const input = buildBriefInput(material(finished, [entry(1), entry(2)]));
    expect(input.turn).toHaveLength(2);
    expect(input).not.toHaveProperty("turnEntriesDropped");
  });
});

describe("truncation", () => {
  it("drops from the front of the turn until it fits, and says how many", () => {
    const turn = Array.from({ length: 2000 }, (_, i) => entry(i));
    const input = buildBriefInput(material(finished, turn));
    const serialized = JSON.stringify(input);
    expect(serialized.length).toBeLessThanOrEqual(INPUT_BUDGET_CHARS);
    const dropped = input.turnEntriesDropped ?? 0;
    expect(dropped).toBeGreaterThan(0);
    expect(input.turn).toEqual(turn.slice(dropped));
    // As many as fit: one more entry would not have.
    const oneMore = { ...input, turn: turn.slice(dropped - 1), turnEntriesDropped: dropped - 1 };
    expect(JSON.stringify(oneMore).length).toBeGreaterThan(INPUT_BUDGET_CHARS);
  });

  it("keeps the builder's messages whole", () => {
    const turn = Array.from({ length: 2000 }, (_, i) => entry(i));
    const input = buildBriefInput(material(finished, turn));
    expect(input.builderLatestMessage).toBe("push it");
    expect(input.builderEarlierMessages).toEqual(["fix the build", "now the tests"]);
    expect(input.session).toBe("eat-what");
  });

  it("always keeps the last entry, clipped when it alone is over the budget", () => {
    const turn = [entry(1), entry(2), entry(3, INPUT_BUDGET_CHARS * 2)];
    const input = buildBriefInput(material(finished, turn));
    expect(JSON.stringify(input).length).toBeLessThanOrEqual(INPUT_BUDGET_CHARS);
    const last = input.turn.at(-1);
    expect(last?.text.startsWith("3:xxx")).toBe(true);
    expect(last?.text).toContain("more characters]");
    expect(last?.text.length).toBeLessThan(TEXT_CLIP_CHARS + 50);
  });

  it("fits the budget even when the fields besides the turn are over it", () => {
    const long = "y".repeat(TEXT_CLIP_CHARS * 2);
    const write: SecretaryEvent = {
      kind: "needs-you",
      seq: 5,
      at: 0,
      prompt: {
        toolName: "MultiEdit",
        toolInput: { edits: Array.from({ length: 10 }, () => ({ old: long, new: long })) },
        detail: { tool: "MultiEdit", options: [{ label: "Yes" }, { label: "No" }] },
      },
    };
    const input = buildBriefInput({
      ...material(write, [entry(1, long.length)]),
      builderLatestMessage: long,
      builderEarlierMessages: [long, long, long],
    });
    expect(JSON.stringify(input).length).toBeLessThanOrEqual(INPUT_BUDGET_CHARS);
    expect(input.prompt?.options).toEqual([{ label: "Yes" }, { label: "No" }]);
    expect(input.builderLatestMessage.startsWith("yyy")).toBe(true);
  });

  it("fits the budget even for a tool input made of hundreds of small fields", () => {
    const edits = Array.from({ length: 300 }, () => ({
      old_string: "o".repeat(1000),
      new_string: "n".repeat(1000),
    }));
    const multiEdit: SecretaryEvent = {
      kind: "needs-you",
      seq: 6,
      at: 0,
      prompt: {
        toolName: "MultiEdit",
        toolInput: { file_path: "/p/a.ts", edits },
        detail: { tool: "MultiEdit", options: [{ label: "Yes" }, { label: "No" }] },
      },
    };
    const input = buildBriefInput(material(multiEdit, [entry(1)]));
    expect(JSON.stringify(input).length).toBeLessThanOrEqual(INPUT_BUDGET_CHARS);
    expect(typeof input.prompt?.toolInput).toBe("string");
    expect(input.prompt?.toolInput as string).toContain('"file_path":"/p/a.ts"');
    expect(input.prompt?.toolName).toBe("MultiEdit");
  });

  it("never cuts a character in half", () => {
    const emoji = "a".repeat(TEXT_CLIP_CHARS - 1) + "😀b";
    const input = buildBriefInput({ ...material(finished), builderLatestMessage: emoji });
    const message = input.builderLatestMessage;
    expect(message.startsWith("a".repeat(TEXT_CLIP_CHARS - 1) + "…")).toBe(true);
    expect(/[\ud800-\udbff](?![\udc00-\udfff])/.test(message)).toBe(false);
  });

  it("clips a huge pasted message and huge strings in the tool input", () => {
    const pasted = "规格".repeat(TEXT_CLIP_CHARS);
    const write: SecretaryEvent = {
      kind: "needs-you",
      seq: 4,
      at: 0,
      prompt: {
        toolName: "Write",
        toolInput: { file_path: "/p/a.ts", content: "y".repeat(TEXT_CLIP_CHARS * 3) },
        detail: { tool: "Write", options: [{ label: "Yes" }, { label: "No" }] },
      },
    };
    const input = buildBriefInput({ ...material(write), builderLatestMessage: pasted });
    expect(input.builderLatestMessage.startsWith(pasted.slice(0, TEXT_CLIP_CHARS))).toBe(true);
    expect(input.builderLatestMessage).toContain(`[${pasted.length - TEXT_CLIP_CHARS} more characters]`);
    const toolInput = input.prompt?.toolInput as { file_path: string; content: string };
    expect(toolInput.file_path).toBe("/p/a.ts");
    expect(toolInput.content.length).toBeLessThan(TEXT_CLIP_CHARS + 50);
  });
});

describe("parseBrief", () => {
  it("accepts the two-key contract", () => {
    expect(parseBrief({ language: "Chinese", brief: " 好了。 " })).toEqual({
      ok: true,
      language: "Chinese",
      text: "好了。",
    });
  });

  it("ignores extra keys", () => {
    expect(
      parseBrief({ language: "English", brief: "Done.", language_note: "mixed", reasoning: null })
    ).toEqual({ ok: true, language: "English", text: "Done." });
  });

  it("refuses an unknown or missing language", () => {
    expect(parseBrief({ language: "Japanese", brief: "x" }).ok).toBe(false);
    expect(parseBrief({ language: "english", brief: "x" }).ok).toBe(false);
    expect(parseBrief({ brief: "x" }).ok).toBe(false);
  });

  it("refuses a missing, empty or non-string brief", () => {
    expect(parseBrief({ language: "English" }).ok).toBe(false);
    expect(parseBrief({ language: "English", brief: "  " }).ok).toBe(false);
    expect(parseBrief({ language: "English", brief: ["a"] }).ok).toBe(false);
  });
});

describe("writeBrief", () => {
  const input: BriefWriterInput = buildBriefInput(material(finished, [entry(1, 3)]));

  it("sends the prompt and the input as compact JSON, and returns the brief", async () => {
    const seen: { systemPrompt: string; stdin: string }[] = [];
    const brief = await writeBrief(input, {
      run: async (systemPrompt, stdin) => {
        seen.push({ systemPrompt, stdin });
        return { ok: true, output: { language: "English", brief: "eat-what is done." } };
      },
    });
    expect(brief).toEqual({ ok: true, language: "English", text: "eat-what is done." });
    expect(seen[0].systemPrompt).toBe(SYSTEM_PROMPT);
    expect(seen[0].stdin).toBe(JSON.stringify(input));
  });

  it("hands the signal to the CLI call", async () => {
    const controller = new AbortController();
    let got: AbortSignal | undefined;
    await writeBrief(input, {
      signal: controller.signal,
      run: async (_p, _s, options) => {
        got = options.signal;
        return { ok: false, reason: "aborted" };
      },
    });
    expect(got).toBe(controller.signal);
  });

  it("passes the CLI's failure through", async () => {
    const brief = await writeBrief(input, {
      run: async () => ({ ok: false, reason: "Not logged in · Please run /login" }),
    });
    expect(brief).toEqual({ ok: false, reason: "Not logged in · Please run /login" });
  });

  it("fails an answer that breaks the contract", async () => {
    const brief = await writeBrief(input, {
      run: async () => ({ ok: true, output: { language: "English" } }),
    });
    expect(brief.ok).toBe(false);
  });

  it("never throws, even when the call does", async () => {
    const brief = await writeBrief(input, {
      run: async () => {
        throw new Error("boom");
      },
    });
    expect(brief).toEqual({ ok: false, reason: "boom" });
  });
});

describe("writeBriefFor", () => {
  let dir = "";
  const writeSession = (rows: unknown[]) => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "multicode-brief-"));
    const file = path.join(dir, "ses-1.jsonl");
    fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
    return file;
  };
  const typed = (content: string) => ({ type: "user", message: { role: "user", content } });
  const says = (text: string) => ({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text }] },
  });

  const lastInput = (): BriefWriterInput => JSON.parse(fakes.calls[fakes.calls.length - 1].stdin);

  it("gathers the alias, the builder's messages and the turn from the current session", async () => {
    const file = writeSession([
      typed("修一下构建"),
      says("好的。"),
      typed("ok, push it to main"),
      says("Pushed."),
    ]);
    fakes.source = (id) =>
      id === "inst-1" ? { name: "eat-what", backend: "claude", sessionId: "ses-1" } : null;
    fakes.jsonlFor = (sessionId) => (sessionId === "ses-1" ? file : null);
    try {
      const brief = await writeBriefFor("inst-1", finished);
      expect(brief).toEqual({ ok: true, language: "English", text: "eat-what is done." });
      expect(fakes.readFrom).toEqual([{ backend: "claude", sessionId: "ses-1" }]);
      expect(lastInput()).toEqual({
        session: "eat-what",
        event: "finished",
        builderLatestMessage: "ok, push it to main",
        builderEarlierMessages: ["修一下构建"],
        turn: [{ kind: "assistant", text: "Pushed." }],
      });
      expect(fakes.calls[0].systemPrompt).toBe(SYSTEM_PROMPT);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads an OpenCode session through its own backend", async () => {
    fakes.source = () => ({ name: "phase", backend: "opencode", sessionId: "ses_oc" });
    fakes.opencodeTurn = (sessionId) =>
      sessionId === "ses_oc"
        ? {
            builderLatestMessage: "把测试跑一下",
            builderEarlierMessages: [],
            turn: [
              { kind: "tool", tool: "bash", text: "pnpm test" },
              { kind: "assistant", text: "全部通过。" },
            ],
          }
        : null;
    expect((await writeBriefFor("inst-2", finished)).ok).toBe(true);
    expect(fakes.readFrom).toEqual([{ backend: "opencode", sessionId: "ses_oc" }]);
    expect(lastInput()).toEqual({
      session: "phase",
      event: "finished",
      builderLatestMessage: "把测试跑一下",
      builderEarlierMessages: [],
      turn: [
        { kind: "tool", tool: "bash", text: "pnpm test" },
        { kind: "assistant", text: "全部通过。" },
      ],
    });
  });

  it("is a failure, not a throw, for an unknown instance", async () => {
    expect(await writeBriefFor("nope", finished)).toEqual({
      ok: false,
      reason: "no such session",
    });
    expect(fakes.calls).toHaveLength(0);
  });

  it("never throws when gathering does", async () => {
    fakes.source = () => {
      throw new Error("registry unreadable");
    };
    expect(await writeBriefFor("inst-1", finished)).toEqual({
      ok: false,
      reason: "registry unreadable",
    });
  });

  it("briefs a dialog from its tool call alone when there is no transcript", async () => {
    fakes.source = () => ({ name: "eat-what" });
    const brief = await writeBriefFor("inst-1", bashPermission);
    expect(brief.ok).toBe(true);
    expect(lastInput()).toMatchObject({
      session: "eat-what",
      event: "needs-you",
      prompt: { toolName: "Bash", toolInput: { command: "git push origin main" } },
      builderLatestMessage: "",
      builderEarlierMessages: [],
      turn: [],
    });
  });

  it("refuses a finished turn with no transcript rather than invent one", async () => {
    fakes.source = () => ({ name: "eat-what", sessionId: "ses-gone" });
    expect(await writeBriefFor("inst-1", finished)).toEqual({
      ok: false,
      reason: "nothing to brief from: no transcript for this session",
    });
    expect(fakes.calls).toHaveLength(0);
  });

  it("briefs an MCP elicitation from the turn", async () => {
    const file = writeSession([
      typed("look up the ticket"),
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "t1", name: "mcp__jira__get", input: {} }],
        },
      },
    ]);
    fakes.source = () => ({ name: "eat-what", sessionId: "ses-1" });
    fakes.jsonlFor = () => file;
    try {
      expect((await writeBriefFor("inst-1", elicitation)).ok).toBe(true);
      expect(lastInput()).not.toHaveProperty("prompt");
      expect(lastInput().turn).toEqual([
        { kind: "tool", tool: "mcp__jira__get", text: "", pending: true },
      ]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolves aborted without a call for an already aborted signal", async () => {
    fakes.source = () => ({ name: "eat-what" });
    const controller = new AbortController();
    controller.abort();
    expect(await writeBriefFor("inst-1", bashPermission, controller.signal)).toEqual({
      ok: false,
      reason: "aborted",
    });
    expect(fakes.calls).toHaveLength(0);
  });

  it("hands its signal to the CLI, which kills it and resolves aborted", async () => {
    fakes.source = () => ({ name: "eat-what" });
    const controller = new AbortController();
    fakes.answer = async () => ({ ok: false, reason: "aborted" });
    const brief = await writeBriefFor("inst-1", bashPermission, controller.signal);
    expect(fakes.calls[0].options.signal).toBe(controller.signal);
    expect(brief).toEqual({ ok: false, reason: "aborted" });
  });
});
