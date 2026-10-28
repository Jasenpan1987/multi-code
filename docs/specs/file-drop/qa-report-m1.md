# QA Report: file-drop M1
**Date:** 2026-10-29
**Scope:** milestone M1 (T-701..T-705), against PRD v1.1
**Build:** `fd/qa-m1` = `feat/file-drop` at 58cb29b, `pnpm build`, isolated dev build
(`--user-data-dir=/tmp/fd-qa-userdata`, page CDP 9464, main inspector 9465,
`MULTICODE_DEBUG=1`). Every contact stayed stopped. No native panel opened.

## Summary
- **Tests run:** `pnpm test` 1557 passed, 28 skipped (74 files passed, 2 skipped), of which
  129 are the epic's own (`file-drop.test.ts` 39, `file-drop.display.test.ts` 10,
  `settings-store.test.ts` 23, `dropTarget.test.ts` 5, `dropFlow.test.ts` 32,
  `dropNotice.test.ts` 20). `pnpm lint`: 0 warnings, 0 errors. `pnpm type`: clean.
  The two known flaky tests passed in the full run.
- **CDP checks:** 229 in the final runs, all passing. New QA scripts: Story 1 (38),
  Stories 2/3/5 (51), Story 4 and NFRs (40), disk full (4), real picker and focus
  handlers plus pre-restart (12), post-restart (9). Re-runs of the earlier tasks' probes:
  `t704-keys` 23/23, `t705-checks` 40/40, `t705-fixes` 12/12. The first runs had four
  failures. All four were mistakes in the new scripts' expectations, and are explained
  under "How checked".
- **Criteria:** 44 rows (38 story criteria, 4 NFRs, 2 technical constraints): **35 pass,
  0 FAIL, 9 need the builder** (the native folder panel, a real Finder or browser drag,
  a real Esc).
- **Issues:** 4, all low. Nothing blocks the builder's test.
- **Manual tests required:** 9 test cases in `test-plan-m1.md` (about 5 minutes), which
  also close G-211.

How the stubs worked: `window.electronAPI` is frozen, so stubbing happened in main
through `--inspect`. Most runs replaced the picker and focus IPC handlers
(`stub.mjs`, `t705-stub.mjs`). One run (`qa-stub2.mjs`) kept the real
`file-drop-pick-folder` and `file-drop-focus-window` handlers and replaced only what they
call: `dialog.showOpenDialog` (records its options, never opens a panel), `app.focus` and
the window's `focus` (recorded, never activate the app). Each replacement was checked to
be in place before the first drop. `pty-input` and `view-key` were recorded on every run:
none was ever sent. Files were checked on disk, not in the UI.

Scripts (not committed, `.omt/` is ignored): `.omt/probes/file-drop/qa-setup.sh`,
`qa-lib.mjs`, `qa-story1.mjs`, `qa-flow.mjs`, `qa-copy.mjs`, `qa-diskfull.mjs`,
`qa-stub2.mjs`, `qa-restart1.mjs`, `qa-restart2.mjs`, `qa-cancel-probe.mjs`,
`qa-symlink.mjs`. Screenshots: `.omt/qa-*.png`.

