# Manual Test Plan: file-drop M1
**Date:** 2026-10-29 · **Tester:** Jasen (builder) · **Environment:** macOS, an isolated dev
build of `feat/file-drop` (58cb29b or later), `--user-data-dir=/private/tmp/fd-test-userdata`,
`MULTICODE_DEBUG=1`. About 5 minutes.

This plan covers only what CDP couldn't check (`qa-report-m1.md`): real Finder drags
(G-211), the real folder panel, the window really coming to the front, Esc during a drag,
the title strip, a browser image, and the message on the builder's own screen.

## Setup (done by Claude)
The scratch paths are under `/private/tmp`, not `/tmp`, so that the folder panel and the
contact name the same path (`/tmp` is a link; see QA Issue 4).

```bash
APP=/Users/jasenpan/code/apra/multi-code            # the epic checkout
git -C "$APP" branch --show-current                  # feat/file-drop
git -C "$APP" merge-base --is-ancestor 58cb29b HEAD && echo "has M1"
(cd "$APP" && pnpm build)

# Scratch state
U=/private/tmp/fd-test-userdata
P="/private/tmp/fd-test project"
F=/private/tmp/fd-test-files
rm -rf "$U" "$P" "$F"
mkdir -p "$U" "$P/docs" "$F/assets folder/icons"
echo "# scratch project" > "$P/README.md"
echo "Q3" > "$F/Q3 report.docx"
echo "草稿" > "$F/报告 第一版.md"
echo "a" > "$F/assets folder/a.txt"
echo '<svg xmlns="http://www.w3.org/2000/svg"/>' > "$F/assets folder/icons/logo.svg"
cat > "$U/contacts.json" <<JSON
[{ "id": "fdtest-1", "cwd": "$P", "alias": "fd-test", "backend": "claude" }]
JSON
printf '%s\n' '{ "theme": "light", "remoteEnabled": false, "secretaryMode": false, "speechServerUrl": "", "dropFolders": {} }' > "$U/settings.json"

# Where this run's trace starts (the log is shared with earlier dev runs). Keep N.
N=$(( $(wc -l < "$TMPDIR/multicode-debug.log" 2>/dev/null || echo 0) + 1 )); echo "N=$N"

# Launch. The port must be free. No --inspect and no stubs: the real panel and the
# real window focus are what this test is for.
lsof -nP -iTCP:9474 -sTCP:LISTEN                     # must print nothing
cd "$APP/workspace/app" && MULTICODE_DEBUG=1 ./node_modules/.bin/electron . \
  --remote-debugging-port=9474 --user-data-dir=/private/tmp/fd-test-userdata \
  > /tmp/fd-test-electron.log 2>&1                   # run in the background
curl -s http://127.0.0.1:9474/json | grep '"url"'    # must be $APP/workspace/app/dist/renderer/index.html

# Hand over: a Finder window with the files to drag
open /private/tmp/fd-test-files
```

Afterwards, stop only this instance: `pkill -f "user-data-dir=/private/tmp/fd-test-userdata"`.
Keep the scratch folders until G-211 is closed.

## Prerequisites
- The DEV window (orange striped strip at the top, one contact `fd-test`) and a Finder
  window on `fd-test-files` are both on screen. Your release Multi-Code can keep running.
- Don't press ▶ on `fd-test`: the test needs no session.
- Each step that copies shows a small card at the bottom right of the window. Note what
  it says when it differs from the expected result.

## Test Cases

### TC-001: First drop opens the panel (Cancel, then a new folder)
**Story:** 1, 2 (G-211, a file) · **Priority:** P1
**Steps:**
1. In Multi-Code, click `fd-test` in the list.
2. In Finder, click `Q3 report.docx`, then drag it onto the middle of the Multi-Code
   window. Before letting go, read the overlay.
3. Let go. Read the panel that opens, then press **Cancel**.
4. Drag `Q3 report.docx` in again and let go. In the panel click **New Folder**, name it
   `inbox`, create it, and with `inbox` open press **Enter**.

