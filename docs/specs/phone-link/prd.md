# PRD: Phone Link

**Version:** 1.1
**Last Updated:** 2026-07-29
**Status:** implemented (v1.1)
**Owner:** Jasen

## Overview

Let the builder watch and steer running agents from a phone, so that being away
from the desk stops being a reason for an agent to sit idle. The desktop app
becomes the server: it listens on port 6768, serves a mobile web client, and
carries an end-to-end encrypted stream of the conversation and structured prompts
to any paired phone.

**v1.1** addresses the gap that made v1 unusable in practice: an OpenCode agent
blocked on a permission dialog reached the phone as a blank terminal, with no
buttons and no badge, so it looked like the agent was still working. Three causes,
all fixed — OpenCode never reported prompts at all, the option keystrokes were
Claude's and did nothing on OpenCode, and the terminal mirror was unreadable on a
phone regardless of what it contained.

No intermediary server is involved in any configuration. Off-LAN reach comes
from Tailscale, which gives both machines a routable address without any
third-party relay in the data path.

## Background & Context

Modelled on **github.com/stablyai/orca**, which solves the same problem. Its
architecture (researched 2026-07-21):

| Concern | Orca's approach |
|---------|-----------------|
| Transport | Electron main process runs a WebSocket server on port 6768, framed JSON-RPC |
| Direct path | Phone dials `ws://<desktop-ip>:6768`; Tailscale (`100.64/10`, `*.ts.net`) counts as direct |
| Off-LAN | Falls back to a first-party cloud relay (`relay.onorca.dev` assigns a "cell"; both ends connect out and the cell splices them) |
| Pairing | QR encoding `orca://pair?code=<base64url JSON>` carrying endpoint, per-device token, and the desktop's Curve25519 public key (pinned by the phone) |
| Encryption | `tweetnacl` NaCl box (Curve25519 + XSalsa20-Poly1305), end-to-end — the relay only sees ciphertext |
| Terminal data | Binary sub-protocol (16-byte header, `streamId`/`seq`, Output/Snapshot/Resize opcodes) multiplexed over the same socket |
| Phone client | React Native + xterm.js in a WebView |
| Not used | No WebRTC, no STUN/TURN, no ngrok/Cloudflare tunnel |

**Where we deliberately diverge.** The builder's requirement was explicitly "no
intermediary server". Orca's off-LAN path is a relay, so copying it wholesale
would violate the requirement. Two devices behind separate NATs cannot find each
other unaided — there is no way around that without either a server or a
routable address. We chose the routable-address route (Tailscale), which keeps
the promise literally: no server, ours or anyone's, in the data path.

Decision recorded 2026-07-26: **Tailscale direct + PWA**, chosen over port
forwarding + DDNS (needs router changes, dead behind carrier NAT) and a
self-hosted relay VPS (still a server to maintain). A relay remains possible
later — the protocol's endpoint list is already a race over candidates, so a
relay is an extra candidate rather than a redesign.

## Users & Stakeholders

| Role | Who | How they interact |
|------|-----|-------------------|
| Builder | Jasen | Leaves agents running at home; checks and unblocks them from a phone |

## User Stories

### Story 1: Serverless direct connection

**As a** builder away from my desk
**I want** my phone to reach my desktop without any intermediary server
**So that** my code and conversations never transit someone else's machine

**Acceptance Criteria:**
- [x] Desktop listens on port 6768 (configurable, `0` = OS-assigned)
- [x] Pairing offer carries every candidate address, Tailscale ordered first
- [x] Phone races all candidates and keeps the first that completes a handshake
- [x] Link-local (`169.254/16`) and loopback addresses are excluded as unreachable
- [x] Desktop UI warns when no Tailscale address exists (pairing will be LAN-only)
- [x] Server is OFF by default — it opens a network port, so it is opt-in

### Story 2: Live state sync

**As a** builder holding my phone
**I want to** see what the agent is doing right now
**So that** I don't have to walk back to the desk to check

**Acceptance Criteria:**
- [x] Terminal output streams to subscribed phones as it arrives
- [x] A phone connecting mid-session receives a snapshot of the current screen
      (256 KB tail per instance) rather than a blank terminal
- [x] Instance list pushes on create/start/restart/remove/rename/exit
- [x] Activity events ("turn ended", "blocked on a question") reach the phone and
      vibrate it

### Story 3: Remote decisions

**As a** builder whose agent is asking a four-option question
**I want to** tap the answer on my phone
**So that** the agent isn't blocked until I get home

**Acceptance Criteria:**
- [x] The blocking tool is decoded into a question plus options and sent to the phone
- [x] `AskUserQuestion` options are read from the session JSONL, with the CLI's
      implicit "Other" entry appended so indices line up with the screen
- [x] Permission prompts (Bash/Write/Edit/...) render Yes / Yes-don't-ask / No
- [x] `ExitPlanMode` renders the plan-approval choices
- [x] Tapping option N writes the corresponding keystroke to the PTY
- [x] A stale or out-of-range choice is refused with a message, never guessed at
- [x] Prompts clear on the phone when answered from either side
- [x] Keystrokes are resolved by the backend that owns the instance, because the
      CLIs disagree: Claude's boxes take the option's number, OpenCode's ignore
      digits and navigate with arrows (v1.1)
