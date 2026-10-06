// Turns a Claude instance's hook deliveries into the activity vocabulary everything
// downstream already speaks: `waiting` (finished), `prompt` (needs you), and
// `prompt-cleared`.
//
// Replaces guessing from the transcript and the terminal (see
// docs/knowledge/tech-conventions.md, "Agent state comes from the agent"). Every rule
// here follows something the CLI was measured to report, on 2.1.291:
// docs/timeline/2026-10-06_attention-alerts-investigation.md, "Hook spike". The
// fixtures those runs produced are what claudeHooks.test.ts replays.
//
// The registry read (`~/.claude/sessions/<pid>.json` status) is a confirmation of a
// `Stop` the CLI reported, never an event source of its own: a `Stop` lands
// 15–60ms before the registry leaves `busy`, and a user's own Stop hook can keep the
// turn going (or merely run slowly) with nothing else announcing it. PRD Story 6
// allows exactly this use.
//
// Pure: no electron, no node-pty, no fs. Timers are injected so the tests replay a
// fixture's timeline without sleeping.

import type { ActivityCallback, AlertDelivery } from "./types";
import { extractPromptDetail, type PromptDetail } from "../remote/promptExtract";

// How long after a main-agent `Stop` to read the registry. Measured: the status was
// final by +300ms in every scenario, and still `busy` at +0 in all of them.
const STOP_SETTLE_MS = 300;

// While the registry still says `busy` after a `Stop` with no background subagent,
// something is still running the turn: a user's Stop hook that blocked (a second
// `Stop` will follow) or one that is just slow (nothing will). Re-read until it
// settles.
const BUSY_RECHECK_MS = 250;

// Give up on a turn that never leaves `busy` after its `Stop`. Ten minutes covers a
// Stop hook that runs a test suite; past that a chime would be noise anyway.
const BUSY_GIVE_UP_MS = 10 * 60_000;

// While a background subagent runs, the CLI wakes the agent when it finishes (a
// `<task-notification>` UserPromptSubmit ~50ms after its SubagentStop) and that
// turn's own `Stop` decides. Should every held subagent report SubagentStop and no
// wake-up follow within this long, the hold ends on its own. Keyed on the CLI's
// events rather than on polling the registry during the run: the registry's status
// while only a subagent works is undocumented, and a poll that read `idle` there
// would chime mid-work, which is the bug this module exists to end.
const WAKE_GRACE_MS = 3000;

// Once the CLI is up (the registry lists its pid), how long without a single hook
// delivery before the instance's hooks are taken not to run: `disableAllHooks`, or
// a managed policy that allows only managed hooks. SessionStart arrived within
// ±200ms of the registry entry in every T-401 run, so this is generous.
const HOOKS_MISSING_MS = 10_000;
const HEALTH_POLL_MS = 1000;

export interface HookTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realTimers: HookTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

// A registry status that means the agent has nothing more to say for this turn.
// `shell` is a background Bash still running, which deliberately doesn't hold the
// finish back (PRD Story 2).
function isSettled(status: string | null): boolean {
  return status === "idle" || status === "shell";
}

// Background work in a `Stop` payload that holds the finish back: running
// subagents, by id (the same id their SubagentStop carries as `agent_id`). Shells
// don't count: a dev server never ends, and when a build does, the CLI wakes the
// agent into a turn of its own (G-003). `null` when a subagent is running but
// carries no id, so it can't be followed.
function runningSubagents(payload: Record<string, unknown>): Set<string> | null {
  const ids = new Set<string>();
  const tasks = payload.background_tasks;
  if (!Array.isArray(tasks)) return ids;
  for (const t of tasks) {
    if (typeof t !== "object" || t === null) continue;
    const task = t as Record<string, unknown>;
    if (task.type !== "subagent" || task.status !== "running") continue;
    if (typeof task.id !== "string" || task.id === "") return null;
    ids.add(task.id);
  }
  return ids;
}

