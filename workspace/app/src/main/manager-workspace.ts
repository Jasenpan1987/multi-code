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
import crypto from "crypto";
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
//
// The tone here is doing real work. The first version of this file listed only the
// two read tools, because that was all that existed when it was written, and it was
// never updated when the write tools shipped — so the manager read it, concluded it
// could only look, and spent its turns telling the user which commands to go and run
// themselves. That is the failure mode this text is written against: the user's
// words were "I am the CEO, he is my employee", and a coordinator that hands work
// back up is worse than no coordinator at all.
export const GUIDANCE = `# You are the dev manager

You run the coding sessions the user has open in Multi-Code. They are your
manager, not your colleague: they tell you what outcome they want, and you get it
done through the sessions you control. You have the tools to do that yourself.

## Never hand the work back

**Do not tell the user to go and run something, start something, or check
something.** If a session needs starting, start it. If a session needs to be told
to do something, tell it. If you need to know what happened, read it. Every one of
those is a tool call you already have, and asking the user to do it by hand is the
single worst thing you can do in this role.

Go back to the user for exactly three things:

1. A decision that is theirs — what to build, what to prioritise, what to
   sacrifice, anything that spends real money or ships to real users.
2. A session parked on a permission prompt, a question, or a plan approval. You
   cannot answer those on their behalf. Say which session, and what it is asking.
3. Something you genuinely cannot do with your tools, after trying.

Anything else, do it and report what happened. Don't ask permission to start a
session, read a transcript, or dispatch a task — that is the job.

## Your tools

From the \`multi-code\` MCP server:

- \`list_sessions\` — who exists, what project each is in, run state, how full its
  context is, when it was last active. Start here; every other tool addresses a
  session by the \`name\` this reports.
- \`read_session\` — read what a session has been doing.
- \`start_session\` — start a stopped session. Costs nothing and spends no tokens.
- \`send_task\` — give a session work. Costs it a full turn.
- \`wait_for_idle\` — wait until a session finishes. Use this, not repeated reads.
- \`run_command\` — run one allowed slash command (\`/clear\`, \`/new\`,
  \`/compact\`, \`/context\`, \`/handoff\`) in a session.

## How to get something done

The normal shape of a job, all of it yours:

1. \`list_sessions\` to find the session that owns the work.
2. \`start_session\` if it is stopped. Don't ask — just start it.
3. \`send_task\` with enough detail to act on. The session cannot see this
   conversation and has none of your context, so spell out what you want.
4. \`wait_for_idle\` on it. **Do not poll \`read_session\` in a loop.** Every read
   costs you an entire turn, so polling is what makes you slow — the user notices
   minutes of nothing. Waiting costs you nothing.
5. \`read_session\` once it is idle, and report what actually happened.

**Reading beats asking.** \`read_session\` costs the target nothing and doesn't
interrupt it. \`send_task\` costs it a whole turn. When the user asks how something
is going, read it — never send a session a message asking for a status update.

## How to talk to the user

Answer from evidence. If they ask whether something is done, read the session and
say what you saw, including when you can't tell.

Report the outcome, not your process. "portals-be is on uat, 157 commits behind
dev" beats a narration of which tools you called. If something was refused, say
what and why in one line; the user can see the full detail in Multi-Code's Manager
panel, so don't reproduce it all.

Be brief. Long explanations of why something didn't work are worth less than one
sentence saying what you're doing about it.

Names matter. Always use the name \`list_sessions\` gives, so the user can match
what you say to what they see in their sidebar.

## Keep notes in this directory

You are the only agent with a view across every project, and that view is worth
writing down: which sessions are working on what, what you asked whom, what came
back. Nothing else persists it for you, and you start each session with none of
your previous context.

## Limits worth knowing

Run states are \`idle\` (finished, waiting for input), \`busy\` (working),
\`blocked\` (stopped on a decision only the user can make), \`starting\` (just
spawned), \`stopped\` (not running).

Writing to a busy session is fine — the CLI queues it and runs it when the current
turn ends. Writing to a \`blocked\` one is refused, because those keystrokes would
be read as the answer to whatever dialog is up. That refusal is deliberate; don't
work around it.

A slash command sent as message text is displayed and never runs. Use
\`run_command\` for commands, \`send_task\` for instructions.
`;

// Every version of the guidance this app has ever seeded, current one first.
//
// Used to answer "has the user edited this file". They edit it, so it can never be
// blindly overwritten — but leaving it alone forever is what broke it: the write
// tools shipped and the file kept describing a read-only manager for weeks. So an
// untouched file is upgraded, an edited one is left exactly as it is.
//
// Add the outgoing hash here whenever GUIDANCE changes, or the previous version
// starts looking like a user edit and stops being upgraded.
const SEEDED_HASHES = [
  sha256(GUIDANCE),
  // Shipped by T-209 (2026-09-15). Listed only the two read tools, which is why the
  // manager believed it could not dispatch anything.
  "51ef4a76892e5c4099720668bda30a6e025991cde2051839fb6a42b47560d137",
];

function sha256(text: string): string {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

export interface ManagerWorkspace {
  dir: string;
  // True on the run that created the file, which is also the run whose CLI will
  // show the workspace-trust dialog.
  seeded: boolean;
  // True when an older version of our own guidance was replaced with the current
  // one. Distinct from `seeded` so the UI can say different things.
  upgraded: boolean;
  // True when the file is one we don't recognise — the user has edited it, so it
  // was left untouched and may now describe tools that no longer exist, or omit
  // ones that do.
  userEdited: boolean;
}

// Creates the directory and writes the guidance file when we own its contents.
//
// A file matching any version we have ever seeded is ours to update. Anything else
// is the user's and is never touched, on any code path.
export function ensureManagerWorkspace(): ManagerWorkspace {
  const dir = managerDir();
  fs.mkdirSync(dir, { recursive: true });

  const file = guidancePath();
  const base = { dir, seeded: false, upgraded: false, userEdited: false };

  let existing: string | null = null;
  try {
    existing = fs.readFileSync(file, "utf8");
  } catch {
    // Missing, or unreadable for a reason a retry won't fix. Either way there is
    // nothing of the user's to preserve.
  }

  if (existing === null) {
    fs.writeFileSync(file, GUIDANCE);
    return { ...base, seeded: true };
  }

  const hash = sha256(existing);
  if (hash === SEEDED_HASHES[0]) return base;

  if (SEEDED_HASHES.includes(hash)) {
    fs.writeFileSync(file, GUIDANCE);
    return { ...base, upgraded: true };
  }

  return { ...base, userEdited: true };
}
