import type { Backend, BackendAvailability, BackendName } from "./types";
import { claudeBackend, findClaudeCli } from "./claude";
import { opencodeBackend, opencodeAvailability } from "./opencode";

const registry = new Map<BackendName, Backend>([
  ["claude", claudeBackend],
  ["opencode", opencodeBackend],
]);

export function getBackend(name: BackendName): Backend {
  const backend = registry.get(name);
  if (!backend) {
    throw new Error(`Unknown backend: ${name}`);
  }
  return backend;
}

// Whether a backend's CLI can start here, with the reason when it can't: missing, or
// a version Multi-Code doesn't support. Claude's version isn't checked; whether it is
// there is findClaudeCli's answer, the one the secretary acts on.
export function backendAvailability(name: BackendName): BackendAvailability {
  if (name === "opencode") return opencodeAvailability();
  return findClaudeCli() ? { ok: true } : { ok: false, reason: "missing" };
}

export type {
  AlertDelivery,
  AlertsDegradedReason,
  AnswerResult,
  AttentionContext,
  Backend,
  BackendAvailability,
  BackendName,
  DialogAnswer,
  DialogRef,
  SpawnConfig,
  SpawnOptions,
  HookAttention,
  PromptToolCall,
  RecentTurns,
  SessionDiscovery,
  SessionStart,
} from "./types";
