// The manager's dispatch tool.
//
// Kept apart from read-tools because the safety story is completely different.
// Reading costs the target nothing and can't hurt it. Writing goes to a real
// terminal, and on 2026-09-02 a write to a session parked on a plan-approval dialog
// selected that dialog's highlighted default and the session edited a real file — so
// every write here goes through the gate in run-state.ts first, and a refusal comes
// back with something the manager can tell the user.

import { resolveSession } from "./read-tools";
import type { InstanceInfo } from "../process-manager";
import type { WriteVerdict } from "../run-state";
import type { ToolDefinition } from "./server";

export interface ManagerWriteHost {
  listInstances(): InstanceInfo[];
  sendTask(instanceId: string, text: string): WriteVerdict;
}

export function buildWriteTools(host: ManagerWriteHost): ToolDefinition[] {
  return [
    {
      name: "send_task",
      description:
        "Give a session something to do. The text arrives as if the user had typed it, so write an instruction, not a note about one. " +
        "This costs the target a full turn, so do NOT use it to ask how something is going — read_session answers that for free and without interrupting. " +
        "Works on both claude and opencode sessions. If the target is mid-task the CLI queues the message and it runs when the current turn ends; you do not need to wait or retry.",
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
      handler: (args) => {
        const instances = host.listInstances();
        const target = resolveSession(instances, args.name);
        if ("error" in target) throw new Error(target.error);

        if (target.instance.isManager) {
          throw new Error(
            "That is you. Do the work yourself, or send it to one of the project sessions."
          );
        }

        const text = typeof args.text === "string" ? args.text.trim() : "";
        if (!text) {
          throw new Error("`text` is required — there is nothing to send.");
        }

        const verdict = host.sendTask(target.instance.id, text);
        if (!verdict.ok) {
          // Reads as a sentence: "<name> is waiting on a decision from you…"
          throw new Error(`${target.instance.name} is ${verdict.reason}`);
        }

        return (
          `Sent to ${target.instance.name}.\n\n` +
          `It has not answered yet — this only delivered the message. Use read_session to see what it did, ` +
          `once it has had time to work. Nothing tells you automatically.`
        );
      },
    },
  ];
}