## Results
| Story | Criterion | How checked | Result |
|-------|-----------|-------------|--------|
| 1 | Overlay over any part of the window, names contact and directory | `Input.dispatchDragEvent` with files at the sidebar, terminal, toolbox, header and bottom right. The overlay is up after the first `dragenter`, before any `dragover`. It is 0,0,1200×800 and shows `fd-project` and `/tmp/fd-qa-project`. Directories with two spaces and with Chinese are shown exactly (`qa-overlay-spaced.png`, `qa-overlay-chinese.png`). The 28px title strip is in the builder's test | pass |
| 1 | Goes away when the drag leaves or is cancelled with Esc, nothing happens | Leave: a `dragOver` past the window edge fires `dragleave` and the overlay goes, with no call to main. Esc: CDP's `dragCancel` fires no `dragleave` in the page (`qa-cancel-probe.mjs`), so it can't stand in for Esc. The overlay stays until the next press (the safety net, checked). Needs a real Esc | needs the builder |
| 1 | Release starts Story 2 (no default) or Story 3 (default set) | No default: focus call, then the picker, no dialog. Default set: the dialog, no picker. Also dropped on the sidebar | pass |
| 1 | Manager or no selection: overlay says why, release does nothing | Fresh page (nothing selected): "Files can't be dropped here" plus the reason, `dropEffect` none. Manager: "Files can't be dropped on the Manager" plus the reason. Release: no call to main, no dialog, no message | pass |
| 1 | Text or link drag: no overlay, release does nothing | `text/plain`, and `text/uri-list` with `text/plain`: no overlay, no `preventDefault`, no `Files`. Release: nothing | pass |
| 1 | Item with no file on disk: nothing copied, message says only Finder | Synthetic: a page-made `File` (no path, as `getPathForFile` gives `""`) shows "Only files from Finder can be dropped", copies nothing, makes no call to main, and leaves the focus where it was. Not checked: what a real browser image drag hands over on macOS (a file promise could arrive as a temp file with a path) | needs the builder |
| 1 | Contact reordering unchanged, no overlay | Real in-page drag (mouse press and moves, `Input.setInterceptDrags`). The row moved, `contacts.json` saved the new order, the drag carried only `text/plain`, no overlay | pass |
| 1 | A drop never sends anything to the session | `pty-input` and `view-key` recorded in main across every run: 0. Keys typed between the drop and the dialog never reached a stand-in terminal (`t704-keys`, `t705-checks` §7). The contacts were offline, so the IPC record is the proof, not a live CLI | pass |
| 2 | Picker opens at once, no confirmation first | The dialog was polled every 25 ms while the picker was pending: never shown. The real handler called `dialog.showOpenDialog` on the drop's window. The real panel appearing needs the builder | needs the builder |
| 2 | Picker text "No default folder for <project> yet. …" | The real handler passed `message: "No default folder for fd-qa-project-b yet. Choose where dropped files go."`. Whether macOS shows it in the panel needs the builder | needs the builder |
| 2 | Picker starts in the project directory | `defaultPath` = the contact's `cwd`, including the two-space and Chinese directories. The panel really opening there needs the builder | needs the builder |
| 2 | Picker can create a new folder | `properties: ["openDirectory", "createDirectory"]` from the real handler. The New Folder button needs the builder | needs the builder |
| 2 | Folder picked becomes the default, files copied there | `settings.json` `dropFolders[cwd]` = the picked folder, files on disk, message `docs/sources/inbox/report.docx` | pass |
| 2 | Cancel copies nothing, sets no default | Stubbed cancel, also through the real handler (`canceled: true` → `null`): no entry, no file, no message | pass |
| 2 | Picked folder can be outside the project | `/tmp/fd-qa-outside` for project B: saved, copied, shown as the full path in the message and in later dialogs | pass |
| 3 | Dialog in the middle, existing dialog style | Centre at 600,400 in a 1200×800 window. `.dialog-overlay` > `.dialog.file-drop-dialog`, `.dialog-actions`, `dialog-btn primary`. Layout matches the PRD mock (`qa-dialog-light.png`) | pass |
| 3 | Title counts files and folders, names the project | "Put 2 files in fd-project?", "Put 1 file in …", "Put 6 files and 1 folder in …", "Put 2 folders in …", "Put 8 files in …" | pass |
| 3 | Target folder: relative inside, full path outside, `~` for home | `→ docs/sources/inbox/`, `→ /tmp/fd-qa-outside/`, `→ ~/Downloads/` (Esc, nothing written there), `→ in  box/`, `→ 输入/` | pass |
| 3 | Up to five names, then "+N more" | 7 items: five names then "+2 more"; folders end in `/` (`qa-dialog-seven.png`) | pass |
| 3 | Put here (primary, Enter) copies to the default | Enter and a mouse click both copy. Put here has the focus when the dialog opens. Whether Enter works right after a real Finder drop (window brought forward) is in the builder's test | pass |
| 3 | Somewhere else… picker starts in the default, files go there, default unchanged | Picker `start` = the default (absolute). Files land in the picked folder, and all of `dropFolders` is byte-identical afterwards. The real panel needs the builder | needs the builder |
| 3 | Change default path… picker starts in the default, picked folder becomes the default, files go there | The real handler got `defaultPath` = the default and `createDirectory`. The default is saved and the file copied there. The real panel needs the builder | needs the builder |
| 3 | Esc or a click outside closes, copies nothing | Esc, and a click at 1100,700: closed, inbox unchanged, no message. A click inside the dialog keeps it open | pass |
| 3 | Cancelling either picker copies nothing, default unchanged | Both pickers cancelled: no copy, `dropFolders` unchanged, no message, dialog closed (a recorded T-704 call) | pass |
| 4 | Copied, originals stay | Whole source tree (mode, size, sha1 per entry) identical before and after every run | pass |
| 4 | Every file type accepted | `.docx .xlsx .txt .csv .md .png .svg .env` in one drop, each copy byte-identical | pass |
| 4 | A dropped folder is copied whole | `assets/` with `img/icons/` and an empty folder: tree identical (modes and hashes) | pass |
| 4 | Finder-style renames, never overwrite | `report 2.docx`, then `report 3.docx`. `data 2.csv`. Folder `assets 2` (whole). The original `report.docx` is unchanged | pass |
| 4 | Several files confirmed once, copied together | 8 files: one focus call, one dialog, one copy call, one message | pass |
| 4 | Message shows each new path relative to the project, renamed ones by their new name | `inbox/report 3.docx (renamed)`, `docs/sources/inbox/…`, full path outside the project, folders with `/`. Capped at five lines plus "+N more copied" (Issue 2) | pass |
| 4 | Message goes by itself, never takes the keyboard | Gone after about 6 s (5.9 s), or about 12 s when something failed (11.7 s). The focus stayed on the stand-in terminal and typing reached it while the card showed. Nothing in the card can be focused | pass |
| 4 | Folder into itself or its subfolder refused, message says so | `inbox` into `inbox/sub`, `sub` into itself, the project folder into its own `inbox/sub`: "…: can't copy a folder into itself". The other items in the same drop copied | pass |
| 4 | Can't copy: message names the file and the reason | `secret.txt` (chmod 000): "secret.txt: no permission", nothing left in its place. Disk full on a 3 MB volume (`hdiutil -nobrowse`): "big.bin: disk full", no truncated file left, the other file copied. A folder with an unreadable file inside names only the folder (Issue 1) | pass |
| 4 | A large copy doesn't freeze the window, "Copying…" while it runs | 4000 files in 40 folders, 0.6 to 0.9 s. "Copying…" shown. Longest gap between frames 8 ms. Another IPC answered within 2 ms meanwhile. Typing reached the stand-in terminal during the copy | pass |
| 5 | Kept per project directory, two contacts on one project share it | `fd-project-twin` (same `cwd`) offered `newdefault/` set from `fd-project`, and its Put here landed there | pass |
| 5 | Changing A's default leaves B's | `dropFolders` for project B unchanged after Change default path… on A | pass |
| 5 | Kept after a restart | Three defaults set through the app (first-drop picker, Change default path…), app stopped and started: `settings.json` identical, each contact's dialog offers its folder, no picker | pass |
| 5 | Somewhere else… never changes any default | Whole `dropFolders` compared before and after | pass |
| NFR | Performance | Overlay on the very first `dragenter`. Copy off the UI thread (frame gaps and IPC timing above) | pass |
| NFR | Security | Each copy landed only in its target folder (checked on disk at every step). At the end the project roots held only the folders the scripts made. Never overwritten (clash runs). Never deleted (sources identical, partial copies kept). No renderer network request during the drops in `qa-restart1` (CDP `Network`). The copy path in main (`file-drop.ts`, the `file-drop-*` handlers) has no network code | pass |
| NFR | Session safety | 0 `pty-input` / `view-key` in every run. Keys held from the drop until the dialog has them, and given back on every ending (`t704-keys` 23/23, `t705-checks` §7) | pass |
| NFR | Accessibility (keyboard) | Tab rounds the three buttons and never leaves the dialog. Shift+Tab goes back. Enter on a focused button presses that button. Enter elsewhere is Put here. Esc cancels | pass |
| Tech | Real path of a dropped file through `webUtils.getPathForFile` | Only synthetic CDP drops. G-211 | needs the builder |
| Tech | Defaults in `userData`, never in the project | Only `/tmp/fd-qa-userdata/settings.json` changed. No settings file appeared in any project | pass |