- [x] OpenCode permission dialogs ("Allow once / Allow always / Reject") reach the
      phone as buttons (v1.1)
- [x] OpenCode `question` boxes reach the phone with their real options, read from
      its sqlite db (v1.1)
- [x] Multi-select questions are shown but not tappable, because one tap can't
      express the CLI's toggle-then-confirm flow (v1.1)
- [x] Session discovery compares resolved paths, so an instance under a symlinked
      cwd isn't left without any detection at all (v1.1)

### Story 4: Remote answering

**As a** builder asked an open question
**I want to** type the answer on my phone
**So that** I can reply in full sentences, not just pick from a list

**Acceptance Criteria:**
- [x] Free-text answers send as bracketed paste + separate `\r`, the same
      mechanism the desktop compose box uses (multi-line text doesn't submit early)
- [x] A raw terminal view is always available as a fallback

### Story 5: Knowing what the agent is doing (v1.1)

**As a** builder glancing at my phone
**I want to** read what the agent is doing in plain text
**So that** "away from the desk" doesn't mean "blind"

The v1 detail screen led with the terminal mirror, which turned out to be
unreadable on a phone for reasons that can't be styled away: the PTY is a fixed
120 columns and the CLIs paint absolutely-positioned cells, so there is nothing
to reflow onto a 390px screen. It read as a black rectangle.

**Acceptance Criteria:**
- [x] The detail screen leads with a reflowable transcript, read from the CLI's own
      structured record (Claude's session JSONL, OpenCode's sqlite) rather than
      from terminal paint
- [x] Assistant and user prose wraps; tool calls are one scannable line each
- [x] The tool the agent is currently on is visually distinct
- [x] The transcript stays visible while a prompt is up, because deciding whether
      to allow something depends on what led to it
- [x] The transcript refreshes while the agent is working, throttled to one read
      per second and only for instances someone is actually watching
- [x] The terminal remains available, collapsed, as the fallback
- [x] The terminal's 256-color palette is set explicitly: OpenCode paints dialogs
      with near-black backgrounds (232-238) and dim `fg 8`, which against xterm's
      default palette rendered as invisible text on a phone

### Story 6: Pairing and revocation

**As a** builder
**I want** pairing to be a QR scan, and un-pairing to be immediate
**So that** a lost phone isn't a standing hole in my machine

**Acceptance Criteria:**
- [x] Desktop shows a QR; phone scans it and is connected, no app install
- [x] Phone pins the desktop's public key from the QR — an impostor at the same
      address fails the check
- [x] Each pairing mints its own revocable token
- [x] Revoking disconnects that device immediately and refuses its token after
- [x] Revoking one device leaves others connected

## Architecture

```
Desktop (Electron main)                         Phone (browser / PWA)
┌────────────────────────────────┐              ┌──────────────────────┐
│ process-manager                │              │ transport.ts         │
│   pty.onData ──┬───────────────┼──────────────┤   races endpoints    │
│                ├─► outputBuffer (256 KB tail) │   pins host key      │
│                ├─► detector.onPtyData()       │   reconnect backoff  │
│                └─► remoteServer.broadcast     │                      │
│                                               │ App.tsx              │
│ backends/claude.ts        (JSONL)             │   prompt buttons     │
│   unpaired tool_use + PTY idle ──┐            │   Transcript  ◄──────┼── default
│   readTranscript() ──────────────┤            │   answer box         │
│                                  │            │   TerminalPane       │
│ backends/opencode.ts      (sqlite + screen)   │     (xterm.js) ◄─────┼── fallback
│   running tool part ─────────────┤            │                      │
│   permission dialog text ────────┤            │                      │
│   readTranscript() ──────────────┤            │                      │
│                                  ▼            │                      │
│                        prompt-state           │                      │
│                        transcript             │                      │
│ remote/ws-server.ts                           │                      │
│   http :6768 ─── serves mobile bundle ────────┼──► index.html        │
│   WebSocket ──── NaCl box sealed frames ──────┼──► sealed frames     │
└────────────────────────────────┘              └──────────────────────┘
```

**Protocol** (`src/shared/remote-protocol.ts`, version 2). Plaintext hello
exchange establishes the shared key, then every frame is a sealed envelope
(base64 nonce + ciphertext) wrapping JSON. Client frames: `auth`,
`list-instances`, `subscribe`, `unsubscribe`, `input`, `prompt`, `choose`,
`ping`. Server frames: `auth-ok`, `auth-failed`, `instances`, `snapshot`,
`output`, `activity`, `exit`, `prompt-state`, `prompt-cleared`, `transcript`,
`pong`, `error`.

**Why prompt detection differs per backend.** Claude writes a session JSONL, so a
blocking prompt is structured data: an unpaired `tool_use` plus a quiet PTY.
Neither half of that transfers to OpenCode. It keeps a spinner running the whole
time it blocks (measured: longest gap between writes over a 31s dialog was
295ms), so "PTY idle" never happens; and its permission requests are never
persisted. Hence two detectors rather than one shared abstraction.

**Why JSON rather than Orca's binary terminal frames.** Orca multiplexes many
terminal panes over one socket, so it needs `streamId` framing. A phone shows one
instance at a time, so `instanceId` on a JSON frame is sufficient and far less
code. If multi-pane mirroring is ever wanted, that's when binary framing earns
its complexity.

**Security posture.** Access is gated by a per-device bearer token plus the NaCl
seal; the bind address is `0.0.0.0` because being reachable is the point.
Specifically:

- Desktop identity keypair persisted at `remote-identity.json`, mode 0600
- Device tokens at `remote-devices.json`, mode 0600 (bearer credentials granting
  terminal access)
- Token comparison is constant-time
- Sockets that don't authenticate within 10s are dropped
- A post-handshake frame that isn't a valid sealed envelope closes the socket
  rather than being answered, so a wrong-key peer can't probe
- Static file serving is contained to the mobile bundle dir; traversal is rejected
- No TLS: React Native / mobile Safari can't pin a self-signed cert, so
  confidentiality comes from the seal instead. Same reasoning as Orca.

## Known Limitations

1. **Answering depends on CLI key handling.** Reading prompts is stable (parsed
   from each CLI's own structured record). *Answering* depends on how its option
   boxes handle keys, which is a UI convention, not an API. The bindings were
   verified by driving real processes, and they differ per CLI: Claude takes the
   option's number; OpenCode ignores digits and uses arrows, with permission rows
   navigating left/right and question lists up/down. A CLI release could break the
   buttons while viewing keeps working; the terminal view is the deliberate
   fallback. See `promptExtract.ts` and `opencodePrompt.ts`. Related risk recorded
   in memory (`project_prompt_detection`).
2. **OpenCode permission dialogs are scraped from the terminal.** Unlike its
   `question` tool, a pending permission request is not persisted anywhere — the
   `permission` table holds only granted rules, and the live request exists only in
   the process's memory. So the heading and option row are matched as text. The
   fragility is contained: if the wording changes, permission detection goes quiet
   (no false prompts) while `question` detection is unaffected. The alternative,
   driving OpenCode's HTTP/SSE server, would mean changing how the process is
   launched.
3. **The permission latch relies on the db to clear.** OpenCode paints the option
   row exactly once and never repaints it, and teardown emits no clear sequence, so
   the terminal alone can neither refresh nor retract the signal. The latch is
   therefore set from the terminal and cleared when the blocked tool leaves
   `running` in the db.
4. **Multi-select questions can't be answered from the phone.** A `question` with
   `multiple: true` is a two-stage interaction: options are checkboxes that Enter
   toggles, and submitting means Tab to a separate Confirm step. Tapping one option
   can't express that, and sending the single-select keystrokes would tick a box
   and leave the agent blocked while the phone showed the prompt as answered. These
   are shown read-only with a note; the free-text box and terminal both still work.
   Implementing them properly means a multi-tap UI plus a confirm action.
5. **Snapshot is a byte tail, not an emulated screen.** Replaying the tail into a
   fresh xterm reconstructs the visible state because the TUI repaints often. The
   first bytes may be a truncated escape sequence; xterm resyncs on the next one.
6. **Off-LAN requires Tailscale on both devices.** Without it, pairing is
   LAN-only. The UI says so rather than failing silently at the worst moment.
7. **No push notifications.** A PWA can vibrate while open; it can't wake a
   locked phone. This is the largest remaining gap: an agent that blocks while the
   phone is locked still goes unnoticed until the app is opened. On iOS, Web Push
   needs a secure context, so it would mean serving https (`tailscale cert` can
   issue a real cert for a `*.ts.net` name, so this is possible without a server).

## Out of Scope (v1)

- Cloud relay fallback (protocol leaves room; see Background)
- Native iOS/Android app and push notifications
- Creating or killing instances from the phone (view + answer only)
- Multi-instance terminal mirroring in one view
- Image attachments from the phone

## Files

| Area | Path |
|------|------|
| Wire protocol | `src/shared/remote-protocol.ts` |
| Server | `src/main/remote/ws-server.ts` |
| Lifecycle wiring | `src/main/remote/index.ts` |
| Crypto + identity | `src/main/remote/crypto.ts` |
| Device store | `src/main/remote/device-store.ts` |
| Endpoint discovery | `src/main/remote/endpoints.ts` |
| Snapshot buffer | `src/main/remote/output-buffer.ts` |
| Prompt decoding (Claude) | `src/main/remote/promptExtract.ts` |
| Prompt decoding (OpenCode) | `src/main/backends/opencodePrompt.ts` |
| Transcript readers | `src/main/backends/claude.ts`, `src/main/backends/opencode.ts` |
| Symlink-safe cwd matching | `src/main/backends/resolvePath.ts` |
| Captured dialog fixture | `src/main/backends/__fixtures__/opencode-permission.txt` |
| Desktop UI | `src/renderer/components/PhoneSection.tsx` |
| Mobile client | `src/renderer-mobile/` |
| Mobile bundle config | `rspack.mobile.config.ts` |
