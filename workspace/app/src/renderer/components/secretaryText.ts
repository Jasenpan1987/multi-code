// The Secretary section's one-line messages, kept out of the component so the
// wording lives in one place and is unit-testable.

import type { SpeechTestResult } from "../../shared/types";

// "warn" is the address step: nothing was asked of a server, the address itself is
// missing or unusable. An empty address is a valid setting (text only), so it
// shouldn't read like a server failure.
export type SpeechTestTone = "ok" | "warn" | "error";

export interface SpeechTestLine {
  tone: SpeechTestTone;
  text: string;
}

// Which check failed, ahead of main's reason, so "unreachable" and "key rejected"
// say whether the server or the speech call was at fault.
const STEP_LABEL = {
  health: "Health check",
  speech: "Speech",
} as const;

export function speechTestLine(result: SpeechTestResult): SpeechTestLine {
  if (result.ok) return { tone: "ok", text: `OK in ${formatSeconds(result.ms)}` };
  if (result.step === "address") {
    return { tone: "warn", text: capitalize(result.reason) };
  }
  return { tone: "error", text: `${STEP_LABEL[result.step]}: ${result.reason}` };
}

// Electron rejects a failed invoke with "Error invoking remote method '<channel>':
// Error: <message>". Only the message is meant for the user.
export function ipcErrorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return capitalize(
    message
      .replace(/^Error invoking remote method '[^']*': /, "")
      .replace(/^[A-Za-z]*Error: /, "")
  );
}

function formatSeconds(ms: number): string {
  return `${(Math.max(0, ms) / 1000).toFixed(1)} s`;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
