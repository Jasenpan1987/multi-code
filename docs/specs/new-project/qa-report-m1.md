# QA Report: New Project, Milestone 1

**Date:** 2026-11-04
**Scope:** milestone (PRD v1.0, Stories 1 to 4; T-901, T-902, T-903)

## Summary

- Automated: 1775 tests pass (28 skipped, as before), 27 of them new (`shared/gitUrl.test.ts`, `main/new-project.test.ts`). Type check and lint clean.
- In the app: three runs of an isolated dev build (`--user-data-dir=/tmp/mc-np-test`, CDP) against GitHub, with real git: 16 checks, all as the PRD says.
- Found by the review and fixed before this report: 3 (below).
- Left for the builder's test of the installed build: 2 (the native picker's New Folder button, and G-701).

## Results

| Story | Criterion | Automated | In the dev build | Status |
|-------|-----------|-----------|------------------|--------|
| 1 | Picker has New Folder (both Browse buttons) | — | can't drive a native picker over CDP | manual TC-1 |
| 1 | A folder made there starts a session | — | — | manual TC-1 |
| 1 | Picker starts where it did; goes anywhere | — | plain Browse unchanged in code | ✓ |
| 1 | Nothing put in the new folder | no code writes there | — | ✓ |
| 2 | Missing typed path refused, nothing starts | `checkFolder` | `/tmp/mc-np-clones/nope` | ✓ |
| 2 | A file refused the same way | `checkFolder` kind `file` | — | ✓ |
| 2 | `~` means home | `resolveTypedPath` | `~/does-not-exist-zz9` → `~/…` | ✓ |
| 2 | Existing folder as today, duplicate rule | — | warning + "Alias (required)", then alias `second` starts | ✓ |
| 3 | Two modes; opens in the last one; backend and alias in both | — | reopened in Clone from Git | ✓ |
| 3 | Fields, placeholder = repo name, target line | — | placeholder `definitely-missing-repo-zz9`, target shown | ✓ |
| 3 | Empty name = repo name; typed name used; `/` refused | 3 tests | `hw-copy` cloned to `…/hw-copy` | ✓ |
| 3 | https, ssh://, git@, GitHub page; `owner/repo` refused | 4 tests | `…/Hello-World/tree/master` → `Hello-World`; `acme/some-repo` refused | ✓ |
| 3 | "Clone into" default chain; missing one refused | 1 test | home with no contacts; last cloned-into after a clone; newest contact's parent after a restart | ✓ |
| 3 | Target exists: warning, Clone off, Open it | 2 tests | warning, Clone off, Open it started a session there | ✓ |
| 3 | Alias's grey hint, both modes | — | shown | ✓ |
| 4 | Progress line and bar; fields off; button labels | output parser tests | `remote: Compressing objects: 9%` with the bar at 9% | ✓ |
| 4 | Esc and outside click do nothing while cloning | — | outside click kept the dialog (the dialog has no Esc handling) | ✓ |
| 4 | Cancel stops git, removes the folder, says so | 2 tests | `torvalds/linux` and `vuejs/core` cancelled, folder gone | ✓ |
| 4 | Failure shows git's lines, nothing left | 2 tests | missing repo: git's three lines, folder gone | ✓ |
| 4 | git never waits for input | `GIT_TERMINAL_PROMPT=0`, own process group | https to a missing repo failed at once | ✓ (G-701 open) |
| 4 | Done: dialog closes, session starts with backend and alias | — | SSH clone of `octocat/Hello-World`, session started | ✓ |
| 4 | A folder there before is never touched | 2 tests | — | ✓ |
| NFR | No shell; `--` before the URL; removal only of our folder | arguments tested by the fake git | — | ✓ |

## Issues found and fixed in this review

| # | Issue | Severity | Fix |
|---|-------|----------|-----|
| 1 | Quitting Multi-Code during a clone left git running (its own process group) and the half-made folder on disk. | medium | `abortCloneForQuit()` on `before-quit`: kills the group, removes the folder this clone made. Test added. |
| 2 | An unexpected error in main left the clone claimed for good (every later clone "already running"), and a rejected IPC left the dialog at "Cloning…". | medium | The claim is released on every way out; a failed env read falls back to Multi-Code's env; the dialog treats a rejection as a failure. Test added for the env. |
| 3 | The default "Clone into" arrives after the dialog opens and replaced anything typed before it. | low | Only fills an empty field; cleared on close. |
| 4 | The progress box repeated git's own first line ("Cloning into …"). | low | Our line removed. |

No open bugs, so no bug tasks in the kanban.

## Cross-model review (gpt-6.1-sol, after this QA)

Two reviews, split by area (main + shared, renderer); neither touched the tree. Seven
findings, all accepted and fixed; tests 1775 → 1780, both CDP scripts rerun clean.

| # | Finding | Fix |
|---|---------|-----|
| M1 | The folder could be swapped (or a linked parent retargeted) during the clone, and cleanup would remove what is there by then. | The clone records the folder's device and inode after its mkdir and removes only that folder (`removeOwnFolder`). Tests: a folder put in its place, a retargeted parent link. |
| M2 | Cancel escalated to SIGKILL only if git itself was still alive; a helper ignoring SIGTERM and holding stderr kept the clone from ever finishing. | After the grace period the whole group is killed while the clone is unfinished. Test with such a helper. |
| M3 | `GIT_TERMINAL_PROMPT=0` doesn't stop an askpass program (`GIT_ASKPASS`, `core.askPass`, `SSH_ASKPASS`). | `noPromptEnv`: `GIT_ASKPASS=""`, no `SSH_ASKPASS`, `SSH_ASKPASS_REQUIRE=never`, `GCM_INTERACTIVE=never`. The fake git checks it. |
| M4 | A failed removal was still reported as removed. | `removed` in the result; the dialog says the folder is still there and to delete it in Finder. Test with a read-only parent. |
| R1 | A submission still pending (Cancel or a mode change meanwhile) could start a session or close the dialog during a clone. | Create, Clone and Open it run one at a time; controls and Cancel are off meanwhile. |
| R2 | Two quick clicks on Create could both pass the duplicate check. | Same single-flight guard. |
| R3 | While a new target check was pending, the old result still drove Clone off and Open it. | A check counts only for the path typed now. |

One fix of mine was undone during the rerun: M1 first took the parent's real path, which
made a clone's path (`/private/tmp/…`) differ from the same folder typed in Open folder
(`/tmp/…`), and the duplicate check (by string) missed it. The inode check alone covers
M1, so the path stays as typed.

## Known limits (not bugs)

- The first clone of a run waits for the login-shell env (about 1.5 s here, "Starting git…"). The dialog now starts reading it as it opens.
- A huge repo can sit in git's "Enumerating objects" phase for many seconds with no percentage; the bar shows only when git gives one.
- Closing the window (not quitting) during a clone: git finishes, the folder stays, no session starts.
- A second contact on a stopped contact's folder needs no alias (the duplicate rule counts running ones only, as before).

## Manual tests for the builder (installed build)

1. **TC-1, New Folder (Story 1).** New → Open folder → Browse. Press New Folder, make `~/code/study/qa-new`, press Open, then Create. Expected: a session starts in it, and the folder is empty.
2. **TC-2, private repo over SSH (G-701).** Open the installed app from the Dock. New → Clone from Git, paste a private `acme` repo's SSH link (`git@github.com:acme/…`), Clone into `~/code/work`. Expected: progress, then a session in the clone. If it fails, the dialog shows git's words.

## Recommendation

Release. TC-1 and TC-2 go to the builder with the installed build.
