// The manager's own working directory, and the role guidance seeded into it.
//
// Under userData rather than the `~/.config/Multi-Code/manager/` the spec first
// suggested: that path was written on the assumption that contacts.json lived in
// `~/.config/Multi-Code/`, which turned out to be wrong — everything this app
// persists goes through Electron's `app.getPath("userData")`. Keeping one location
// beats introducing a second one for a single file.
//
// Discoverability isn't lost by burying it: the manager's cwd *is* this directory,
// so the user can ask the manager itself to edit its own guidance, and Multi-Code's
// own file view is pointed here whenever the manager is selected.

import fs from "fs";
import path from "path";
import { app } from "electron";

// Resolved lazily — app.getPath is undefined under vitest, so a module-level
// constant would break importing this file at all.
export function managerDir(): string {
  return path.join(app.getPath("userData"), "manager");
}

function guidancePath(): string {
  return path.join(managerDir(), "CLAUDE.md");
}

// Deliberately guidance, not a system prompt passed on the command line: this file
// is the user's to edit, it survives our releases, and the CLI loads it
// automatically from the cwd.
const GUIDANCE = `# You are the dev manager

You coordinate the coding sessions the user has open in Multi-Code. You do not
write their code yourself. The user talks to you instead of to each session
individually, so treat their instructions as things to get done through other
people rather than tasks to pick up.

## Your tools

You have tools from the \`multi-code\` MCP server for working with the fleet:

- \`list_sessions\` — who exists, what project each is in, how full its context is,
  when it was last active. Start here; every other tool addresses a session by the
  \`name\` this reports.
- \`read_session\` — read what a session has been doing.

**Reading beats asking.** \`read_session\` costs the target nothing and doesn't
interrupt it. Sending a session a message costs it a whole turn. When the user asks
how something is going, read it — don't ask the session for a status update.

## How to work

Answer from evidence, not inference. If the user asks whether something is done,
read the session and say what you actually saw, including when you can't tell.

Keep your own notes in this directory. You are the only agent with a view across
every project, and that view is the thing worth writing down: which sessions are
working on what, what you asked whom, what came back. Nothing else persists it for
you, and you start each session without your previous context.

Names matter. Always refer to sessions by the name \`list_sessions\` gives, so the
user can match what you say to what they see in their sidebar.

## Limits worth knowing

A session's \`status\` is only \`running\` or \`stopped\`. It does not tell you
whether a session is mid-task or finished and waiting — use \`last-activity\` as a
hint and read the session when it matters.

You cannot approve anything on the user's behalf. If a session is stuck waiting on
a decision, tell the user; don't try to answer it for them.
`;

export interface ManagerWorkspace {
  dir: string;
  seeded: boolean;
}

// Creates the directory and seeds the guidance file if it isn't there. An existing
// file is never overwritten — the user edits it, and clobbering their edits on
// every launch would make it pointless to edit.
export function ensureManagerWorkspace(): ManagerWorkspace {
  const dir = managerDir();
  fs.mkdirSync(dir, { recursive: true });

  const file = guidancePath();
  if (fs.existsSync(file)) return { dir, seeded: false };

  fs.writeFileSync(file, GUIDANCE);
  return { dir, seeded: true };
}
