// The manager's tools that change something: dispatch work, run a slash command,
// start a stopped session.
//
// Kept apart from read-tools because the safety story is completely different.
// Reading costs the target nothing and can't hurt it. Writing goes to a real
// terminal, and on 2026-09-02 a write to a session parked on a plan-approval dialog
// selected that dialog's highlighted default and the session edited a real file — so
// every write here goes through the gate in run-state.ts first, and a refusal comes
// back with something the manager can tell the user.

import { resolveSession } from "./read-tools";
import { READY_TIMEOUT_MS, waitForReady } from "./wait-tools";
import type { InstanceInfo } from "../process-manager";
import type { RunState, WriteVerdict } from "../run-state";
import type { ToolDefinition } from "./server";

// Slash commands the manager may run. A plain constant, not a config surface:
// adding one should be a code change someone reviews.
//
// `/clear` and `/new` are in here at the user's explicit request (2026-09-15), which
// reverses T-207's original decision to exclude `/clear` for discarding context
// irreversibly. Their reasoning: these are their sessions, clearing one is a normal
// part of managing a fleet, and a manager that has to ask them to go and do it by
// hand is the exact abdication they are trying to get rid of. `/handoff` remains the
// better tool when there is work worth landing first, and the tool description says
// so.
const COMMAND_ALLOWLIST = [
  "/clear",
  "/new",
  "/compact",
  "/context",
  "/handoff",
];

export interface ManagerWriteHost {
  listInstances(): InstanceInfo[];
  sendTask(instanceId: string, text: string): WriteVerdict;
  runCommand(instanceId: string, command: string): WriteVerdict;
  startSession(instanceId: string): InstanceInfo | null;
  // The last three exist so `start_session` can wait for the CLI to be ready rather
  // than handing the model a session it will immediately write into and lose.
  runStateOf(instanceId: string): RunState | undefined;
  onActivity(listener: (instanceId: string, type: string) => void): () => void;
  msSincePtyByte(instanceId: string): number | undefined;
}

