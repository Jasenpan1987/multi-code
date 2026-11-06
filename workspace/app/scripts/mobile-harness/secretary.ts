// The harness's secretary (epic secretary-bar): Secretary Mode, whether the Mac
// "found" the Claude Code CLI, and a brief for every session that needs the builder or
// finished, as the desktop's secretary (src/main/secretary/index.ts) publishes them,
// with the scripted text below instead of a language model's and a quiet tone instead
// of a speech server's voice. Pure, apart from its timers: bridge.ts serves it.
//
// While the world is live a new brief is written in steps (writing, the voice on its
// way, ready), as the desk's are; paused (screenshots), it is ready at once. A reply
// is read for a second, then a yes answers the dialog (as the desk's first option), a
// question is answered, and anything else is asked back.

import type { SecretaryBriefState, SecretaryExchange } from "../../src/shared/types";
import type { World } from "./world.ts";

type Brief = SecretaryBriefState;

// What each scripted session's brief says. Spoken style, as the brief writer's are.
const TEXTS: Record<string, { needs?: string; finished?: string }> = {
  "multi-code": {
    needs:
      "multi-code 那边需要你批准一个命令。它要跑端到端测试，就是用真浏览器把登录和下单的流程从头走一遍。这个命令只读代码，不改文件，大概要两分钟。要我允许吗？",
    finished:
      "multi-code finished the dark mode work. Every screen now follows the system setting, and all the tests pass. Nothing is needed from you.",
  },
  "data-pipeline": {
    needs:
      "data-pipeline 那边的迁移脚本写好了，试跑也通过了。现在它问你，旧表 orders_v1 要不要留着。第一个选项是保留 30 天，改名成 orders_v1_backup，到期再删。第二个是迁移完马上删掉。你选哪个？",
  },
  "infra-terraform": {
    finished:
      "infra-terraform finished the plan for the logs bucket. It shows two changes and deletes nothing: a lifecycle rule on the bucket, and one more policy for the CI role. It asks whether to apply them.",
  },
  "customer-portal": {
    finished:
      "customer-portal fixed the login form. The password field now shows its error under the box, and all forty tests pass. Nothing is needed from you.",
  },
};

const STEP_MS = 1500;
const READ_MS = 1200;
const YES = /^\s*(yes|yep|ok|okay|sure|是|是的|可以|好|行)/i;

export class HarnessSecretary {
  on: boolean;
  claudeFound = true;
  // Told every change, for the server to broadcast.
  onChange: () => void = () => {};
  private briefs = new Map<string, Brief>();
  // Finished briefs' seqs: never a dialog's (the world's start at the clock).
  private seq = 1;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly world: World;

  constructor(world: World, on: boolean) {
    this.world = world;
    this.on = on;
    this.sync();
  }

  view() {
    return { on: this.on, claudeFound: this.claudeFound, briefs: Object.fromEntries(this.briefs) };
  }

  stop() {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }

  // Secretary Mode, from the phone or the control channel. On only with claude found.
  setMode(on: boolean) {
    const next = on && this.claudeFound;
    if (next === this.on) return;
    this.on = next;
    if (!next) {
      this.stop();
      this.briefs.clear();
    }
    this.sync();
    this.onChange();
  }

  setClaude(found: boolean) {
    this.claudeFound = found;
    if (!found) this.setMode(false);
    this.onChange();
  }

  // The world changed: a session that needs the builder or finished gets a brief,
  // and a brief whose moment has passed is marked as the desk's would be.
  sync() {
    if (!this.on) return;
    const listed = new Set<string>();
    for (const row of this.world.list()) {
      listed.add(row.id);
      const brief = this.briefs.get(row.id);
      const dialog = this.world.dialogOf(row.id);
      const at = row.since ?? Date.now();
      if (row.state === "needs-you" && dialog) {
        if (brief?.seq !== dialog.seq) this.write(row.id, row.name, "needs-you", dialog.seq, at, row.backend);
      } else if (row.state === "finished") {
        if (!brief || brief.kind !== "finished" || brief.handled) this.write(row.id, row.name, "finished", this.seq++, at, row.backend);
      } else if (brief && !brief.handled) {
        // Answered (it needed the builder), or read (Idle after Finished), or a new turn.
        if (brief.kind === "finished" && row.state === "idle") brief.seen = true;
        else brief.handled = true;
      }
    }
    for (const id of this.briefs.keys()) if (!listed.has(id)) this.briefs.delete(id);
  }

