// The manager's two read tools.
//
// These are the whole point of reading rather than asking: the manager answers
// "how far did MSK get on that thing?" from the target's own transcript, so the
// target spends no tokens, loses no turn, and never knows it was looked at. A
// message asking the same question would cost it a full turn.
//
// Everything here is pure formatting plus a host interface, so the addressing and
// output shape are testable without standing up a server. `import type` for
// InstanceInfo, so this module carries no runtime dependency on process-manager.

import type { InstanceInfo } from "../process-manager";
import type { TranscriptEntry } from "../../shared/remote-protocol";
import type { ToolDefinition } from "./server";

// What these tools need from the rest of the app. Injected from index.ts, which
// is the layer allowed to know about process-manager — the dependency must only
// ever point that way, since a manager spawn will need to reach the server.
export interface ManagerHost {
  listInstances(): InstanceInfo[];
  readTranscript(instanceId: string, limit: number): TranscriptEntry[];
  // Whether anything can be read at all, live or from disk. Separate from
  // readTranscript so an empty result can be explained rather than just returned.
  hasReadableTranscript(instanceId: string): boolean;
}

const DEFAULT_TRANSCRIPT_LIMIT = 50;
// A 50-entry tail measured 3–5k tokens across three real sessions and 100 measured
// 4–9.5k. The manager reads several sessions per question, so the ceiling matters
// more than the convenience of asking for everything.
const MAX_TRANSCRIPT_LIMIT = 200;

export function buildReadTools(host: ManagerHost): ToolDefinition[] {
  return [
    {
      name: "list_sessions",
      description:
        "List every coding session Multi-Code manages, with its project directory, backend, run state, context usage and when it was last active. Use this first to find out who exists and what to call them — every other tool addresses a session by the `name` shown here.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      handler: () => formatSessionList(host.listInstances()),
    },
    {
      name: "read_session",
      description:
        "Read the tail of a session's conversation to find out what it has been doing. This is the way to check on progress: it costs the target session nothing and does not interrupt it, unlike sending it a message, which would consume one of its turns. Prefer this over asking a session for a status update. " +
        "Works on stopped sessions too — their history is on disk — and says so in the output when what you are reading is history rather than live work.",
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Session name, exactly as list_sessions reports it.",
          },
          limit: {
            type: "number",
            description: `How many transcript entries to return, newest last. Default ${DEFAULT_TRANSCRIPT_LIMIT}, maximum ${MAX_TRANSCRIPT_LIMIT}.`,
          },
        },
        required: ["name"],
        additionalProperties: false,
      },
      handler: (args) => {
        const instances = host.listInstances();
        const target = resolveSession(instances, args.name);
        if ("error" in target) throw new Error(target.error);
        const instance = target.instance;

        // A stopped session used to be refused here. It was the wrong call: the
        // transcript is a file on disk and reading it is harmless, while the refusal
        // cost a real capability. It fired on the very first question ever asked of
        // the manager — "has portals-backend pulled the latest dev branch?" — and the
        // manager had to shell out to git instead. The state goes in the output
        // instead, so stale work isn't presented as current.
        if (!host.hasReadableTranscript(instance.id)) {
          throw new Error(
            `${instance.name} has no transcript on disk. Either nothing has ever run in ` +
              `${instance.cwd}, or it has only just started and hasn't written its first ` +
              `message yet.`
          );
        }

        const limit = clampLimit(args.limit);
        const entries = host.readTranscript(instance.id, limit);
        return formatTranscript(instance.name, entries, limit, {
          stopped: instance.status === "stopped",
          lastActivityAt: instance.lastActivityAt ?? instance.contextUsage?.updatedAt,
        });
      },
    },
  ];
}

export function clampLimit(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return DEFAULT_TRANSCRIPT_LIMIT;
  }
  return Math.max(1, Math.min(MAX_TRANSCRIPT_LIMIT, Math.floor(raw)));
}

export type ResolveResult =
  | { instance: InstanceInfo }
  | { error: string };

