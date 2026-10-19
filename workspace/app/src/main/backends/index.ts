import type { Backend, BackendAvailability, BackendName } from "./types";
import { claudeBackend } from "./claude";
import { opencodeBackend, isOpencodeAvailable, opencodeAvailability } from "./opencode";

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

export function isBackendAvailable(name: BackendName): boolean {
  if (name === "opencode") return isOpencodeAvailable();
  // claude availability check left as TODO; existing flows assume claude works
  return true;
}

// Like isBackendAvailable, with the reason when it isn't: missing, or a version
// Multi-Code doesn't support.
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
