// Over the whole window while files are dragged onto it (file-drop PRD Story 1):
// the project a drop puts them in, or why it can't. Display only; useFileDrop owns
// the drag and the drop.

import type { DropRefusal, DropState } from "./dropTarget";

const REFUSALS: Record<DropRefusal, { title: string; why: string }> = {
  manager: {
    title: "Files can't be dropped on the Manager",
    why: "Its folder belongs to Multi-Code, not to a project. Select a project's session in the list first.",
  },
  "no-selection": {
    title: "Files can't be dropped here",
    why: "No session is selected, and files go into the selected session's project. Select one in the list first.",
  },
};

interface DropOverlayProps {
  state: DropState;
}

export function DropOverlay({ state }: DropOverlayProps) {
  if (state.kind === "none") return null;

  return (
    <div className="drop-overlay">
      {state.kind === "target" ? (
        <div className="drop-card" data-kind="target">
          <div className="drop-card-label">Drop files into</div>
          <div className="drop-card-name">{state.instance.name}</div>
          <div className="drop-card-path">{state.instance.cwd}</div>
        </div>
      ) : (
        <div className="drop-card" data-kind="refused">
          <div className="drop-card-title">{REFUSALS[state.reason].title}</div>
          <div className="drop-card-why">{REFUSALS[state.reason].why}</div>
        </div>
      )}
    </div>
  );
}
