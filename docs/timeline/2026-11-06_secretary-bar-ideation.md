# Secretary Bar — ideation

**Date:** 2026-11-06
**Type:** ideation
**Participants:** Jasen (builder), Claude
**Source:** (verbal), four questions answered in session
**Outcome:** new epic `docs/specs/secretary-bar/` (first named `mobile-secretary`)

## The ask

"我想把小秘书功能放到手机上": put the secretary on the phone.

The mobile-v2 PRD left the secretary to phase 2 (G-316). On 2026-10-28 the builder said the
secretary's reporting comes first on the Mac and the phone after it
(`project-secretary-v2` memory). This is that phase.

## What exists today

- **Desktop secretary** (`docs/specs/voice-secretary/prd.md` v2.1): while Secretary Mode is
  on, each Finished or Needs-you event gets a brief written by `claude -p`, and audio when a
  speech server is set (Qwen3-TTS or Cloudflare MeloTTS since 0.10.6). The card shows the
  text, plays it, and on a Needs-you takes replies in words (`secretary/index.ts`, `reply`).
  Attachments (voice-secretary M3, T-512/T-513) are not built.
- **Phone app** (`docs/specs/mobile-v2/prd.md` v1.1, 0.10.0): list, chat, dialogs answered
  with buttons, Stop, Web Push. It shows no briefs. Dialogs are already answered through the
  secretary's key flows (`secretary/dialog.ts`) and OpenCode's API.
- **Push** goes out once the list line is read (`remote/remote-host.ts`, `pushEvent`), within
  5 s of the event. The brief's text is normally ready within 10 s, possibly later on Opus
  (decisions.md, 2026-11-04).

## iOS facts given to the builder

- A Web Push notification can't carry its own sound; it plays the system sound only.
- A web page needs a tap before it can play audio.
- Whether audio keeps playing once the phone locks has not been measured.

## Key decisions

- **Tap to listen.** Open a session (from the push or the list), the secretary's card is
  there, tap to play. One brief at a time. A "listening mode" that plays new briefs one after
  another while the app is open was offered and not chosen. — builder
- **One switch: the desktop's Secretary Mode.** The phone can turn it on and off. A phone-only
  switch that always writes briefs while a phone is paired was offered and not chosen. —
  builder
- **With the secretary on, the push waits for the brief** and its body is the brief's first
  sentence. If the brief fails, the push goes out with today's body. Keeping today's push
  unchanged was offered and not chosen. — builder
- **Replies in words on the phone, buttons kept.** The phone card gets the desktop card's
  reply box, with the same rules. Buttons-only was offered and not chosen. — builder

## At PRD review

- **The card is a bar under the session header**: the brief's first sentence and Play,
  tapped open for the full text, Replay, Stop, exchanges and the reply box. A card inline in
  the chat, under the last turn, was offered and not chosen. — builder
- **Nothing plays without a tap**, the open session included. The desktop's "the session on
  screen speaks by itself" was offered for the phone and not chosen. — builder

## The redesign, the same day

After reading the PRD in chat on the phone, the builder approved it ("就先这么做吧……你赶紧做吧")
and changed its shape:

> 我其实现在希望的是，整个 UI 里只有一个小助手（就是语音小秘书），不想像现在这样放在每个 session 里头，
> 包括电脑端我觉得也挺不好的。……电脑和手机上都能打开，打开以后小秘书就在整个 App 最顶上占一块位置，
> 一直显示它的状态和说的话。这样我就不用来回来去切每一个项目了。上面就显示一个，比如"<project> 项目小秘书"，
> 然后有个 play button，我一点它就播报内容、告诉我该做什么。

- **One secretary, in a bar at the top of the app, on the desktop and the phone.** It shows
  one brief at a time, named by its session, with its state and its text, and Play. The
  desktop's per-session card and header button go. — builder
- **Decided in session, to review:** the bar takes waiting briefs as a queue (Needs you
  first, oldest first, ‹ › to move); it moves on silently when one is dealt with; a Finished
  brief played to the end, or dismissed with "Got it", counts as reading its session; tapping
  the title opens the session; nothing plays without a tap on the desktop either.

## A bug found the same day

The builder answered a two-question box from this session on the phone; it hung, then showed
an error, and the terminal showed no question answered. Reproduced on 2.1.318 with the driver
in `.omt/probes/voice-secretary/t509`: a single-select question whose options carry a
`preview` is drawn beside a preview pane and ignores digits, so the phone's three "1"s left
the box on its first question. ↓ and Enter answer it (a single preview question submits at
once, recorded `{"Which layout?": "C"}`); a plain question in the same box still takes its
digit and the review page still takes "1". Fixed in `secretary/dialog.ts` (commit dd4692b).