Notes on the first runs: (1) `qa-flow` read a stale picker call when checking project B,
and counted a folder `qa-setup.sh` had made. (2) `qa-copy` expected the failure lines out
of drop order. The message keeps lines in the drop's order, and keeps failures over later
copies when it has to cut. Both scripts were fixed and the final runs are the numbers
above.

Recorded decisions that differ from the PRD's literal text (not issues, for the record):
the "default folder no longer exists" text shows the folder as the dialog would
(`gone-folder/`), not its absolute path (T-704). Cancelling a picker opened from the
dialog also closes the dialog (T-704). The message is capped at five lines (T-705; see
Issue 2).

## Edge cases
| # | Scenario | Expected | Result |
|---|----------|----------|--------|
| 1 | Same file three times | `report.docx`, `report 2.docx`, `report 3.docx`; first unchanged | pass |
| 2 | Same folder twice | `assets`, `assets 2`, both whole | pass |
| 3 | Folder with subfolders and an empty folder | Tree identical | pass |
| 4 | Folder into itself; into its own subfolder; the project into its own subfolder | Refused with "can't copy a folder into itself"; the rest of the drop copies | pass |
| 5 | A file dropped into its own folder | `own 2.txt`, original untouched | pass |
| 6 | Unreadable file (chmod 000) beside readable ones | "secret.txt: no permission"; nothing left in its place; others copied | pass |
| 7 | Folder holding an unreadable file | "inbox/partial/ (partly copied: no permission)"; `a.txt` kept. `c.txt`, after the unreadable one, not copied (Issue 1) | pass (see Issue 1) |
| 8 | Disk full (3 MB volume) | "big.bin: disk full"; no truncated file; other file copied | pass |
| 9 | Default folder deleted | Picker at the project with "The default folder gone-folder/ no longer exists. …"; cancel keeps the entry and creates nothing; a pick replaces it | pass |
| 10 | Two contacts on one project | Share the default | pass |
| 11 | Restart with three defaults and the dark theme | All kept, dark theme applied | pass |
| 12 | Theme set from the UI, then a default saved; then the theme changed | Theme kept; then every default kept | pass |
| 13 | Manager selected; nothing selected | Refused overlay with the reason; release does nothing | pass |
| 14 | "+ New" dialog open; the drop's own dialog open | No overlay, `dropEffect` none, the drop ignored; the first dialog unchanged | pass |
| 15 | Text drag; link drag | No overlay, not prevented, nothing happens | pass |
| 16 | Contact reordering by drag | Moves and saves; no overlay | pass |
| 17 | Image dragged inside the page (carries `Files`) | Ignored: no overlay, not prevented, no call to main | pass |
| 18 | Two spaces in file names, folder names and the project path | Shown and copied exactly (`in  box/report  final.docx`) | pass |
| 19 | Chinese in file names and the project path | `输入/报告 第一版.docx`, picker at `/tmp/fd-qa-项目 资料` | pass |
| 20 | 7 files; 6 files and an unreadable one | Dialog: five names and "+2 more". Message: five lines and "+2 more copied"; the failure is never the one cut | pass |
| 21 | Esc; click outside; click inside; either picker cancelled | Nothing copied, defaults unchanged; a click inside keeps the dialog | pass |
| 22 | Stopped contact | Accepts drops (every QA contact was Offline) | pass |
| 23 | Slow or hung lookups before the dialog | Keys held, nothing reaches the terminal; error at 10 s; late answers open nothing (`t704-keys`, `t705-checks` §7, `t705-fixes` B) | pass |
| 24 | Two drops copying at once | A card each; each drop's result replaces only its own "Copying…" (`t705-checks` §6) | pass |
| 25 | 4000-file folder | "Copying…", then `inbox/many/`; window and main responsive | pass |
| 26 | Default under home; outside the project | `~/Downloads/`; `/tmp/fd-qa-outside/` | pass |
| 27 | Dialog and message, light and dark (and sepia, `t705-message-sepia.png`) | Readable in each; the dialog keeps the dialogs' own palette by design | pass |
| 28 | Project stored as `/tmp/…`, default stored as `/private/tmp/…` | Should show relative; shows the full `/private/tmp/…` path (Issue 4) | pass (see Issue 4) |
| 29 | Real Esc during a Finder drag | Overlay goes, nothing copied | needs the builder |
| 30 | Drag over the 28px title strip | Overlay shows there too; release there drops | needs the builder |
| 31 | Image dragged from a browser | Only-Finder message, nothing copied | needs the builder |
| 32 | Enter right after a Finder drop (Finder still in front) | Window comes forward, Enter reaches Put here | needs the builder |
| 33 | The real folder panel: text, start folder, New Folder, Enter, Cancel | As Story 2 and 3 say | needs the builder |
| 34 | The message on the builder's real window | Placed bottom right, readable, not over the prompt | needs the builder |

