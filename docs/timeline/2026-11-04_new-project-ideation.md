# New Project — ideation

**Date:** 2026-11-04
**Type:** ideation
**Participants:** Jasen (builder), Claude
**Source:** (verbal, builder-described), plus a clickable mock in `.omt/probes/new-project/mock.html` (two versions)
**Outcome:** new epic `docs/specs/new-project/`

## The ask

"New" can only open a folder that already exists. The builder wants Multi-Code itself to
(1) make the folder of a project that doesn't exist yet, and (2) clone a Git repo from a
pasted link into a folder they choose, then open a session there. The builder said they
were not clear on the details, so the shape was worked out by questions and then by a
clickable HTML mock.

## Summary

The New Instance dialog gets two modes at the top: Open folder (today's dialog) and Clone
from Git. A new project is only an empty folder, made with a "New Folder" button in the
macOS folder picker that Browse opens. Clone from Git takes a Git URL, a parent folder and
an optional folder name, runs `git clone` while the dialog shows its progress and a
Cancel button, and starts the session in the clone when it's done. The builder tried the
mock twice and approved it ("非常好，implement 吧").

## Key Decisions

- **A new project is an empty folder, nothing more.** No `git init`, no starter files; the
  session does the rest if asked. — builder (offered: folder plus `git init`)
- **The folder is made with the picker's "New Folder" button.** Browse's macOS picker gets
  its New Folder button (`createDirectory`). Typing a path that doesn't exist does not make
  it. — builder (offered: make the folder from a typed path on Create)
- **The picker goes anywhere.** It starts next to the last folder picked (else the newest
  session's parent, as today), but the builder can go to any folder (Favorites, Up,
  ⇧⌘G). — builder's question on mock v1 ("why acme?"); no change to the start rule
- **Two modes at the top of the dialog: Open folder / Clone from Git.** — builder (offered:
  one field that tells a path from a URL)
- **Wait for the clone in the dialog.** Progress and a Cancel button; errors shown in the
  dialog. Other sessions can't be used meanwhile. — builder (offered: a "Cloning…" contact
  in the sidebar)
- **Folder name is optional and empty by default.** Empty means the repo's name, as
  `git clone <url>`; a typed name is `git clone <url> <name>`. Its placeholder shows the
  repo's name. — builder, after mock v1 had it pre-filled ("这东西有什么用啊？")
- **Folder name is not the Alias.** Alias stays the session's name in the sidebar; it now
  says so in grey after its label, in both modes. — builder (point raised by the builder;
  the grey hint was in mock v2 and approved with it)
- **Defaults confirmed by the builder:**
  1. Any URL git takes: https, SSH (`git@…`), a GitHub page link. No `owner/repo` short form.
  2. The default branch, a full clone. No branch choice.
  3. "Clone into" starts at the last folder picked.
  4. Target folder already there: not overwritten; the dialog says so and offers "Open it"
     (a session in that folder). A different folder name clones a second copy.
  5. Cancel during a clone: git is stopped and the half-made folder Multi-Code created is
     removed.
  6. git never waits for a username or password: it fails and the dialog shows git's own words.
  7. Open folder, a typed path that doesn't exist: Create says the folder doesn't exist and
     starts nothing.
  8. The phone is not changed.
- **Approved with mock v2, not asked one by one:** the dialog opens in the mode used last;
  during a clone, a click outside and Esc do nothing (only Cancel stops it); "Clone into"
  starts at the folder cloned into last, else the last picked parent, else the newest
  session's parent.

## Facts Learned

- **The picker has no New Folder button today.** `select-directory` in `ipc-handlers.ts`
  calls `dialog.showOpenDialog` with `properties: ["openDirectory"]` only.
- **A typed path is not checked.** `create-instance` goes straight to
  `processManager.createInstance(cwd, …)`, which spawns the CLI there.
- **The picker's start is in memory only.** `lastPickedParent` (ipc-handlers.ts) is lost on
  restart; then it starts at the newest contact's parent.
- **The builder's projects.** 63 repos under `~/code/work` (the company's GitHub org,
  `acme`), others under `~/code/study` and `~/code`. The largest `.git` is 397 MB
  (`acme-portal-web`), so a clone can take a minute or two.
- **The builder's git login.** `gh` is logged in to github.com with SSH as its git protocol;
  the key is `~/.ssh/id_rsa`. git is `/opt/homebrew/bin/git` 2.37.1. Multi-Code opened from
  the Dock has the bare launchd PATH; OpenCode's spawns already use the builder's login-shell
  environment (`backends/opencodeShellEnv.ts`).
- **Multi-Code already runs git** for the Git and Diff panels (`git-status.ts`,
  `git-diff.ts`, `execFile("git", ["-C", cwd, …])`).
- **The phone can't create sessions** (nothing in `remote-protocol.ts`).

## Open Questions

See `docs/specs/new-project/gaps.md` (G-701).

## New Terms

| Term | Meaning | Example |
|------|---------|---------|
| Clone into | The parent folder a clone goes into | `~/code/work` |
| Folder name | The clone's folder in "Clone into"; empty means the repo's name | `portals-v2` |

## Raw Source Reference

Provided in chat; the mock is `.omt/probes/new-project/mock.html` (not in git).
