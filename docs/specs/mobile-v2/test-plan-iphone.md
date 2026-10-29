# Manual Test Plan: mobile-v2 on the builder's iPhone
**Date:** 2026-10-29 · **Tester:** Jasen (builder) · **About 60 minutes**
**Environment:** the iPhone (iOS 27, Safari and the Home Screen); the Mac running the dev
build from `workspace/app/scripts/mobile-qa/iphone-qa.sh` (userData `/tmp/mc-iphone-qa`,
phone server `127.0.0.1:6799`, real Tailscale) beside the installed Multi-Code, which
keeps port 6768 and its own data.

**Since 0.10.0 (2026-10-30):** the builder tests the installed release instead of the dev
build (it keeps port 6768 and the real userData). For it, skip 0.1 and 0.2 (use real
contacts); in 0.5 the command reads `http://127.0.0.1:6768`, and if the panel shows a
conflict left by the dev build (443 → 6799), run `tailscale serve --https=443 off` first.
Pair again (§1): the dev build's pairing doesn't carry over. Also check the 0.10.0 fixes
in §14.

This plan covers what only the iPhone can check (`qa-report-m1.md`: rows 1, 19, 39, 41,
43, 49, 60), repeats on the device the rows automation passed in WebKit (2, 3, 25, 42,
45, 52, 56, 58), and closes G-302, G-305, G-306 and the 10-minute part of G-301. Write ✓
or ✗ in the last column, and a note for every ✗ and every "Record".

Prompts to type are in `code`. qa-ask asks before any `touch` (its `ask` rule); qa-plain
asks nothing. Both run Haiku.

## 0. Set up (Mac)

| # | Do | Expect | ✓/✗ |
|---|----|--------|-----|
| 0.1 | `cd workspace/app && pnpm build`, then `scripts/mobile-qa/iphone-qa.sh` | A window with the orange DEV strip and two contacts, qa-ask and qa-plain. The terminal prints `Added qa-ask, qa-plain.` (later runs: `Contacts already there.`) | |
| 0.2 | Start qa-ask, then qa-plain. Each asks whether you trust the folder, with No selected: press ↓ then Return | Both reach Claude's prompt ("Haiku 4.5") | |
| 0.3 | Toolbox › Phone. With Tailscale stopped on the Mac: press **Open Tailscale** | The Tailscale app opens; turn it on. The Tailscale row turns ✓ "running · 100.…" within 30 s (or press Check again) | |
| 0.4 | HTTPS row says HTTPS Certificates are off: press **Open admin console** | The browser opens Tailscale's DNS page. Enable HTTPS Certificates, back to the panel, Check again | |
| 0.5 | HTTPS row now says "Not set up". Press **Set up HTTPS** | It shows `tailscale serve --bg --https=443 http://127.0.0.1:6799` and says Multi-Code never removes it, with **Run it** and Cancel. Nothing has run yet | |
| 0.6 | Press **Run it** | HTTPS ✓ `https://jasenpanmacbook-air.taile5fb0f.ts.net` and "To remove it: tailscale serve --https=443 off". Push ✓. `tailscale serve status` in a terminal shows 443 → `http://127.0.0.1:6799` | |
| 0.7 | On the iPhone: Tailscale on, same tailnet | The Mac shows in the iPhone's Tailscale list | |

## 1. Pairing, the Home Screen app, G-306

| # | Do | Expect | ✓/✗ |
|---|----|--------|-----|
| 1.1 | Mac: **Pair a phone** | A QR, Copy pairing link, New code, Done. Paired phones gains "New device · never connected" | |
| 1.2 | Mac: **New code** | A new QR. The first "New device" row is gone, one "New device" row left | |
| 1.3 | iPhone: scan the QR with the Camera, open the link | Safari: "Connected to <Mac>", step 1 ✓, step 2 next with the Share ⇪ hint, step 3's button disabled, "Only works from the Home Screen icon" | |
| 1.4 | Tap **Copy pairing link** | "Copied ✓" | |
| 1.5 | Share › Add to Home Screen | The suggested name is "Multi-Code", the icon is Multi-Code's | |
| 1.6 | Open the new icon | Full screen, no Safari bars (standalone). **Record (G-306):** (a) already paired, or (b) "Pair with your Mac" | |
| 1.7 | If (b): tap **Paste pairing link**, then iOS's Paste | "Connected to <Mac>", steps 1 and 2 ✓, step 3 next | |
| 1.8 | Long-press a text field in Notes | **Record (G-306):** the clipboard is empty now (the app cleared it) | |
| 1.9 | Also try the Mac's **Copy pairing link** (Universal Clipboard) with **Paste pairing link** on a fresh unpair (⚙ › Unpair, then paste) | It pairs. **Record** whether Universal Clipboard carried it | |
| 1.10 | Mac: the paired phone's row | Your iPhone's name, "connected · push off", Send test, Revoke | |

