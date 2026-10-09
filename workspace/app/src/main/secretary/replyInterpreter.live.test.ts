// The reply interpreter on the real CLI and Bedrock: PRD Story 6's replies, and
// M2's "done when" list, against dialogs shaped as the CLI raises them.
// Skipped unless MULTICODE_LIVE is set: it spawns `claude` and costs money.
//
//   MULTICODE_LIVE=1 npx vitest run src/main/secretary/replyInterpreter.live.test.ts

import { describe, expect, it, vi } from "vitest";

vi.mock("../process-manager", () => ({}));

const { interpretReply } = await import("./replyInterpreter");
const { checkChoice } = await import("./dialog");
import type { Dialog } from "./dialog";
import type { ReplyExchange } from "./replyInterpreter";

const permission = (command: string): Dialog => ({
  kind: "permission",
  backend: "claude",
  toolName: "Bash",
  toolInput: { command },
  options: [
    { effect: "allow-once", label: "Yes" },
    { effect: "allow-always", label: "Yes, and don't ask again" },
    { effect: "deny", label: "No" },
  ],
});

const plan: Dialog = {
  kind: "plan",
  plan: "# Plan: Create hello.txt\nUse the Write tool to create hello.txt with the word hi.",
  options: [
    { effect: "approve-auto", label: "Yes, and auto-accept edits" },
    { effect: "approve", label: "Yes, manually approve edits" },
    { effect: "revise", label: "No, tell Claude what to change" },
  ],
};

const opt = (label: string) => ({ label, description: `${label}` });
const questions: Dialog = {
  kind: "questions",
  backend: "claude",
  questions: [
    { question: "Which framework?", multiSelect: false, options: [opt("React"), opt("Vue (Recommended)")] },
    { question: "Which features?", multiSelect: true, options: [opt("Login"), opt("Search"), opt("Payments")] },
    { question: "Which host?", multiSelect: false, options: [opt("AWS"), opt("Fly")] },
  ],
};
const color: Dialog = {
  kind: "questions",
  backend: "claude",
  questions: [{ question: "Which color should the button be?", multiSelect: false, options: [opt("Red"), opt("Blue")] }],
};

const BRIEF = "eat-what 那边需要你批准一步。";

// `confirm`: the wider choice, which the secretary asks to confirm before pressing.
type Expectation =
  | { action: "ask" | "answer" }
  | { keys: string[]; followUp?: boolean }
  | { confirm: true };

const CASES: [name: string, dialog: Dialog, reply: string, want: Expectation, earlier?: ReplyExchange[]][] = [
  ["yes allows once", permission("curl -sI https://example.com"), "是的", { keys: ["1"] }],
  ["no denies", permission("curl -sI https://example.com"), "不行", { keys: ["3"] }],
  ["以后都可以 picks don't-ask-again", permission("curl -sI https://example.com"), "以后都可以", { confirm: true }],
  ["English always", permission("npm test"), "yes, and don't ask me again", { confirm: true }],
  ["嗯，再说吧 asks back", permission("rm -rf build"), "嗯，再说吧", { action: "ask" }],
  ["a question gets an answer", permission("rm -rf build dist"), "这个命令会删什么？", { action: "answer" }],
  ["an answer explains its terms", permission("git worktree remove ../m2-ui --force"), "这是要干嘛？", { action: "answer" }],
  ["an English answer", permission("npm publish --access public"), "what happens if I allow this?", { action: "answer" }],
  ["no with a reason sends it on", permission("curl -sI https://example.com"), "不行，用 wget 吧", { keys: ["3"], followUp: true }],
  ["asks, then decides", permission("rm -rf build"), "会删什么？算了，允许吧", { keys: ["1"] }],
  ["plan yes approves with manual edits", plan, "可以，开始吧", { keys: ["2"] }],
  ["plan change revises", plan, "文件名改成 hi.txt", { keys: ["3", "*", "\r"] }],
  ["plan plain no asks what to change", plan, "不行", { action: "ask" }],
  ["three answers in one reply", questions, "Vue，要登录和支付，部署用 Fly", { keys: ["2", "1", "3", "*", "*", "*", "*", "\r", "2", "1"] }],
  ["one of three asks for the rest", questions, "Vue 吧", { action: "ask" }],
  [
    "the rest after an earlier answer, one in its own words",
    questions,
    "登录和搜索，部署用 Render",
    { keys: ["2", "1", "2", "*", "*", "*", "*", "\r", "3", "Render", "\r", "1"] },
    [{ builder: "Vue 吧", secretary: "好，框架用 Vue。功能和部署呢？" }],
  ],
  ["the recommendation, when asked for", color, "Blue", { keys: ["2"] }],
  ["an answer not among the options", color, "绿色", { keys: ["3", "*", "\r"] }],
];

function matches(keys: string[], want: string[]): boolean {
  return keys.length === want.length && keys.every((k, i) => want[i] === "*" || want[i] === k);
}

describe.skipIf(!process.env.MULTICODE_LIVE)("reply interpreter on the real CLI", () => {
  for (const [name, dialog, reply, want, earlier] of CASES) {
    it(name, async () => {
      const started = Date.now();
      const result = await interpretReply({ dialog, brief: BRIEF, earlier: earlier ?? [], reply });
      console.log(`${name} ${((Date.now() - started) / 1000).toFixed(1)} s ${JSON.stringify(result)}`);
      expect(result.ok, result.ok ? "" : result.reason).toBe(true);
      if (!result.ok) return;
      if ("action" in want) {
        expect(result.action).toBe(want.action);
        return;
      }
      expect(result.action).toBe("choose");
      if (result.action !== "choose") return;
      const checked = checkChoice(dialog, result.choice);
      if ("confirm" in want) {
        expect(checked).toEqual({ ok: false, ask: dialog.kind === "plan" ? "confirm-auto" : "confirm-always" });
        return;
      }
      expect(checked.ok, JSON.stringify(checked)).toBe(true);
      if (!checked.ok) return;
      expect(matches(checked.plan.keys, want.keys), JSON.stringify(checked.plan.keys)).toBe(true);
      expect(Boolean(checked.plan.followUp)).toBe(Boolean(want.followUp));
    }, 90_000);
  }
});
