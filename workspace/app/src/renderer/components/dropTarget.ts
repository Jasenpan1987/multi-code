// What a drag of files over the window would do, from the selected contact and
// whether a Multi-Code dialog is open (file-drop PRD Story 1). No DOM here, so the
// rules are tested apart from the drag events that feed them (useFileDrop).
//
// Files go into the selected contact's project and nowhere else: to drop into
// another project, switch to it first. A stopped contact takes drops, since the copy
// needs only its directory.

import type { Instance } from "../../shared/types";

export type DropRefusal = "no-selection";

export type DropState =
  // No overlay, and a drop is ignored: a dialog is open, or no files are dragged.
  | { kind: "none" }
  // The overlay names this contact, and a drop hands it the files.
  | { kind: "target"; instance: Instance }
  // The overlay says why files can't go here, and a drop does nothing.
  | { kind: "refused"; reason: DropRefusal };

export const NO_DROP: DropState = { kind: "none" };

export function dropState(
  selected: Instance | null | undefined,
  dialogOpen: boolean
): DropState {
  if (dialogOpen) return NO_DROP;
  if (!selected) return { kind: "refused", reason: "no-selection" };
  return { kind: "target", instance: selected };
}
