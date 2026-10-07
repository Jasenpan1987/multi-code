// Stub with T-504's contract so the orchestrator (T-505) builds; T-504 replaces this file.
import type { BriefLanguage } from "../../shared/types";
import type { SecretaryEvent } from "../process-manager";

export type Brief =
  | { ok: true; language: BriefLanguage; text: string }
  | { ok: false; reason: string };

// Gathers the alias and transcript for the instance itself, spawns the CLI, never throws.
// Aborting the signal kills the CLI and resolves { ok: false, reason: "aborted" }.
export function writeBriefFor(
  _instanceId: string,
  _event: SecretaryEvent,
  _signal?: AbortSignal
): Promise<Brief> {
  return Promise.resolve({ ok: false, reason: "brief writer not built yet" });
}