export function buildWriteTools(host: ManagerWriteHost): ToolDefinition[] {
  return [
    {
      name: "send_task",
      description:
        "Give a session something to do. The text arrives as if the user had typed it, so write an instruction, not a note about one. " +
        "This costs the target a full turn, so do NOT use it to ask how something is going — read_session answers that for free and without interrupting. " +
        "Works on both claude and opencode sessions. If the target is mid-task the CLI queues the message and it runs when the current turn ends; you do not need to wait or retry. " +
        "After sending, use wait_for_idle to be told when it finishes rather than reading it over and over.",
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Session name, exactly as list_sessions reports it.",
          },
          text: {
            type: "string",
            description:
              "The instruction to send. Include the detail the session needs — it does not share your context and cannot see this conversation.",
          },
        },
        required: ["name", "text"],
        additionalProperties: false,
      },
      handler: async (args) => {
        const target = requireTarget(host, args.name);

        const text = typeof args.text === "string" ? args.text.trim() : "";
        if (!text) {
          throw new Error("`text` is required — there is nothing to send.");
        }

        await settleIfStarting(host, target);
        const verdict = host.sendTask(target.id, text);
        if (!verdict.ok) {
          // Reads as a sentence: "<name> is waiting on a decision from you…"
          throw new Error(`${target.name} is ${verdict.reason}`);
        }

        return (
          `Sent to ${target.name}.\n\n` +
          `It has not answered yet — this only delivered the message. Call wait_for_idle on ` +
          `${target.name} to be told when the turn ends, then read_session to see what it did.`
        );
      },
    },

    {
      name: "run_command",
      description:
        "Run one slash command in a session — the only way to trigger a command, since a command sent as message text is displayed but never executed. " +
        `Allowed: ${COMMAND_ALLOWLIST.join(", ")}. Anything else is refused. ` +
        "Prefer /handoff over /clear when the session has work worth writing down first: /clear discards its context immediately and irreversibly, /handoff lands the work and then hands over. " +
        "The command is submitted for you; you do not need to send a newline or confirm anything.",
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Session name, exactly as list_sessions reports it.",
          },
          command: {
            type: "string",
            description: `The command including its leading slash, with no arguments. One of: ${COMMAND_ALLOWLIST.join(", ")}.`,
          },
        },
        required: ["name", "command"],
        additionalProperties: false,
      },
      handler: async (args) => {
        const target = requireTarget(host, args.name);

        const raw = typeof args.command === "string" ? args.command.trim() : "";
        // Exact match, so nothing can be smuggled in as an argument. The allowlist
        // is the second line of defence anyway, not the first: the payload behind
        // the measured escalation was ordinary prose, so an allowlist alone would
        // not have stopped it. The state gate is what does.
        if (!COMMAND_ALLOWLIST.includes(raw)) {
          throw new Error(
            `"${raw}" is not an allowed command. Allowed, exactly as written and with no arguments: ` +
              `${COMMAND_ALLOWLIST.join(", ")}.`
          );
        }

        await settleIfStarting(host, target);
        const verdict = host.runCommand(target.id, raw);
        if (!verdict.ok) {
          throw new Error(`${target.name} is ${verdict.reason}`);
        }

        return (
          `Ran ${raw} in ${target.name}.\n\n` +
          `Submitted, not confirmed — read_session or the session's own screen is what says ` +
          `whether it took effect. /clear and /new in particular leave nothing in the ` +
          `transcript to read afterwards, which is expected rather than a failure.`
        );
      },
    },

    {
      name: "start_session",
      description:
        "Start a stopped session so it can be read from and given work. Use this instead of asking the user to start it — starting a session is your job, not theirs. " +
        "Costs nothing and consumes no tokens on its own: it launches the CLI, which then sits waiting. Safe to call on a session that is already running. " +
        "This waits until the session is ready, so you can send_task straight afterwards.",
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Session name, exactly as list_sessions reports it.",
          },
        },
        required: ["name"],
        additionalProperties: false,
      },
      handler: async (args) => {
        const target = requireTarget(host, args.name);

        if (target.status === "running") {
          return `${target.name} is already running. Nothing to do.`;
        }

        const started = host.startSession(target.id);
        if (!started) {
          throw new Error(
            `Could not start ${target.name}. Tell the user; something is wrong with that instance in Multi-Code.`
          );
        }

        // Hold until the CLI has finished painting and can accept input.
        //
        // **Returning immediately was measurably worse than waiting.** Observed
        // 2026-09-15: the manager started a session and dispatched to it one second
        // later, the still-booting CLI dropped the input, and the write-safety gate
        // then correctly refused the retry ("silent for 1s") — leaving the manager
        // to work out what had happened over the next two minutes. The tool
        // description said to give it a few seconds; the model did not, and telling
        // a model to wait is never as reliable as waiting.
        const outcome = await waitForReady(host, started.id, READY_TIMEOUT_MS);

        const head = `Started ${started.name} (${started.backend}) in ${started.cwd}.`;
        if (outcome === "exit") {
          throw new Error(
            `${started.name} started and then exited immediately. Tell the user — ` +
              `its CLI is failing on launch, which is not something you can fix from here.`
          );
        }
        if (outcome === "blocked") {
          return (
            `${head}\n\n` +
            `It came up on a question it needs the user to answer — a fresh session in an ` +
            `untrusted directory does this. Tell them to answer it in Multi-Code; you cannot ` +
            `send it work until they do.`
          );
        }
        if (outcome === "timeout") {
          return (
            `${head}\n\n` +
            `It has not finished starting after ${READY_TIMEOUT_MS / 1000}s, which is unusual. ` +
            `The process is up, so you can try send_task, but check with read_session first ` +
            `rather than assuming your message arrived.`
          );
        }

        return (
          `${head} Ready — you can send_task now.\n\n` +
          `Note it has no fresh history to read: a session that just started has done ` +
          `nothing yet, so read_session shows its past work, not anything new.`
        );
      },
    },
  ];
}

// Hold off writing to a session that is still booting.
//
// **The model issues start_session and send_task in the same turn, in parallel.**
// Observed 2026-09-15: the dispatch arrived two seconds into the CLI's startup, the
// booting CLI swallowed it, and the write gate then refused the retry — the manager
// spent the next two minutes working out why. Waiting inside the write tool fixes
// that for every ordering the model might choose, which telling it to sequence the
// calls does not.
//
// Only `starting` waits. An idle or busy target is written to immediately, and a
// blocked one is the gate's business, not this function's.
async function settleIfStarting(host: ManagerWriteHost, target: InstanceInfo) {
  if (host.runStateOf(target.id) !== "starting") return;

  const outcome = await waitForReady(host, target.id, READY_TIMEOUT_MS);
  if (outcome === "exit") {
    throw new Error(
      `${target.name} exited while starting up, so there was nothing to send to. ` +
        `Tell the user its CLI is failing to launch.`
    );
  }
  // `blocked` and `timeout` both fall through to the gate, which produces a better
  // sentence about the current state than anything guessed here would.
}

// Every tool here addresses a session by name and refuses to touch the manager
// itself, so both checks live in one place. Self-dispatch is refused rather than
// ignored: a manager that can queue work to itself will, and then wait for it.
function requireTarget(
  host: ManagerWriteHost,
  rawName: unknown
): InstanceInfo {
  const target = resolveSession(host.listInstances(), rawName);
  if ("error" in target) throw new Error(target.error);
  if (target.instance.isManager) {
    throw new Error(
      "That is you. Do the work yourself, or send it to one of the project sessions."
    );
  }
  return target.instance;
}

export const COMMAND_ALLOWLIST_FOR_TESTS = COMMAND_ALLOWLIST;