// Sessions are addressed by the name the user sees, not by internal id — the
// manager talks about them the way its user does. An unusable name comes back
// with the valid ones rather than a bare failure, because the manager's idea of
// who exists can be a few minutes stale.
export function resolveSession(
  instances: InstanceInfo[],
  rawName: unknown
): ResolveResult {
  const known = instances.map((i) => i.name).join(", ") || "(none)";

  if (typeof rawName !== "string" || rawName.trim() === "") {
    return { error: `A session name is required. Known sessions: ${known}` };
  }
  const wanted = rawName.trim().toLowerCase();

  const matches = instances.filter((i) => i.name.toLowerCase() === wanted);
  if (matches.length === 1) return { instance: matches[0] };
  if (matches.length > 1) {
    // Two contacts can share a name when neither has an alias and their
    // directories end in the same segment. Say so with the cwds, so the user can
    // be asked to rename one instead of the manager guessing.
    const dirs = matches.map((m) => m.cwd).join(", ");
    return {
      error: `"${rawName}" matches ${matches.length} sessions (${dirs}). Ask the user to give one of them a distinct alias.`,
    };
  }
  return { error: `No session named "${rawName}". Known sessions: ${known}` };
}

export function formatSessionList(instances: InstanceInfo[], now = Date.now()): string {
  if (instances.length === 0) {
    return "No sessions. The user has not created any instances in Multi-Code yet.";
  }

  const lines = instances.map((i) => {
    const fields = [
      `name=${i.name}`,
      `backend=${i.backend}`,
      // runState is the live one and only exists while running; `status` covers the
      // stopped case. Reported as one field because the distinction between "stopped"
      // and "running but idle" is not one the manager needs to reason about
      // separately.
      `status=${i.runState ?? i.status}`,
      `context=${i.contextUsage ? `${i.contextUsage.inputTokens} tokens` : "unknown"}`,
    ];
    if (i.contextUsage?.model) fields.push(`model=${i.contextUsage.model}`);
    // `lastActivityAt` only exists for turns this app run observed, so a session
    // resumed with --continue reports "never" despite a long history — measured
    // 2026-09-15, where every session including a busy one read as never and the
    // manager correctly complained the field told it nothing. The transcript's
    // newest assistant turn is the same information and survives a restart, so it
    // stands in when the live signal hasn't fired yet.
    const activityAt = i.lastActivityAt ?? i.contextUsage?.updatedAt;
    fields.push(`last-activity=${formatAge(activityAt, now)}`);
    fields.push(`cwd=${i.cwd}`);
    return fields.join(" | ");
  });

  return [
    `${instances.length} session${instances.length === 1 ? "" : "s"}:`,
    "",
    ...lines,
    "",
    // Spelled out because these drive different actions, and `blocked` in particular
    // is one the manager must hand back to the user rather than try to resolve.
    "status: idle = finished its turn, waiting for input · busy = working · " +
      "blocked = stopped on a decision only the user can make (a permission prompt, " +
      "a question, a plan approval) — tell them, you cannot answer it for them · " +
      "starting = just spawned · stopped = not running.",
  ].join("\n");
}

export interface TranscriptState {
  stopped: boolean;
  lastActivityAt?: number;
}

export function formatTranscript(
  name: string,
  entries: TranscriptEntry[],
  limit: number,
  state?: TranscriptState,
  now = Date.now()
): string {
  if (entries.length === 0) {
    return `${name} has no readable transcript yet.`;
  }

  const body = entries.map((e) => {
    if (e.kind === "tool") {
      const running = e.pending ? " [still running]" : "";
      return `tool ${e.tool ?? "?"}${running}: ${e.text}`;
    }
    return `${e.kind}: ${e.text}`;
  });

  const header =
    entries.length < limit
      ? `${name} — entire transcript (${entries.length} entries), oldest first:`
      : `${name} — last ${entries.length} transcript entries, oldest first:`;

  const lines = [header, "", ...body];

  // Spelled out for a stopped session, because everything above it reads exactly
  // like a session that is still working on this. Without the warning the manager
  // reports days-old work as the current state.
  if (state?.stopped) {
    lines.push(
      "",
      `NOTE: ${name} is STOPPED — this is history, not work in progress. ` +
        `Its last activity was ${formatAge(state.lastActivityAt, now)}. ` +
        `Nothing here is still running, and nobody is going to answer a question in it. ` +
        `Use start_session if it needs to do something.`
    );
  }

  return lines.join("\n");
}

// Ages rather than timestamps: the manager is deciding whether something is
// stale, and "4m ago" answers that without it having to know the current time.
export function formatAge(at: number | undefined, now: number): string {
  if (!at || at <= 0) return "never";
  const seconds = Math.round((now - at) / 1000);
  if (seconds < 0) return "just now";
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