**Expected Result:**
- Step 2: the overlay covers the window and reads "Drop files into / fd-test /
  /private/tmp/fd-test project".
- Step 3: the panel opens straight away, with no Multi-Code dialog first. Its text reads
  "No default folder for fd-test yet. Choose where dropped files go." It shows the
  contents of `fd-test project` (`README.md`, `docs`). Cancel copies nothing and shows no
  card.
- Step 4: the card reads "✓ inbox/Q3 report.docx" and goes away by itself after about
  6 seconds.

**Actual Result:** ____
**Status:** [ ] Pass [ ] Fail [ ] Blocked

### TC-002: A folder, then Enter right after the Finder drop
**Story:** 3 (G-211, a folder; the window coming forward) · **Priority:** P1
**Steps:**
1. Click in the Finder window, so Finder is in front.
2. Drag the folder `assets folder` onto Multi-Code and let go.
3. At once, without clicking anything, press **Enter**.

**Expected Result:** Multi-Code comes to the front with the dialog "Put 1 folder in
fd-test?", "→ inbox/", "assets folder/". Enter presses Put here and the card reads
"✓ inbox/assets folder/". Note whether Enter went to Finder instead (for example, Finder
starts renaming the selected item).

**Actual Result:** ____
**Status:** [ ] Pass [ ] Fail [ ] Blocked

### TC-003: Two files at once, one already there
**Story:** 3, 4 · **Priority:** P2
**Steps:** In Finder, Cmd-click `Q3 report.docx` and `报告 第一版.md`, drag both onto
Multi-Code, let go, and press Enter.

**Expected Result:** the dialog reads "Put 2 files in fd-test?" and lists both names. The
card reads "✓ inbox/Q3 report 2.docx (renamed)" and "✓ inbox/报告 第一版.md".

**Actual Result:** ____
**Status:** [ ] Pass [ ] Fail [ ] Blocked

### TC-004: Somewhere else… with the real panel
**Story:** 3 · **Priority:** P1
**Steps:**
1. Drag `报告 第一版.md` in and let go. In the dialog click **Somewhere else…**.
2. Read the panel. Go up one level to `fd-test project`, select `docs`, and click
   **Open**.
3. Drag `报告 第一版.md` in again and read the dialog, then press **Esc**.

**Expected Result:**
- Step 2: the panel opens inside `inbox` and reads "Choose where these files go. The
  default folder stays inbox/." The card reads "✓ docs/报告 第一版.md".
- Step 3: the dialog still offers "→ inbox/". Esc closes it and copies nothing.

**Actual Result:** ____
**Status:** [ ] Pass [ ] Fail [ ] Blocked

### TC-005: Change default path… (Cancel, then a pick)
**Story:** 3, 5 · **Priority:** P1
**Steps:**
1. Drag `Q3 report.docx` in and click **Change default path…**. Read the panel, then
   press **Cancel**.
2. Drag it in again, click **Change default path…**, go up to `fd-test project`, select
   `docs`, and click **Open**.
3. Drag it in once more, read the dialog, and press **Esc**.

**Expected Result:**
- Step 1: the panel opens inside `inbox` and reads "Choose the new default folder for
  fd-test. These files go there too." Cancel closes the dialog and copies nothing.
- Step 2: the card reads "✓ docs/Q3 report.docx".
- Step 3: the dialog now offers "→ docs/". Esc copies nothing.

**Actual Result:** ____
**Status:** [ ] Pass [ ] Fail [ ] Blocked

### TC-006: Esc during a drag
**Story:** 1 · **Priority:** P2
**Steps:** Drag `Q3 report.docx` over the Multi-Code window until the overlay shows. Keep
holding the mouse button, press **Esc**, and then let go.

**Expected Result:** the overlay goes when Esc is pressed, not only after a later click.
No dialog, no panel, no card.

**Actual Result:** ____
**Status:** [ ] Pass [ ] Fail [ ] Blocked

### TC-007: The title strip at the top
**Story:** 1 · **Priority:** P2
**Steps:** Drag `Q3 report.docx` into the window from above, through the orange striped
strip at the top (28 px). Pause over the strip, then let go over it.

