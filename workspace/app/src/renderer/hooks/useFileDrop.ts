import { useEffect, useRef, useState } from "react";
import { dropState, NO_DROP } from "../components/dropTarget";
import type { DropState } from "../components/dropTarget";
import type { Instance } from "../../shared/types";

// Files dragged anywhere over the window (file-drop PRD Story 1). Returns what the
// overlay shows, and hands a drop on the selected project's contact to `onDrop`.
//
// Only a drag that carries files is touched. A text or link drag, and the contact
// list's reordering (text/plain only), get no overlay and no preventDefault, so they
// behave as before. While dragging, the page sees only that files are coming
// (`types` has "Files", `files` is empty); the File objects arrive with the drop.
export function useFileDrop(
  selected: Instance | null,
  onDrop: (files: File[], target: Instance) => void
): DropState {
  const [dragging, setDragging] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  // For the listeners, subscribed once.
  const latest = useRef({ selected, onDrop });
  latest.current = { selected, onDrop };

  useEffect(() => {
    // The element the drag last entered. Moving between elements fires dragenter
    // on the new one before dragleave on the old (probe 2026-10-28), so the drag
    // has left the window, or was cancelled with Esc, only when the element it
    // leaves is this one. A count of enters and leaves would get stuck instead: the
    // terminal redraws its rows under the pointer, and a removed element's
    // dragleave never reaches here.
    let entered: EventTarget | null = null;

    // The drag's data when it carries files, else null: only those are ours.
    const filesDrag = (e: DragEvent) =>
      e.dataTransfer?.types.includes("Files") ? e.dataTransfer : null;
    // Any Multi-Code dialog, and the diff window, which isn't modal but counts.
    const isDialogOpen = () =>
      document.querySelector(".dialog-overlay, .diff-window") !== null;

    const hide = () => {
      entered = null;
      setDragging(false);
    };

    const onEnter = (e: DragEvent) => {
      if (!filesDrag(e)) return;
      entered = e.target;
      setDragging(true);
      setDialogOpen(isDialogOpen());
    };
    const onOver = (e: DragEvent) => {
      const data = filesDrag(e);
      if (!data) return;
      // Without it no drop event arrives. Where the files can't go, the effect is
      // "none", so the pointer shows no copy badge and letting go drops nothing.
      e.preventDefault();
      const open = isDialogOpen();
      setDialogOpen(open);
      const state = dropState(latest.current.selected, open);
      data.dropEffect = state.kind === "target" ? "copy" : "none";
    };
    const onLeave = (e: DragEvent) => {
      if (filesDrag(e) && e.target === entered) hide();
    };
    // A press can't happen during a drag, so one means the drag is over. Only a
    // safety net: were a dragleave ever missed, the overlay would cover the window.
    const onPress = () => {
      if (entered !== null) hide();
    };
    const onDropped = (e: DragEvent) => {
      const data = filesDrag(e);
      if (!data) return;
      e.preventDefault();
      hide();
      // Decided again here, not from the overlay as last drawn.
      const state = dropState(latest.current.selected, isDialogOpen());
      if (state.kind !== "target") return;
      latest.current.onDrop([...data.files], state.instance);
    };

    // Capture phase, so a component that stops propagation can't hide a drag.
    window.addEventListener("dragenter", onEnter, true);
    window.addEventListener("dragover", onOver, true);
    window.addEventListener("dragleave", onLeave, true);
    window.addEventListener("drop", onDropped, true);
    window.addEventListener("pointerdown", onPress, true);
    return () => {
      window.removeEventListener("dragenter", onEnter, true);
      window.removeEventListener("dragover", onOver, true);
      window.removeEventListener("dragleave", onLeave, true);
      window.removeEventListener("drop", onDropped, true);
      window.removeEventListener("pointerdown", onPress, true);
    };
  }, []);

  return dragging ? dropState(selected, dialogOpen) : NO_DROP;
}
