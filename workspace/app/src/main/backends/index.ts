import type { Backend, BackendName } from "./types";
import { claudeBackend } from "./claude";
import { opencodeBackend, isOpencodeAvailable } from "./opencode";

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

export type { Backend, BackendName, SpawnConfig, CompletionDetector, SessionDiscovery } from "./types";
