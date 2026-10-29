// What sits in place of the compose box and the working bar while the session is
// stopped on a dialog (PRD Stories 4 and 5): there is no compose box then, so typed
// text never lands in the dialog, and no Stop, since Esc would answer it.
//
// mobile-v2 T-808: replace this component with the answer card (mockup 3.1) and the
// question and plan sheets (3.2, 3.3); SessionScreen renders it with these props and
// nothing else. Until then it says what the dialog asks and offers the terminal.

import type { OpenDialog } from "../state";
import { navigate } from "../routes";
import "./dialog-slot.css";

export interface DialogSlotProps {
  // The instance the dialog belongs to.
  id: string;
  // The last `prompt-state` (seq, summary and, when the phone can draw it, the
  // dialog in full). Null while the list says Needs you but no prompt-state has
  // arrived yet (it comes right after subscribe): nothing can be answered then.
  dialog: OpenDialog | null;
  // One line: the dialog's summary, else the list row's preview.
  summary: string;
}

export function DialogSlot({ id, dialog, summary }: DialogSlotProps) {
  const full = dialog?.dialog;
  const kind =
    full?.kind === "permission"
      ? `${full.tool} permission`
      : full?.kind === "plan"
        ? "Plan"
        : full?.kind === "questions"
          ? full.questions.length === 1
            ? "Question"
            : `${full.questions.length} questions`
          : "";
  return (
    <div className="dialog-slot" data-kind={full?.kind ?? "none"}>
      <div className="kind">
        <span className="dot red" />
        NEEDS YOU
        {kind && <span className="m">{kind}</span>}
      </div>
      <p className="q">{summary}</p>
      <p className="desc">
        {dialog && !full ? "The phone can't show this dialog. Answer it in the terminal." : "Answer it in the terminal for now."}
      </p>
      <button className="btn primary block" onClick={() => navigate({ screen: "terminal", id })}>
        Open terminal
      </button>
    </div>
  );
}