**Expected Result:** the overlay shows while the file is over the strip, and letting go
there opens the dialog ("→ docs/"). Press Esc to close it. Note what happened instead,
if anything: no overlay over the strip, nothing on release, or the window moved.

**Actual Result:** ____
**Status:** [ ] Pass [ ] Fail [ ] Blocked

### TC-008: An image from a browser
**Story:** 1 · **Priority:** P2
**Steps:** In Safari or Chrome, drag any picture from a web page onto Multi-Code and let go.

**Expected Result:** the card reads "✕ Only files from Finder can be dropped". No dialog,
no panel, nothing copied.

**Actual Result:** ____
**Status:** [ ] Pass [ ] Fail [ ] Blocked

### TC-009: The message on your real window
**Story:** 4 · **Priority:** P3
**Steps:** Over all of the above, look at the cards.

**Expected Result:** they sit at the bottom right of the window, over the toolbox. They
are readable, go away by themselves, and a click on one puts it away. Note anything that
looks wrong at your window size.

**Actual Result:** ____
**Status:** [ ] Pass [ ] Fail [ ] Blocked

## Edge Cases to Verify
| Case | Where | What to note |
|------|-------|--------------|
| A real Finder file and folder give their real paths (G-211) | TC-001, TC-002 | Nothing to note on screen. Claude reads the log |
| The panel's text, start folder, New Folder, Enter, Cancel | TC-001, TC-004, TC-005 | Any text or start folder that differs |
| Window comes to the front and takes Enter after a Finder drop | TC-002 | Where Enter went |
| Spaces and Chinese in real dropped paths | TC-002, TC-003 | The card lines as shown |
| Esc during a drag | TC-006 | Whether the overlay stayed until a click |
| The 28 px strip | TC-007 | Overlay shown? What did letting go do? |
| A browser image (file promise) | TC-008 | Whether anything was copied after all |
| Card placement and readability | TC-009 | Anything that covers the prompt or is hard to read |

## How Claude reads the result
1. The trace, from line N noted in Setup. Grep the bare word: the prefix is
   `[file-drop]`, and brackets in a grep pattern are a character class.
   ```bash
   tail -n +$N "$TMPDIR/multicode-debug.log" | grep file-drop
   ```
   Each copy writes `[file-drop] copy [<sources as JSON>] -> "<target>" (project "…") at …`
   and then a `copied "<source>" -> "<destination>"` or `failed …` line for each source.
   G-211 closes when TC-001 and TC-002 show the real sources:
   `"/private/tmp/fd-test-files/Q3 report.docx"` and
   `"/private/tmp/fd-test-files/assets folder"`. Expect five copy lines (TC-001, 002, 003,
   004, 005 step 2). Cancels, Esc (TC-006) and the browser image (TC-008) write no line,
   because a drop is traced only when a copy runs. A sixth copy line points to TC-007
   or TC-008 having copied something.
2. The disk:
   ```bash
   find "/private/tmp/fd-test project" | sort
   ```
   Expected besides `README.md`: `inbox/Q3 report.docx`, `inbox/assets folder/a.txt`,
   `inbox/assets folder/icons/logo.svg`, `inbox/Q3 report 2.docx`,
   `inbox/报告 第一版.md`, `docs/报告 第一版.md`, `docs/Q3 report.docx`, and nothing
   else. The sources in `/private/tmp/fd-test-files` are unchanged.
3. The default:
   `cat /private/tmp/fd-test-userdata/settings.json` should end with
   `"dropFolders": {"/private/tmp/fd-test project": "/private/tmp/fd-test project/docs"}`
   and still `"theme": "light"`.
4. If the builder reports a card that differs, its text can be read while it shows,
   through CDP on port 9474: `[...document.querySelectorAll(".drop-message")].map((d) => d.innerText)`.
5. Then close G-211 in `gaps.md` with the paths the log showed, and file any failed TC as
   a new task in the kanban.
