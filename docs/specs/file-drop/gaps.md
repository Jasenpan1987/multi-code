# File Drop Epic — Gaps

Raised in the 2026-10-28 ideation (`docs/timeline/2026-10-28_file-drop-ideation.md`).

## Resolved Gaps

| ID | Question | Resolution | Resolved |
|----|----------|------------|----------|
| G-201 | After the file lands, does Multi-Code do anything else, such as putting the path in the compose box? | No. It only copies the file. The builder tells the session, as today. | 2026-10-28 builder |
| G-202 | Where can a file be dropped, and which project does it go to? | Anywhere on the window; it goes to the selected session's project. A sidebar row as a second target was not chosen. | 2026-10-28 builder |
| G-203 | One default folder per project, or one for every project? | One per project, keyed by the project directory (cwd), so two contacts on one project share it. | 2026-10-28 builder |
| G-204 | Which apps are files dragged from? | Finder and the Desktop only. Outlook, Teams and browser drags are out of scope for v1. | 2026-10-28 builder |
| G-205 | Does Multi-Code look for the OMT input folder as the default? | No. The feature has nothing to do with OMT; the OMT input folder was only an example of a folder someone picks. The first drop in a project says there is no default yet and opens a folder picker; the folder picked is the default. (First recorded as a look-up order, inbox then `docs/raw/`; the builder corrected it the same session.) | 2026-10-28 builder |
| G-206 | Does a file dropped on the window today replace the UI? | No. Electron's `navigateOnDragDrop` defaults to `false`; a synthetic CDP drop left the page in place. | 2026-10-28 probe |
| G-207 | Copy or move, name clashes, several files, folders, cancel, Manager selected | Copy; Finder-style rename, never overwrite; one confirmation for all; folders copied whole; cancel copies nothing; refused when Manager or no session is selected. | 2026-10-28 builder |
| G-208 | Is an automatically found OMT folder saved as the default, or looked up on every drop? | Moot: nothing is found automatically (G-205). | 2026-10-28 builder |
| G-209 | After "Change default path", can the builder go back to the automatic OMT folder? | Moot: there is no automatic folder (G-205). | 2026-10-28 builder |
| G-210 | An OMT 3.x project has no `docs/sources/inbox/`: create it? | Moot: Multi-Code does not look at OMT folders (G-205). | 2026-10-28 builder |
| G-212 | What does the confirmation look like, and which keys answer it? | A dialog in the middle of the window, in the style of the existing dialogs: Put here (primary, Enter), Somewhere else…, Change default path…; Esc or a click outside cancels. A small panel under the terminal was offered and not chosen. Layout in PRD Story 3. | 2026-10-28 builder |
| G-211 | Do a real Finder drag and `webUtils.getPathForFile` give the real path in Multi-Code? | Yes for files: the builder dragged two files from `~/Downloads`; the `[file-drop]` trace shows their full real paths and the copies on disk match. The folder half no longer applies (folders refused, PRD v1.2). | 2026-10-28 builder's Finder test |
| G-213 | Limits on one drop? | At most 10 files and 1 GB (1,000,000,000 bytes) in total; folders refused; past a limit nothing is copied and the message says to place the files in Finder. PRD Story 6. | 2026-10-28 builder |

## Open Gaps

| ID | Question | Impacts | Ask | Status |
|----|----------|---------|-----|--------|
(none)