## 2. The list and a chat, on the device

| # | Do | Expect | ✓/✗ |
|---|----|--------|-----|
| 2.1 | Tap Sessions › | The list: qa-ask and qa-plain under IDLE, the header's dot green with the Mac's name. It shows within a second | |
| 2.2 | Open qa-plain, type `Write 40 short facts about the sea as a numbered list, then one sentence starting with "In short,". No tools.` and tap Send | Your bubble at once, then confirmed. Back on the list it goes Working, then Finished with its first sentence | |
| 2.3 | Open it again | Lands on the start of the answer, not the bottom; the header still says Finished; the list now shows it Idle | |
| 2.4 | Scroll up and down with a finger, tap a fold line in an earlier turn (if any) | Smooth; the fold opens one line per tool | |

## 3. The Home Screen app's keyboard (Story 4, G-305)

| # | Do | Expect | ✓/✗ |
|---|----|--------|-----|
| 3.1 | In qa-plain, tap the compose box | The keyboard comes up and the box sits right above it, nothing hidden behind it. Also after closing and opening the keyboard again (G-305: WebKit 322900, the first keyboard can leave the layout ~68 pt short) | |
| 3.2 | Type `line one`, Return, `line two` | Two lines in the box; nothing sent | |
| 3.3 | Switch to Chinese Pinyin, type `nihao`, press Return to commit "nihao" as letters, then pick 你好 from the candidates | The text stays in the box; Return never sends, mid-composition or not | |
| 3.4 | Add `，请用一句话回答：今天星期几？` with the IME, tap Send | Sent once; the keyboard stays up; Claude answers in Chinese | |
| 3.5 | Tap the keyboard's microphone, dictate "reply with the word dictation", tap Send | The dictated text lands in the box and is sent | |
| 3.6 | Type `draft kept` (don't send). Swipe the app away in the app switcher, open it again from the icon, open qa-plain | `draft kept` is still in the box | |

## 4. Dialogs, Stop (Stories 5 and 6)

| # | Do | Expect | ✓/✗ |
|---|----|--------|-----|
| 4.1 | qa-ask: `Run touch /tmp/mc-iphone-qa-projects/qa-ask/a.txt with Bash.` | A card replaces the compose box: NEEDS YOU · Bash command, the command, Claude's description, "Do you want to proceed?", the CLI's options (for an `ask` rule: Yes, No). No Stop | |
| 4.2 | Tap **Yes** | The card goes; the file exists (Finder or `ls`) | |
| 4.3 | Same with `b.txt`; tap **No**, type a reason in Chinese, `别建文件，回答"跳过"`, Send | Claude answers 跳过; no `b.txt` | |
| 4.4 | qa-plain: `Use AskUserQuestion to ask me two questions at once: a color (Red or Blue), and toppings (multi-select: Cheese, Ham, Olives).` | A sheet: "Claude is asking · 2 questions", page 1 radio buttons and "Type something" | |
| 4.5 | Pick Blue, Next; tick Cheese and Olives; tap Edit on the folded first answer, change to Red; Submit answers | Claude repeats Red, Cheese, Olives | |
| 4.6 | Pull the next sheet down by its handle, read the chat, pull it up again | The sheet folds to a bar and comes back | |
| 4.7 | qa-plain: open the terminal (`>_`), tap ⇧Tab until the bottom line says "plan mode on", back to the chat (☰). Send `Plan how to create hello.txt containing hi, in three steps.` | A plan sheet with the whole plan, scrollable, and the CLI's three options | |
| 4.8 | Tap **Tell Claude what to change**, type `make it say hello`, Send | A new plan comes back saying hello | |
| 4.9 | As soon as it shows, tap **Yes, auto-accept edits** | "Are you sure?" first; Yes, I'm sure: Claude writes the file (this is QA Bug 1's path: the answer must be taken however fast you tap) | |
| 4.10 | Terminal: ⇧Tab back to the normal mode. Chat: `Run sleep 60 with Bash, then say done.` | A bar: Bash sleep 60 · its time · Stop | |
| 4.11 | Tap Stop, then Stop again on "Stop this turn?" | The turn ends within a few seconds; the session stays running; no "done" | |

