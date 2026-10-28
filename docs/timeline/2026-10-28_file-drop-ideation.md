# File Drop — ideation

**Date:** 2026-10-28
**Type:** ideation
**Participants:** Jasen (builder), Claude
**Source:** (verbal, builder-described), plus probes in `.omt/probes/file-drop/`
**Outcome:** new epic `docs/specs/file-drop/`

## The ask

The builder often has to put a file into a project: a Word or Excel document, a CSV, a
Markdown file, a screenshot. Today that means clicking "Go to Code Base" in Quick Actions
(which only opens VS Code on the project) and dragging the file into the right folder
there, usually the OMT input folder. The builder wants to drop the file on Multi-Code
itself and have it land in the right folder.

## Summary

A file dragged from Finder onto any part of the Multi-Code window is copied into the
selected session's project. Each project has a default folder, which the builder picks on
the first drop in that project. Every later drop asks "Put it here?"
with three answers: put it here, choose another folder for this drop only, or change the
default folder. Multi-Code only places the file; it never types anything into the session.

## Key Decisions

- **Only place the file.** Multi-Code copies the file and stops. The builder then tells the
  session (runs `digest`, and so on), as today. — builder, reason: simplest, and nothing
  is written into a session.
- **Drop anywhere on the window; the target is the selected session's project.** To place
  a file in another project, switch to it first. Dropping on a sidebar row was offered and
  not chosen. — builder
- **One default folder per project, keyed by the project directory (cwd).** Two contacts on
  one project share it. Changing it in project A leaves project B alone. A single global
  relative path was offered and not chosen. — builder
- **The builder picks the default; Multi-Code finds nothing by itself.** The first drop in
  a project says there is no default folder yet and opens a folder picker; the folder
  picked becomes the default. Nothing depends on OMT. — builder
  - *Correction, same session:* I first recorded a look-up order (`docs/sources/inbox/`,
    then `docs/raw/`, else ask). The builder corrected it: the OMT input folder was only an
    example of a folder someone would pick, and the feature has nothing to do with OMT.
- **v1 takes Finder drags only.** The builder drags only from Finder or the Desktop.
  Outlook, Teams and browser drags are out of scope; the window says it can't take them.
  — builder
- **Every file type is accepted.** Copying does not look at the type, so limiting types
  would be extra work. — builder (wanted all types), Claude (no cost)
- **Defaults confirmed by the builder:**
  - Copy, not move. The original stays where it is.
  - A name already taken in the target: renamed the way Finder does (`report 2.docx`),
    never overwritten.
  - Several files in one drop: one confirmation for all of them.
  - A folder dropped: copied whole.
  - First drop in a project with no default: the folder picked becomes the default and
    the files go there, with no second confirmation.
  - Cancel or Esc at any step: nothing is copied.
  - After the copy: a short notice with the path relative to the project
    (`docs/sources/inbox/report.docx`).
  - Manager selected, or no session selected: the drop is refused and the overlay says why.
  - "Choose another folder" does not change the default. "Change default path" changes it
    and also places this drop there.

## Facts Learned

- **The folders the builder will usually pick.** OMT 3.x keeps unprocessed inputs in
  `docs/sources/inbox/`; legacy OMT uses `docs/raw/`. Multi-Code does not look for either
  (see the correction above). Source: `omt-protocol` skill in
  `apra-amcos-cc-marketplace/omt` 3.6.0.
- **Multi-Code has no file drop handling today.** The only drag code is contact reordering
  in `ContactList.tsx`. "Go to Code Base" calls `openInVSCode(instance.cwd)`.
- **A dropped file does not replace the UI.** Electron's `navigateOnDragDrop` web
  preference defaults to `false`, and Multi-Code does not set it. Probe: a synthetic CDP
  drop on an unhandled page left `location.href` unchanged. (I first told the builder the
  opposite, before the probe; corrected the same day.)
- **A page that handles `dragover` gets the files on `drop`.** Probe: with
  `preventDefault()` on `dragenter`/`dragover`, the `drop` event carried
  `sample.txt (6 bytes)`. Without it, no `drop` event fires at all.
- **The real path needs the preload.** Electron 44 has no `File.path`; the preload must
  call `webUtils.getPathForFile(file)`. Not yet tried in Multi-Code (G-211).
- **The probe was synthetic.** `Input.dispatchDragEvent` goes through Chromium's own drag
  path, but a real Finder drag was not tried (G-211).
- A folder picker already exists (`select-directory` in `ipc-handlers.ts`), and the compose
  box already saves pasted images to a temp file (`save-clipboard-image`).

## Open Questions

See `docs/specs/file-drop/gaps.md`, G-211 and G-212.

## New Terms

| Term | Meaning | Example |
|------|---------|---------|
| Default folder | The folder a drop in a project goes to unless the builder picks another for that drop; the builder sets it on the first drop | `docs/sources/inbox/` |