  // A phone dealt with a Finished brief: its session is read.
  seen(id: string, seq: number) {
    const brief = this.briefs.get(id);
    if (!brief || brief.seq !== seq || brief.kind !== "finished") return;
    brief.seen = true;
    this.world.markSeen(id);
    this.onChange();
  }

  audio(id: string, seq: number): Buffer | null {
    const brief = this.briefs.get(id);
    return brief?.seq === seq && brief.status === "ready" && brief.audio === "ready" ? TONE : null;
  }

  // A reply in words, from the phone (after the bridge's checks) or the desk. Read on
  // whatever brief the session has under that seq when the reading is done: while the
  // world is live, its voice may have come meanwhile, which puts a new object in the
  // map for the same brief.
  reply(id: string, seq: number, text: string) {
    const brief = this.briefs.get(id);
    if (!brief || brief.seq !== seq) return;
    const index = brief.exchanges?.length ?? 0;
    brief.exchanges = [...(brief.exchanges ?? []), { reply: text.trim() }];
    this.onChange();
    this.later(READ_MS, () => {
      const current = this.briefs.get(id);
      if (current?.seq !== seq || !current.exchanges?.[index]) return;
      const zh = /[㐀-鿿]/.test(text);
      let settled: Pick<SecretaryExchange, "outcome" | "response">;
      let press = false;
      if (YES.test(text) && !current.handled) {
        settled = { outcome: "pressed", response: zh ? "已经允许了。它正在跑端到端测试。" : "Done. I allowed it, and it is running now." };
        press = true;
      } else if (/[?？]\s*$/.test(text)) {
        // A question: answered, nothing pressed.
        settled = {
          outcome: "answered",
          response: zh
            ? "不会。它只读代码，用的是测试数据库，跑完就清掉。要我允许吗？"
            : "No. It only reads the code, and it uses the test database, which it clears afterwards. Shall I allow it?",
        };
      } else {
        settled = {
          outcome: "asked",
          response: zh
            ? "只允许这一次，还是以后这个命令都不再问你？"
            : "Allow it just this once, or never ask again for this command?",
        };
      }
      current.exchanges = current.exchanges.map((e, i) => (i === index ? { ...e, ...settled } : e));
      if (press) this.world.deskAnswer(id);
      this.onChange();
    });
  }

  private write(id: string, name: string, kind: Brief["kind"], seq: number, at: number, backend: string) {
    const text =
      (kind === "needs-you" ? TEXTS[id]?.needs : TEXTS[id]?.finished) ??
      (kind === "needs-you" ? `${name} needs you. It is waiting on a dialog.` : `${name} finished its turn. Nothing is needed from you.`);
    const replyable = kind === "needs-you" && (backend === "claude" || id === "data-pipeline");
    const marks = { at, ...(replyable ? { replyable: true as const } : {}) };
    const ready = { seq, kind, status: "ready" as const, text, language: /[㐀-鿿]/.test(text) ? ("Chinese" as const) : ("English" as const) };
    if (!this.world.live) {
      this.briefs.set(id, { ...ready, audio: "ready", ...marks });
      return;
    }
    const brief: Brief = { seq, kind, status: "preparing", ...marks };
    this.briefs.set(id, brief);
    // In place, so the marks set meanwhile (handled, seen, exchanges) stay.
    const step = (next: Partial<Brief>) => {
      const current = this.briefs.get(id);
      if (current?.seq !== seq) return;
      this.briefs.set(id, { ...current, ...next } as Brief);
      this.onChange();
    };
    this.later(STEP_MS, () => step({ ...ready, audio: "pending" }));
    this.later(2 * STEP_MS, () => step({ audio: "ready" }));
  }

  private later(ms: number, run: () => void) {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      run();
    }, ms);
    timer.unref?.();
    this.timers.add(timer);
  }
}

// Six seconds of a quiet, slowly gliding tone at 24 kHz, the speech server's rate: what
// "the voice" is in the harness.
const TONE = (() => {
  const rate = 24000;
  const frames = rate * 6;
  const data = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i++) {
    const t = i / rate;
    const envelope = Math.min(1, t * 4, (6 - t) * 4) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 0.7 * t));
    data.writeInt16LE(Math.round(Math.sin(2 * Math.PI * (220 + 60 * Math.sin(t)) * t) * envelope * 2500), i * 2);
  }
  const h = Buffer.alloc(44);
  h.write("RIFF", 0, "latin1");
  h.writeUInt32LE(36 + data.length, 4);
  h.write("WAVE", 8, "latin1");
  h.write("fmt ", 12, "latin1");
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36, "latin1");
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
})();
