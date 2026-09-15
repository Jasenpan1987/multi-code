// The text of the one-time warning shown when a manager is first created.
//
// Its own module, and tested, because the text *is* the feature. A freshly created
// manager stops on the CLI's workspace-trust dialog, and **its default is the wrong
// answer** — reproduced 2026-09-15:
//
//   Quick safety check: Is this a project you created or one you trust?
//   ❯ No, exit
//     Yes, I trust this folder
//
// The highlight sits on "No, exit", so a user who presses Enter — the obvious thing
// to do at a prompt — kills the manager they just created and watches it go stopped
// with no explanation. Everything after the dialog works fine.
//
// Two alternatives were rejected and shouldn't be re-litigated without new
// information. Writing `hasTrustDialogAccepted` into `~/.claude.json`: that is where
// the CLI keeps it, but the file is the CLI's live state and is rewritten constantly,
// so we would contend with it and corrupting it breaks `claude` everywhere.
// Auto-answering the dialog over the PTY: exactly the class of action the write gate
// exists to prevent.

export const TRUST_DIALOG_QUESTION =
  "Quick safety check: Is this a project you created or one you trust?";

export const TRUST_DIALOG_OPTIONS = ["No, exit", "Yes, I trust this folder"];

// The option to pick, quoted so the UI and the test agree on the exact string the
// user will be looking for on screen.
export const TRUST_ANSWER = "Yes, I trust this folder";

export const TRUST_HINT_TITLE = "Your manager is starting up";

export const TRUST_HINT_PARAGRAPHS = [
  "Claude Code is about to ask this in the terminal, because it has never been run in the manager's folder before:",
  `Choose "${TRUST_ANSWER}" — press the down arrow, then Enter.`,
  "Do not just press Enter. The highlighted answer is “No, exit”, and it will shut down the manager you just created.",
  "The folder belongs to Multi-Code, so it is safe to trust. If the question doesn't appear at all, nothing is wrong — it means the folder is already trusted.",
];
