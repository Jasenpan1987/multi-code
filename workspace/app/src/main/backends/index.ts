import type { Backend, BackendAvailability, BackendName } from "./types";
import { claudeBackend } from "./claude";
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
// a version Multi-Code doesn't support. Claude's isn't checked: every flow assumes it.
export function backendAvailability(name: BackendName): BackendAvailability {
  if (name === "opencode") return opencodeAvailability();
  return { ok: true };
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
  SessionDiscovery,
  SessionStart,
} from "./types";