## Issues found
| # | Criterion / case | What went wrong | Severity (critical/high/medium/low) | Suggested fix |
|---|------------------|-----------------|-------------------------------------|---------------|
| 1 | Story 4 "names the file and the reason"; edge 7 | Steps: drop a folder `partial/` holding `a.txt`, `b-locked.txt` (chmod 000) and `c.txt`. Expected: the message tells the builder what wasn't copied. Actual: "inbox/partial/ (partly copied: no permission)". The file that failed isn't named, and the walk stops at the first error, so the readable `c.txt` after it is missing too and nothing says so. `fillFolder` throws on the first failing entry (`main/file-drop.ts:158`), and `copyOne` turns it into one `partly copied:` reason (`:211`) | low | Put the failing entry's path, relative to the dropped folder, in the reason ("partly copied: b-locked.txt: no permission"). Optionally go on past unreadable entries and count what was skipped |
| 2 | Story 4 "shows each file's new path" | With six or more items, only five lines show and the rest read "+N more copied". Nothing in the UI reveals the hidden paths: hover only holds the card, a click dismisses it. The PRD says each file. The five-line cap was a T-705 call (decisions, 2026-10-29) | low | Builder to confirm the cap. If each path must be reachable: expand the card on hover or click, or allow more lines |
| 3 | Deadline message (T-705) | When the window-focus call is what stalls (main busy), the message reads "Nothing copied: reading the default folder took over 10 seconds". `waitingOn` starts as `"folder"` before `focusDropWindow` is awaited (`renderer/App.tsx:783`, `:793`). Seen in `t705-fixes` B | low | Start `waitingOn` at its own value for the focus step, or use wording that names no step |
| 4 | Story 3 target display; edge 28 | `displayPath` compares path strings (`main/file-drop.ts:261`, `:276`). A project stored through a link (`/tmp/fd-qa-project`) with its default in resolved form (`/private/tmp/fd-qa-project/inbox`) shows `→ /private/tmp/fd-qa-project/inbox/` and full paths in the message, where `inbox/` is expected. Reproduced by seeding (`qa-symlink.mjs`). Not checked: whether the real panel returns resolved paths. Contacts made through "+ New" use the same panel, so they probably match | low | Compare `realpath`s in `displayPath` (main has `fs`), falling back to the strings. Or record the case and move on |

Also seen, not a defect: the debug trace writes lines only when a copy runs. A drop that
ends in a cancel, or in the only-Finder message, leaves no `[file-drop]` line. For G-211
that means a folder whose `getPathForFile` came back `""` would show only on screen. The
test plan has the builder note what each step showed.

## Recommendation
M1 passes every acceptance criterion that CDP can reach, with no failures and no
critical, high or medium issues. It is ready for the builder's manual test
(`test-plan-m1.md`), which covers the 9 criteria marked "needs the builder" and closes
G-211. The four low issues can be filed as follow-ups or accepted as they are. None
blocks M2. After the builder's run, close G-211 in `gaps.md` with the paths the log
showed.
