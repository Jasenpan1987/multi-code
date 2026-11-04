# PRD: New Project

**Version:** 1.0
**Last Updated:** 2026-11-04
**Status:** approved
**Owner:** Jasen

## Overview

The New Instance dialog can make the folder of a project that doesn't exist yet, and can
clone a Git repo from a pasted link into a folder the builder picks. Either way the
session then starts in that folder, as it does today for an existing one. Multi-Code only
makes the folder or the clone; everything after that is the session's job.

## Background & Context

"New" can only open a folder that already exists, so a new project or a clone starts in a
terminal. The builder's projects are mostly clones of the company's GitHub repos under
`~/code/work`; some are under `~/code/study`. The design was settled with a clickable mock
(`.omt/probes/new-project/mock.html`, v2), which the builder approved.

(source: docs/timeline/2026-11-04_new-project-ideation.md; decisions.md, 2026-11-04)

## Users & Stakeholders

| Role | Who | How they interact |
|------|-----|-------------------|
| Builder | Jasen (and future open-source users) | Starts a session on a new project or on a repo not yet on disk |

## User Stories

### Story 1: Make a new project folder from Browse

**As a** Multi-Code user
**I want to** make a new folder in the folder picker that Browse opens
**So that** I can start a session on a project that doesn't exist yet

**Acceptance Criteria:**
- [ ] The picker that Browse opens (Open folder mode, and "Clone into" in Clone mode) has a New Folder button.
- [ ] A folder made there can be picked at once, and Create starts the session in it.
- [ ] The picker starts where it does today (next to the last folder picked, else next to the newest session) and can go to any folder.
- [ ] Multi-Code puts nothing in the new folder: no `git init`, no files.

### Story 2: Open folder refuses a folder that doesn't exist

**As a** Multi-Code user
**I want to** be told when the path I typed doesn't exist
**So that** I don't get a session that fails to start

**Acceptance Criteria:**
- [ ] In Open folder mode, Create with a typed path that doesn't exist shows "This folder does not exist: <path>" with a pointer to Browse → New Folder, and starts nothing.
- [ ] A path that names a file, not a folder, is refused the same way.
- [ ] `~` at the start of a typed path means the home folder.
- [ ] An existing folder works as today, including the duplicate warning and the required alias.

### Story 3: Clone from Git

**As a** Multi-Code user
**I want to** paste a Git link, pick where it goes, and get a session in the clone
**So that** I don't have to clone it in a terminal first

**Acceptance Criteria:**
- [ ] The dialog has two modes at the top, Open folder and Clone from Git. It opens in the mode used last (Open folder the first time). Backend and Alias are in both modes.
- [ ] Clone mode has Git URL, Clone into (with Browse) and Folder name (optional, empty by default, its placeholder the repo's name taken from the URL), and shows the full target path under them.
- [ ] Empty Folder name means the repo's name, as `git clone <url>` does; a typed one is used as is (`git clone <url> <name>`). A name with `/` is refused.
- [ ] https, `ssh://` and `git@host:path` links are taken, and a GitHub page link (`https://github.com/<owner>/<repo>`, with or without more path after it) clones that repo. Anything else, `owner/repo` included, is refused with "This is not a Git URL…".
- [ ] "Clone into" starts at the folder cloned into last, else the last folder picked, else the newest session's parent. A "Clone into" that doesn't exist is refused like Story 2.
- [ ] If the target already exists, the dialog says so, Clone is off, and "Open it" starts a session in that folder (the same duplicate rule as Open folder). Typing another Folder name clears it.
- [ ] Alias says after its label, in grey, that it is the session's name in the sidebar (both modes).

**Notes:**
- Folder name is the folder on disk; Alias is the session's name in the sidebar. They are separate. (decided 2026-11-04)
- The default branch, a full clone; no branch choice.

### Story 4: Wait for the clone in the dialog

**As a** Multi-Code user
**I want to** see the clone's progress and be able to stop it
**So that** a slow or wrong clone doesn't leave me guessing or with junk on disk

**Acceptance Criteria:**
- [ ] While git runs, the dialog shows the target and git's latest progress line, with a progress bar while git reports a percentage; every field and the mode switch are off; Clone reads "Cloning…"; Cancel reads "Cancel clone".
- [ ] While git runs, Esc and a click outside the dialog do nothing.
- [ ] "Cancel clone" stops git, removes the target folder if this clone made it, and says so in the dialog; the fields come back as they were.
- [ ] If git fails, the dialog shows "git clone failed" with git's own last lines, and nothing is left at the target. The fields come back so the link can be fixed.
- [ ] git never waits for typed input: a repo that needs a username, password or passphrase fails at once with git's words.
- [ ] When git finishes, the dialog closes and a session starts in the clone, with the chosen backend and alias.
- [ ] A folder that existed before the clone began is never removed or written to.

## Non-Functional Requirements

- **Performance:** progress shows within a second of git reporting it; a clone of a 400 MB repo works (no time limit of Multi-Code's own).
- **Security:** the URL and folder name reach git as arguments, never through a shell, and a URL can't be read as a git option. Removal is limited to the folder this clone made.
- **Environment:** git runs as it would in a new terminal tab (the builder's login-shell environment), so the builder's SSH key and git settings apply.

## Technical Constraints

- macOS only, as the rest of Multi-Code. The picker is the system one.
- No new dependencies.

## Dependencies

- `git` on the builder's machine, and the builder's own login to their Git host.

## Out of Scope

- `git init`, templates or starter files in a new folder.
- Branch, depth or submodule options; `owner/repo` short form; cloning from the phone.
- Making a folder from a typed path.
- Doing anything in the clone after it finishes (installs, etc.).

## Open Questions

See `docs/specs/new-project/gaps.md`.

Key blockers:
- G-701: SSH clone from the installed app opened from the Dock. Checked in the builder's test of the release build.

## Success Metrics

- The builder starts a session on a new project or a new clone without opening a terminal first.
