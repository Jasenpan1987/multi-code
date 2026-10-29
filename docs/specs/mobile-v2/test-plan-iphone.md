# Mobile v2 — iPhone test plan (draft)

**Status:** draft from T-811 and T-805; T-813 completes it with every PRD criterion that only
the iPhone can check.
**Needs:** iOS 18.4 or later; Tailscale on the Mac and the iPhone; the Mac's Phone panel with
all three checks green (the builder pressed "Set up HTTPS").

## G-306: does a Safari pairing reach the Home Screen app?

1. Scan the QR with Camera. Safari shows "Connected to <Mac>", step 2 is next, step 3's
   button is disabled.
2. Tap **Copy pairing link**. It changes to "Copied ✓".
3. Share › Add to Home Screen, then open the new icon. Record: (a) already paired, or
   (b) "Pair with your Mac".
4. If (b): tap **Paste pairing link**, then iOS's Paste bubble. It ends on "Connected to
   <Mac>" with steps 1 and 2 done.
5. Long-press a text field in Notes. Record whether the clipboard is empty now.
6. Also try the Mac's own **Copy pairing link** (Universal Clipboard).

## G-302: does Web Push reach the iPhone, closed and locked?

1. In the Home Screen app, tap **Turn on notifications** and allow. Expect "Turn off
   notifications" and "All set"; the Mac's Phone panel shows push on.
2. Lock the phone; press **Send test** on the Mac. "Multi-Code · Test" arrives; tapping it
   opens the list.
3. Close the app (or leave it silent for more than 20 s). Let one session finish and another
   hit a permission dialog. Expect "<name> · Finished" with the first sentence, and
   "<name> · Needs you" with "Bash: …". The icon badge equals the Needs-you count. Tapping
   the Needs-you one opens that session.
4. Two events on one session leave only the newest notification.
5. With the app open and connected, no push arrives. Answer a Needs you at the desk, go
   Home: the badge has dropped.
6. Tap a notification while the app is in the background: it comes forward on that session.
7. ⚙ › Turn off notifications: the Phone panel shows push off, Send test says off, events
   bring no pushes.
8. Turn them on again, then turn Multi-Code off in Settings › Notifications. On opening the
   app, step 3 is no longer done and the Settings hint shows; the Phone panel shows push
   off.
9. Allow notifications again, ⚙ › Unpair, paste a new pairing link from the Mac. The Phone
   panel shows push on without tapping step 3. If not, iOS needs a tap for `subscribe()` and
   the connect-time re-subscribe can't work.
10. During the trial: record whether notifications ever stop silently, and whether opening
    the app restores them.

## G-301: the WebSocket through `tailscale serve`, as the real app

Measured with a probe on 2026-10-29 (stable). Repeat with the Home Screen app: a session
streaming output, Auto-Lock off, 10 minutes in the foreground with no reconnect; then
lock/unlock cycles, each reconnecting within 3 s.

## G-305: keyboard

In the Home Screen app: the compose box and the terminal's key row stay above the keyboard
after the first keyboard; tapping a key in the key row doesn't close the keyboard; Chinese
IME Return never sends; dictation works in the compose box.