## 5. The terminal and its key row (Story 8, G-305)

| # | Do | Expect | ✓/✗ |
|---|----|--------|-----|
| 5.1 | qa-plain › `>_` | The real terminal at the Mac's width, "N cols · swipe ⇆"; swipe sideways to see the right side | |
| 5.2 | Tap the line at the bottom | The keyboard comes up; the key row (Esc … ^C) and the line sit right above it, also after the second and third time (G-305) | |
| 5.3 | With the keyboard up, tap ↑, ↓, Esc, Tab, ␣ | Each reaches the CLI (↑ recalls the last prompt in Claude's box); the keyboard stays up | |
| 5.4 | Type `echo hi` in the line, tap Send | It appears in Claude's input as typed, with no Return. Tap ⏎ in the key row: it sends | |
| 5.5 | Tap the terminal itself | The keyboard closes; nothing is typed | |
| 5.6 | **Record (QA Bug 2):** are the keys (32 × 36 pt) and the line (36 pt) easy to hit? | Note any mis-taps | |

## 6. Turning notifications on (Story 7, Story 10 step 3)

| # | Do | Expect | ✓/✗ |
|---|----|--------|-----|
| 6.1 | ⚙ (top right), step 3: **Turn on notifications**, Allow | "Turn off notifications" and "All set. You can leave your desk." | |
| 6.2 | Mac: the phone's row | "push on" | |
| 6.3 | Lock the phone; Mac: **Send test** | "Test sent"; "Multi-Code · Test" arrives on the lock screen; tapping it opens the app on the list | |

## 7. Opening with no connection (Story 1)

| # | Do | Expect | ✓/✗ |
|---|----|--------|-----|
| 7.1 | iPhone: Tailscale off. Swipe the app away, open it | The last list at once, and "Can't reach your Mac. Showing what it said … ago." with Retry | |
| 7.2 | In qa-plain type `offline one` and Send; send `offline two` and Cancel it | `offline one`: "⏱ Waiting to send · Cancel"; `offline two` gone | |
| 7.3 | Tailscale on again, back to the app | Within 3 s: connected; `offline one` is sent once (the Mac's terminal shows it once); a dialog card would be disabled meanwhile | |
| 7.4 | Airplane mode on, open the app | "This phone is offline." | |
| 7.5 | Airplane mode off. Mac: Tailscale off | "Can't reach your Mac." Then Tailscale on: connects by itself | |
| 7.6 | Mac: Phone link: OFF in the panel | "Your Mac is on, but Multi-Code isn't answering." (tailscale serve answers 502). Phone link: ON: connects by itself | |

## 8. Lock and unlock (Story 1)

| # | Do | Expect | ✓/✗ |
|---|----|--------|-----|
| 8.1 | App open on the list; lock for 10 s; unlock | The dot is green again within 3 s, no banner left | |
| 8.2 | Repeat 5 times, once with a 2-minute lock | Same each time. **Record** the slowest | |
| 8.3 | Switch to another app for 1 minute, come back | Same | |

## 9. G-301: 10 minutes on one socket, through `tailscale serve`

| # | Do | Expect | ✓/✗ |
|---|----|--------|-----|
| 9.1 | Settings › Display › Auto-Lock: Never. qa-plain: `Run for i in $(seq 1 600); do echo $i; sleep 1; done with Bash.` Open its terminal on the phone | Numbers stream in | |
| 9.2 | Watch for 10 minutes without touching | The numbers keep coming; the header never shows an amber dot or a banner. **Record** any drop and when | |
| 9.3 | Auto-Lock back as it was | | |

## 10. G-302: notifications with the app closed and the phone locked (Story 7)

| # | Do | Expect | ✓/✗ |
|---|----|--------|-----|
| 10.1 | Swipe the app away. Mac: in qa-plain's own box at the desk, `Reply with one sentence about rain.`; lock the phone | Within seconds: "qa-plain · Finished" with that sentence (sent though you are at the desk) | |
| 10.2 | Mac: qa-ask `Run touch /tmp/mc-iphone-qa-projects/qa-ask/c.txt with Bash.` | "qa-ask · Needs you", "Bash: touch …/c.txt". The Home Screen icon's badge: 1 | |
| 10.3 | Tap the Needs you notification | The app opens on qa-ask with its permission card | |
| 10.4 | With the app open, answer it at the desk (Yes); go Home | The badge is 0. (With the app closed it stays until the next push or the app opens: nothing is pushed when a dialog clears) | |
| 10.5 | App closed: two events on qa-plain (two short prompts at the desk, one after the other) | Only the newer notification stays for qa-plain | |
| 10.6 | App open and connected on the list, an event at the desk | No notification; the list shows the change | |
| 10.7 | App in the background (not closed), tap a notification for qa-ask | The app comes forward on qa-ask | |

## 11. Notifications off and on, permission withdrawn, re-pairing

| # | Do | Expect | ✓/✗ |
|---|----|--------|-----|
| 11.1 | ⚙ › Turn off notifications | Mac row: push off; Send test says notifications are off on this phone; events bring nothing | |
| 11.2 | Turn them on again; then Settings › Notifications › Multi-Code: off; open the app | Step 3 no longer done, the hint to allow them in Settings; Mac row: push off | |
| 11.3 | Allow them again in Settings; ⚙ › Unpair; paste a new pairing link from the Mac | Mac row: push on without tapping step 3. If not: **Record**, iOS needs a tap for `subscribe()` | |
| 11.4 | During the two-week trial | **Record** whether notifications ever stop silently, and whether opening the app brings them back | |

## 12. Revoking a phone (Story 9)

| # | Do | Expect | ✓/✗ |
|---|----|--------|-----|
| 12.1 | Mac: Revoke the iPhone (confirm) | The phone at once: "Your Mac doesn't know this phone any more." with Pair again; no more notifications | |
| 12.2 | Pair it again (1.1, then Paste pairing link in the app) | Connected; turn notifications on again (6.1) | |

## 13. Finish

| # | Do | Expect | ✓/✗ |
|---|----|--------|-----|
| 13.1 | Stop qa-ask and qa-plain, quit the DEV window | No dialog about running sessions | |
| 13.2 | Fill in gaps.md: G-301 (9.2), G-302 (§10, 11.4), G-305 (3.1, 5.2), G-306 (1.6–1.9) | | |
| 13.3 | Keep `/tmp/mc-iphone-qa` until the release; the serve stays on 6799 until then | After the release: `tailscale serve --https=443 off`, then Set up HTTPS in the released app, and pair the phone again (`scripts/mobile-qa/README.md`, "After the release") | |

## 14. The fixes found on the iPhone (0.10.0)

| # | Do | Expect | ✓/✗ |
|---|----|--------|-----|
| 14.1 | Let a session finish while the phone is on the list; check its red dot on the Mac, then open it on the phone | The Mac's red dot goes out within a second (G-321) | |
| 14.2 | Keep the phone on a session and send it a message; let it finish | No red dot lights on the Mac for it; the Mac still chimes | |
| 14.3 | In a short chat, tap the compose box; close and open the keyboard 2–3 times | The messages sit right above the box, the header stays (G-324); note any ~68 pt gap | |
| 14.4 | Send `/token` | The bubble becomes the grey line "/token · Unknown command: /token" (G-323) | |
| 14.5 | Send `/cost` | A grey line that folds after three lines; tap opens it | |
| 14.6 | Send `/new`, then a message | The old chat goes, "New session" at the top, a "/clear" line; the message is answered normally (G-322) | |