// A dialog forced by an `ask` rule offers only Yes / No, and its PermissionRequest
// carries no `permission_suggestions`; one for a tool with no rule offers a third
// "don't ask again" option and does carry them. The phone's buttons send option
// numbers, so the list it is shown has to have the right length.
function permissionDetail(delivery: AlertDelivery): PromptDetail | undefined {
  const tool = delivery.toolName ?? "";
  const detail = extractPromptDetail(tool, delivery.toolInput);
  if (!detail) return undefined;
  if (tool === "AskUserQuestion" || tool === "ExitPlanMode") return detail;
  const suggestions = delivery.payload.permission_suggestions;
  if (Array.isArray(suggestions) && suggestions.length > 0) return detail;
  return {
    ...detail,
    options: detail.options.filter((o) => !/don't ask again/i.test(o.label)),
  };
}

type Pending =
  | { kind: "none" }
  // A main-agent Stop with nothing running in the background: confirm, then finish.
  | { kind: "confirm"; startedAt: number }
  // A main-agent Stop while subagents run: wait for the wake-up turn.
  | { kind: "hold"; agents: Set<string> }
  // Every held subagent has stopped; waiting out WAKE_GRACE_MS for the wake-up.
  | { kind: "grace" };

export class ClaudeHookAttention {
  private pending: Pending = { kind: "none" };
  private timer: unknown = null;
  private promptOutstanding = false;
  private stopped = false;
  // Virtual time spent waiting on the current pending check, in scheduled ms.
  private elapsed = 0;
  // Subagents the last main Stop listed as running, minus those that have sent
  // SubagentStop since. Kept across turns: a wake-up turn for one subagent can end
  // while another still runs.
  private knownRunning = new Set<string>();

  // Hook health (PRD Story 6). Watched from construction until the first delivery.
  private heardFromHooks = false;
  private reportedMissing = false;
  private healthTimer: unknown = null;
  private healthElapsed = 0;
  private registrySeenAt: number | null = null;

  constructor(
    private readonly onActivity: ActivityCallback,
    private readonly readRegistryStatus: () => string | null,
    private readonly timers: HookTimers = realTimers,
    // false once the hooks are taken not to run, true again when one is heard.
    private readonly onHooksHealth: (ok: boolean) => void = () => {}
  ) {
    this.scheduleHealthCheck();
  }

  handle(delivery: AlertDelivery) {
    if (this.stopped) return;
    this.noteHeard();
    const fromSubagent = delivery.agentId !== undefined;

    switch (delivery.event) {
      case "UserPromptSubmit":
        // A new turn: typed by the user, or the CLI waking the agent with a
        // <task-notification>. Either way the previous turn's finish is moot.
        this.cancelPending();
        this.clearPrompt();
        return;

      case "Stop":
        // Measured: a subagent ends with SubagentStop, never Stop. Guarded anyway,
        // since a subagent's end must never chime on its own.
        if (fromSubagent) return;
        this.clearPrompt();
        this.cancelPending();
        {
          const agents = runningSubagents(delivery.payload);
          // Each main Stop's list is the CLI's current word on what still runs.
          this.knownRunning = new Set(agents ?? []);
          if (agents && agents.size > 0) {
            this.pending = { kind: "hold", agents: new Set(agents) };
          } else {
            // Nothing running, or a subagent we can't follow by id. Either way the
            // registry decides: it reads `busy` for as long as a subagent works.
            this.pending = { kind: "confirm", startedAt: this.elapsed };
            this.schedule(STOP_SETTLE_MS);
          }
        }
        return;

      case "SubagentStop": {
        // Never a finish on its own. Only the last held subagent stopping starts the
        // grace period, which the wake-up's UserPromptSubmit normally cancels.
        const pending = this.pending;
        if (delivery.agentId === undefined) return;
        this.knownRunning.delete(delivery.agentId);
        if (pending.kind !== "hold") return;
        pending.agents.delete(delivery.agentId);
        if (pending.agents.size === 0) {
          this.pending = { kind: "grace" };
          this.schedule(WAKE_GRACE_MS);
        }
        return;
      }

      case "StopFailure":
        // The turn died on an API error and no Stop follows. Chimes like a normal
        // finish (G-002), but not while subagents from an earlier Stop still run:
        // the CLI will wake the agent again when they finish, and that turn decides.
        // A StopFailure carries no background_tasks of its own.
        if (fromSubagent) return;
        this.cancelPending();
        this.clearPrompt();
        if (this.knownRunning.size > 0) {
          this.pending = { kind: "hold", agents: new Set(this.knownRunning) };
          return;
        }
        this.finish();
        return;

      case "PostCompact":
        // A manual /compact sends no Stop; this is its end. An automatic one runs
        // inside a turn whose own Stop will follow.
        if (delivery.payload.trigger !== "manual") return;
        this.cancelPending();
        this.finish();
        return;

      case "PermissionRequest":
        // Every dialog in every permission mode measured raised exactly one of
        // these, so each one is a dialog: no dedupe. From a subagent too, because
        // its dialog blocks the builder just the same. A pending finish is left
        // alone: its registry read sees `waiting` and stands down by itself, and a
        // hold must survive a subagent's dialog.
        this.raisePrompt(permissionDetail(delivery));
        return;

      case "Elicitation":
        // An MCP server asking for input. The form has no options a phone could
        // answer with a number, so no detail: the phone shows the terminal.
        this.raisePrompt(undefined);
        return;

      case "PostToolUse":
      case "PostToolUseFailure":
      case "ElicitationResult":
      case "PermissionDenied":
        // The dialog was answered and the tool went on. A denial sends none of
        // these; the next turn or the PTY write is what shows it.
        this.clearPrompt();
        return;

      default:
        // SessionStart, Notification, PreToolUse and the rest carry
        // nothing an alert depends on.
        return;
    }
  }

  stop() {
    this.stopped = true;
    this.cancelPending();
    this.cancelHealthCheck();
  }

  private noteHeard() {
    if (this.heardFromHooks) return;
    this.heardFromHooks = true;
    this.cancelHealthCheck();
    if (this.reportedMissing) {
      this.reportedMissing = false;
      this.onHooksHealth(true);
    }
  }

  // Counts only from the moment the CLI is listed in its registry, so a trust
  // dialog the builder hasn't answered yet (the CLI isn't listed before it) never
  // reads as missing hooks.
  private scheduleHealthCheck() {
    this.healthTimer = this.timers.setTimeout(() => {
      this.healthTimer = null;
      this.healthElapsed += HEALTH_POLL_MS;
      if (this.stopped || this.heardFromHooks) return;
      if (this.registrySeenAt === null && this.readRegistryStatus() !== null) {
        this.registrySeenAt = this.healthElapsed;
      }
      if (
        this.registrySeenAt !== null &&
        this.healthElapsed - this.registrySeenAt >= HOOKS_MISSING_MS
      ) {
        this.reportedMissing = true;
        this.onHooksHealth(false);
        return;
      }
      this.scheduleHealthCheck();
    }, HEALTH_POLL_MS);
  }

  private cancelHealthCheck() {
    if (this.healthTimer !== null) {
      this.timers.clearTimeout(this.healthTimer);
      this.healthTimer = null;
    }
  }

  private raisePrompt(detail: PromptDetail | undefined) {
    this.promptOutstanding = true;
    this.onActivity("prompt", detail);
  }

  private clearPrompt() {
    if (!this.promptOutstanding) return;
    this.promptOutstanding = false;
    this.onActivity("prompt-cleared");
  }

  private finish() {
    this.pending = { kind: "none" };
    this.onActivity("waiting");
  }

  private schedule(ms: number) {
    this.timer = this.timers.setTimeout(() => {
      this.timer = null;
      this.elapsed += ms;
      this.check();
    }, ms);
  }

  private cancelPending() {
    if (this.timer !== null) {
      this.timers.clearTimeout(this.timer);
      this.timer = null;
    }
    this.pending = { kind: "none" };
  }

  private check() {
    if (this.stopped) return;
    const pending = this.pending;

    if (pending.kind === "confirm") {
      const status = this.readRegistryStatus();
      // Unreadable registry: trust the Stop, which said nothing is running.
      if (status === null || isSettled(status)) {
        this.finish();
        return;
      }
      // `waiting` after a Stop is not the agent blocking: its turn is over, and a
      // dialog of its own would have come with a PermissionRequest. It is a panel
      // the builder opened (`/cost`, `/status` read `waiting`, "dialog open"), or a
      // subagent's dialog in the no-id fallback. Re-read like `busy` until it
      // settles; standing down here lost the finish when a panel overlapped the
      // settle window.
      if (this.elapsed - pending.startedAt >= BUSY_GIVE_UP_MS) {
        this.pending = { kind: "none" };
        return;
      }
      this.schedule(BUSY_RECHECK_MS);
      return;
    }

    if (pending.kind === "grace") {
      // No wake-up came. From here it is an ordinary confirm: finish if settled,
      // stand down on a dialog, keep re-reading while busy.
      this.pending = { kind: "confirm", startedAt: this.elapsed };
      this.check();
    }
  }
}
