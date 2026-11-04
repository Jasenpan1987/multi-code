# PRD: File Drop

**Version:** 1.2
**Last Updated:** 2026-10-28
**Status:** approved
**Owner:** Jasen

## Overview

Files dragged from Finder onto any part of the Multi-Code window are copied into the
selected session's project. Each project has a default folder, which the builder picks on
the first drop there; every later drop asks "Put here?" and offers another folder for that
drop only, or a new default. Multi-Code only places the files. It never types anything
into the session.

## Background & Context

Putting a Word or Excel document, a CSV, a Markdown file or a screenshot into a project
means clicking "Go to Code Base" (which opens VS Code on the project), then dragging the
file into the right folder there. The builder does this often, usually into a project's
OMT input folder, and then tells the session about the file.

Multi-Code has no file drop handling today: the only drag code reorders contacts. A file
dropped on the window does nothing (Electron's `navigateOnDragDrop` defaults to `false`).

(source: docs/timeline/2026-10-28_file-drop-ideation.md; decisions.md, the two 2026-10-28
entries)

## Users & Stakeholders

| Role | Who | How they interact |
|------|-----|-------------------|
| Builder | Jasen (and future open-source users) | Drags files from Finder into a project while working with its session |

## User Stories

### Story 1: Drop files anywhere on the window

**As a** Multi-Code user
**I want to** drag files from Finder onto any part of the window
**So that** they go into the project I am working on, without opening VS Code

**Acceptance Criteria:**
- [ ] Dragging files from Finder over any part of the window (sidebar, terminal, toolbox) shows an overlay over the whole window. It names the target: the selected contact's display name and its project directory.
- [ ] The overlay goes away when the drag leaves the window or is released with Esc, and nothing happens.
- [ ] Releasing over the window starts Story 2 (no default folder yet) or Story 3 (a default folder is set).
- [ ] With the Manager selected, or no contact selected, the overlay says files can't be dropped there and why. Releasing does nothing.
- [ ] A drag of text or a link (no files at all) shows no overlay, and releasing it does nothing.
- [ ] A drop in which an item has no file on disk (for example an image dragged from a browser) copies nothing, and the message (Story 4) says only files from Finder can be dropped. *(v1.1: replaces "gets an overlay that says only files from Finder can be dropped". While a drag is in progress the page sees only that files are coming, not their paths, so the overlay can't tell these apart; probe 2026-10-28: `dataTransfer.files` is empty on `dragenter`/`dragover`, with `types` = `["Files"]`.)*
- [ ] Reordering contacts by drag in the sidebar works as before and shows no overlay.
- [ ] A drop never sends anything to the session: no keystrokes, nothing in the compose box.

**Notes:**
- The target is always the selected contact's project. To drop into another project, switch to it first. (decided 2026-10-28; a sidebar row as a second target was not chosen)
- Assumed, confirmed by the builder on 2026-10-28: a stopped contact's project accepts drops. Copying needs only the directory, not a running session.
- Assumed, confirmed by the builder on 2026-10-28: while a Multi-Code dialog is open (this feature's or another), a drop is ignored and the overlay does not appear.

---

### Story 2: The first drop in a project sets its default folder

**As a** Multi-Code user
**I want** the first drop in a project to ask me where its files go
**So that** later drops go there without asking again

**Acceptance Criteria:**
- [ ] When the project has no default folder, the drop opens a folder picker at once, with no confirmation dialog first.
- [ ] The picker shows the text "No default folder for <project> yet. Choose where dropped files go."
- [ ] The picker starts in the project directory.
- [ ] The picker can create a new folder.
- [ ] The folder picked becomes the project's default folder, and the dropped files are copied there (Story 4).
- [ ] Cancelling the picker copies nothing and sets no default.
- [ ] The picked folder can be outside the project directory.

**Notes:**
- Multi-Code looks for no folder by itself, and nothing depends on OMT. The OMT input folder is only an example of a folder the builder picks. (decided 2026-10-28)

---

### Story 3: Every later drop confirms the folder

**As a** Multi-Code user
**I want to** see where the files will go, and be able to send them somewhere else
**So that** a file never lands in the wrong place

**Acceptance Criteria:**
- [ ] A drop in a project with a default folder opens a dialog in the middle of the window, in the style of the existing Multi-Code dialogs.
- [ ] The dialog's title says how many files, and which project: "Put 2 files in multi-code?". *(v1.2: was "how many files and folders"; folders are no longer accepted, Story 6.)*
- [ ] The dialog shows the target folder: relative to the project when inside it (`docs/sources/inbox/`), otherwise the full path, with `~` for the home directory.
- [ ] The dialog lists the dropped names, up to five, then "+N more".
- [ ] **Put here** (the primary button, and Enter) copies the files to the default folder.
- [ ] **Somewhere else…** opens a folder picker that starts in the default folder. The files go to the folder picked. The default folder does not change.
- [ ] **Change default path…** opens a folder picker that starts in the default folder. The folder picked becomes the project's default folder, and the files go there.
- [ ] Esc, or a click outside the dialog, closes it and copies nothing.
- [ ] Cancelling either picker copies nothing and leaves the default folder as it was.

**Notes:**
- Layout agreed with the builder on 2026-10-28 (G-212):

```text
┌─────────────────────────────────────────┐
│ Put 2 files in multi-code?              │
│                                         │
│ → docs/sources/inbox/                   │
│     report.docx                         │
│     screenshot.png                      │
│                                         │
│ Change default path…                    │
│            [Somewhere else…] [Put here] │
└─────────────────────────────────────────┘
 Enter = Put here    Esc = cancel
```

- Assumed, confirmed by the builder on 2026-10-28: when the default folder no longer exists (deleted or moved), the drop goes to Story 2, and the picker's text says the old folder is gone: "The default folder <path> no longer exists. Choose where dropped files go."

---

### Story 4: Copy safely, and say where the files went

**As a** Multi-Code user
**I want** files copied, never moved or overwritten, and a short message that says where each one went
**So that** I lose nothing and I know the path to tell the session

**Acceptance Criteria:**
- [ ] Files are copied. The originals stay where they were.
- [ ] Every file type is accepted (Word, Excel, TXT, CSV, Markdown, PNG, SVG, and any other).
- ~~A dropped folder is copied whole, with everything inside it.~~ *Deprecated in v1.2: folders are refused (Story 6).*
- [ ] When the target already has that name, the copy is renamed as Finder does: `report 2.docx`, then `report 3.docx`; a folder becomes `assets 2`. Nothing in the target is ever overwritten. *(v1.2: the folder example no longer applies.)*
- [ ] Several files in one drop are confirmed once and copied together.
- [ ] After the copy, a short message shows each file's new path relative to the project, for example `docs/sources/inbox/report.docx`. A renamed copy shows its new name.
- [ ] The message goes away by itself after a few seconds, and does not take the keyboard from the terminal.
- ~~A folder dropped into itself or into one of its own subfolders is refused, and the message says so.~~ *Deprecated in v1.2: folders are refused (Story 6).*
- [ ] When a file can't be copied (no permission, disk full), the message names the file and the reason.
- [ ] A large copy does not freeze the window. While it runs, the message says it is copying.

**Notes:**
- Assumed, confirmed by the builder on 2026-10-28: when some files of a drop fail, the ones already copied stay, and the message lists both.

---

### Story 5: Each project keeps its own default folder

**As a** Multi-Code user
**I want** each project to remember its own default folder
**So that** projects with different layouts each get their files in the right place

**Acceptance Criteria:**
- [ ] The default folder is kept per project directory. Two contacts on the same project share it.
- [ ] Changing the default in project A does not change project B.
- [ ] Default folders are kept after Multi-Code restarts.
- [ ] "Somewhere else…" never changes any default folder.

---

### Story 6: Limits on one drop *(added in v1.2)*

**As a** Multi-Code user
**I want** a drop to take files only, at most 10 of them and at most 1 GB in total
**So that** a big or unusual drop goes through Finder, where I can see what is happening

**Acceptance Criteria:**
- [ ] A drop of more than 10 files copies nothing: no dialog, no picker. The message says how many were dropped, that the limit is 10, and to place them in Finder.
- [ ] A drop of more than 1 GB in total copies nothing. The message gives the total, says the limit is 1 GB, and says to place them in Finder. 1 GB is 1,000,000,000 bytes, as Finder counts.
- [ ] A drop with a folder in it copies nothing, files included. The message says folders can't be dropped, and to place them in Finder.
- [ ] When the project has a default folder, these messages name it (`docs/`), so the builder knows where to put the files. Without one, they say "the project folder".
- [ ] The limits are checked before the dialog or the first-drop picker.
- [ ] The main process refuses the same cases on its own, so a copy request past the limits copies nothing.
- [ ] Exactly 10 files, or exactly 1 GB, are accepted.

**Notes:**
- Decided by the builder on 2026-10-28: past a limit the whole drop is refused, not copied in part; folders are not needed.

---

## Non-Functional Requirements

- **Performance:** The overlay appears as soon as a drag enters the window. Copying runs without blocking the UI or the terminals.
- **Security:** Multi-Code writes only inside the folder the builder confirmed or picked, and only the files the builder dropped. It never overwrites, never deletes, and sends nothing over the network.
- **Session safety:** No drop, confirmation or message ever writes to a session's terminal.
- **Accessibility:** The dialog is fully usable from the keyboard (Tab between buttons, Enter, Esc).

## Technical Constraints

- Electron 44 has no `File.path`. The real path of a dropped file is available only through the preload (`webUtils.getPathForFile`).
- Default folders are stored in Multi-Code's `userData`, never in the project.
- Tests of a dev build run on their own `--user-data-dir`, never on the real `userData` (see the 2026-10-26 incident in memory).

## Dependencies

- G-211: a real Finder drag confirmed by the builder by hand. Files confirmed on 2026-10-28; the folder half no longer applies (v1.2).

## Out of Scope

- Drags from Outlook, Teams, Slack, browsers, or any app that does not hand over a file on disk.
- Anything after the copy: no path into the compose box, no keystrokes into the session.
- Dropping on a sidebar row to target that row's project.
- Looking for OMT folders, or any folder, automatically.
- Moving files instead of copying.
- Limiting file types.
- A settings page that lists or edits every project's default folder. The default changes only through "Change default path…".
- Uploading files from the phone (phone link).
- Dropping folders (v1.2, decided by the builder on 2026-10-28). A folder is refused with a message to place it in Finder.
- More than 10 files, or more than 1 GB, in one drop (v1.2). The drop is refused with a message to place the files in Finder.

## Open Questions

Full tracking: `docs/specs/file-drop/gaps.md`.

Key blockers: none. G-211 (real Finder drag) is deferred to the builder's test at the end.

## Success Metrics

- Putting a file into a project takes one drag and Enter, without opening VS Code.
- The builder stops using "Go to Code Base" to place files.

## Changelog

- v1.1 (2026-10-28): Story 1, a drop with no file on disk is reported after the drop, not by the overlay. Reason: found while breaking the PRD into tasks; during a drag the page cannot see where the files come from.
- v1.2 (2026-10-28): Added Story 6 (at most 10 files and 1 GB per drop; folders refused; past a limit nothing is copied). Folder criteria in Story 4 deprecated. Reason: the builder's request after the first Finder test.
