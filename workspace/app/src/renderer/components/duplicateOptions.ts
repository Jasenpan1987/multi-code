// What Duplicate offers (docs/specs/duplicate-options/prd.md): each choice's label,
// the line under it, and whether it can be picked, from what main says about the
// contact. No React, so it can be tested on its own.

import { OPENCODE_UPGRADE_COMMAND } from "../../shared/types";
import type { BackendAvailability, BackendName } from "../../shared/types";

export type DuplicateChoice = "fork" | "new" | "other";

export interface DuplicateOption {
  choice: DuplicateChoice;
  label: string;
  detail: string;
  disabled: boolean;
}

export function backendLabel(backend: BackendName): string {
  return backend === "opencode" ? "OpenCode" : "Claude Code";
}

export function otherBackend(backend: BackendName): BackendName {
  return backend === "claude" ? "opencode" : "claude";
}

// `canFork` and `other` are null while main hasn't answered yet.
export function duplicateOptions(
  backend: BackendName,
  canFork: boolean | null,
  other: BackendAvailability | null
): DuplicateOption[] {
  const tool = backendLabel(backend);
  const otherTool = backendLabel(otherBackend(backend));
  return [
    {
      choice: "fork",
      label: "Fork this session",
      detail:
        canFork === null
          ? "Checking for a conversation to copy…"
          : canFork
            ? "Copies this conversation into a new session. Both work on the same files."
            : "Nothing to fork yet: no message has been sent in this session.",
      disabled: canFork !== true,
    },
    {
      choice: "new",
      label: "New session",
      detail: `A fresh session in this project, with ${tool}.`,
      disabled: false,
    },
    {
      choice: "other",
      label: `New session with ${otherTool}`,
      detail: otherDetail(otherTool, other),
      disabled: other?.ok !== true,
    },
  ];
}

function otherDetail(otherTool: string, other: BackendAvailability | null): string {
  if (other === null) return `Checking for ${otherTool}…`;
  if (other.ok) {
    return `A fresh session in this project, with ${otherTool}. No conversation is carried over.`;
  }
  if (other.reason === "outdated") {
    return `${otherTool} ${other.version} is too old for Multi-Code. Upgrade with: ${OPENCODE_UPGRADE_COMMAND}`;
  }
  return `${otherTool} isn't installed.`;
}
