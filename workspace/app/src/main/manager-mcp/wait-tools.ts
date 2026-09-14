// `wait_for_idle` — block until a session finishes its turn.
//
// This exists because of how slow the alternative is. Without it the manager checks
// on a dispatched session by reading its transcript, deciding nothing has changed,
// and reading it again — and every one of those cycles costs a full model turn of
// its own. Measured in real use 2026-09-15: dispatching one slash command and
// confirming it ran took one to two minutes of wall clock, nearly all of it the
// manager thinking between polls, while the target had finished almost immediately.
//
// One listener on the detector's events replaces all of that with a single tool call
// that returns the moment the turn ends.

import { resolveSession } from "./read-tools";
import type { InstanceInfo } from "../process-manager";
import type { RunState } from "../run-state";
import type { ToolDefinition } from "./server";

const DEFAULT_TIMEOUT_MS = 300_000;
const MAX_TIMEOUT_MS = 900_000;
// Below this the wait is worth less than the tool call it costs, and a model that
// asks for 1s is confused about what the tool does.
const MIN_TIMEOUT_MS = 1_000;

export interface ManagerWaitHost {
  listInstances(): InstanceInfo[];
  runStateOf(instanceId: string): RunState | undefined;
  onActivity(listener: (instanceId: string, type: string) => void): () => void;
}

export function buildWaitTools(host: ManagerWaitHost): ToolDefinition[] {
  return [
    {
      name: "wait_for_idle",
      description:
        "Wait until a session finishes what it is doing, then return. Use this after send_task instead of reading the session over and over — repeated reads are the slowest thing you can do, because each one costs you a whole turn while this costs none. " +
        "Returns early, and says so, if the session stops on a decision only the user can make, or if it exits. " +
        "Do not call it on a session you have not given work to: an idle session returns immediately, which tells you nothing.",
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Session name, exactly as list_sessions reports it.",
          },
          timeoutMs: {
            type: "number",
            description: `How long to wait before giving up. Default ${DEFAULT_TIMEOUT_MS / 1000}s, maximum ${MAX_TIMEOUT_MS / 1000}s. Giving up is not a failure of the task — the session keeps working.`,
          },
        },
        required: ["name"],
        additionalProperties: false,
      },
      handler: async (args) => {
        const target = resolveSession(host.listInstances(), args.name);
        if ("error" in target) throw new Error(target.error);
        const instance = target.instance;

        if (instance.status === "stopped") {
          throw new Error(
            `${instance.name} is stopped, so it will never become idle. ` +
              `Use start_session first if it should be working.`
          );
        }

        // Already finished. Returning immediately is right, but say which it is:
        // a manager that reads "idle" as "your task is done" will report success
        // for a task it never dispatched.
        const state = host.runStateOf(instance.id);
        if (state === "idle") {
          return (
            `${instance.name} is already idle — it is not working on anything right now. ` +
              `If you were expecting it to be busy, your task did not reach it. Read the session to check.`
          );
        }
        if (state === "blocked") {
          return blockedMessage(instance.name);
        }

        const timeoutMs = clampTimeout(args.timeoutMs);
        const startedAt = Date.now();
        const outcome = await waitForTurnEnd(host, instance.id, timeoutMs);
        const waited = Math.round((Date.now() - startedAt) / 1000);

        if (outcome === "idle") {
          return (
            `${instance.name} finished after ${waited}s. Read the session to see what it did — ` +
              `this only tells you the turn ended, not whether it succeeded.`
          );
        }
        if (outcome === "blocked") return blockedMessage(instance.name, waited);
        if (outcome === "exit") {
          return (
            `${instance.name} exited after ${waited}s without finishing. Its work is not done. ` +
              `Read its transcript for how far it got, and tell the user it went down.`
          );
        }

        // Timeout. Not thrown as an error: nothing went wrong, the session is simply
        // still working, and a model handed an error tends to report failure.
        return (
          `${instance.name} is still working after ${waited}s — this gave up waiting, it did not fail. ` +
            `Either wait again, or read the session to see where it has got to.`
        );
      },
    },
  ];
}

type WaitOutcome = "idle" | "blocked" | "exit" | "timeout";

// Resolves on the first event that ends the turn. Every path clears both the
// listener and the timer: a leaked listener would fire against a resolved promise
// forever, and this runs once per dispatch for the life of the app.
function waitForTurnEnd(
  host: ManagerWaitHost,
  instanceId: string,
  timeoutMs: number
): Promise<WaitOutcome> {
  return new Promise((resolve) => {
    let done = false;
    let unsubscribe = () => {};

    const finish = (outcome: WaitOutcome) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsubscribe();
      resolve(outcome);
    };

    const timer = setTimeout(() => finish("timeout"), timeoutMs);

    unsubscribe = host.onActivity((id, type) => {
      if (id !== instanceId) return;
      // `waiting` is the detector's turn-ended event on both backends. OpenCode
      // derives it from the message row's `finish` field, which is structured and
      // trustworthy; claude infers it from transcript pairing plus PTY silence,
      // which is weaker but is the only signal it has.
      if (type === "waiting") finish("idle");
      // Early exit on `blocked` matters more than the happy path: without it the
      // manager sits out its whole timeout on a session that has been parked on a
      // dialog since the first second.
      else if (type === "prompt") finish("blocked");
      else if (type === "exit") finish("exit");
    });

    // Registered after the listener on purpose — nothing to race, but a zero
    // timeout must not resolve before the listener is even attached.
    if (done) unsubscribe();
  });
}

function blockedMessage(name: string, waitedSeconds?: number): string {
  const when =
    waitedSeconds === undefined
      ? "is stopped"
      : `stopped after ${waitedSeconds}s`;
  return (
    `${name} ${when} on a decision only the user can make — a permission prompt, a question, ` +
    `or a plan approval. You cannot answer it and neither can waiting longer. Tell the user ` +
    `what it is asking, which you can see with read_session.`
  );
}

export function clampTimeout(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return DEFAULT_TIMEOUT_MS;
  return Math.max(MIN_TIMEOUT_MS, Math.min(MAX_TIMEOUT_MS, Math.floor(raw)));
}

export const WAIT_TIMEOUTS_FOR_TESTS = {
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
};
