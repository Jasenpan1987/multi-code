# PRD: Phone Link

**Version:** 1.0
**Last Updated:** 2026-07-26
**Status:** implemented (v1)
**Owner:** Jasen

## Overview

Let the builder watch and steer running agents from a phone, so that being away
from the desk stops being a reason for an agent to sit idle. The desktop app
becomes the server: it listens on port 6768, serves a mobile web client, and
carries an end-to-end encrypted stream of terminal output and structured prompts
to any paired phone.

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

### Story 4: Remote answering

**As a** builder asked an open question
**I want to** type the answer on my phone
**So that** I can reply in full sentences, not just pick from a list

**Acceptance Criteria:**
- [x] Free-text answers send as bracketed paste + separate `\r`, the same
      mechanism the desktop compose box uses (multi-line text doesn't submit early)
- [x] A raw terminal view is always available as a fallback

### Story 5: Pairing and revocation

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
┌───────────────────────────────┐               ┌──────────────────────┐
│ process-manager               │               │ transport.ts         │
│   pty.onData ──┐              │               │   races endpoints    │
│                ├─► outputBuffer (256 KB tail) │   pins host key      │
│                └─► remoteServer.broadcast     │   reconnect backoff  │
│                                               │                      │
│ backends/claude.ts                            │ App.tsx              │
│   JSONL watcher                               │   prompt buttons     │
│   └─► extractPromptDetail() ──► prompt-state  │   answer box         │
│                                               │   TerminalPane       │
│ remote/ws-server.ts                           │     (xterm.js)       │
│   http :6768 ─── serves mobile bundle ────────┼──► index.html        │
│   WebSocket ──── NaCl box sealed frames ──────┼──► sealed frames     │
└───────────────────────────────┘               └──────────────────────┘
```

**Protocol** (`src/shared/remote-protocol.ts`, version 2). Plaintext hello
exchange establishes the shared key, then every frame is a sealed envelope
(base64 nonce + ciphertext) wrapping JSON. Client frames: `auth`,
`list-instances`, `subscribe`, `unsubscribe`, `input`, `prompt`, `choose`,
`ping`. Server frames: `auth-ok`, `auth-failed`, `instances`, `snapshot`,
`output`, `activity`, `exit`, `prompt-state`, `prompt-cleared`, `pong`, `error`.

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
   from the session JSONL, which the CLI writes for itself). *Answering* assumes
   option boxes accept number keys — a UI convention, not an API. A CLI release
   could break the buttons while viewing keeps working; the raw terminal view is
   the deliberate fallback. See `promptExtract.ts`. Related risk already recorded
   in memory (`project_prompt_detection`).
2. **Snapshot is a byte tail, not an emulated screen.** Replaying the tail into a
   fresh xterm reconstructs the visible state because the TUI repaints often. The
   first bytes may be a truncated escape sequence; xterm resyncs on the next one.
3. **Off-LAN requires Tailscale on both devices.** Without it, pairing is
   LAN-only. The UI says so rather than failing silently at the worst moment.
4. **OpenCode prompts have no structured options.** Its detector reports
   activity, not prompt payloads, so OpenCode instances fall back to the terminal
   view and the free-text box.
5. **No push notifications.** A PWA can vibrate while open; it can't wake a
   locked phone. That needs a native shell (and, for iOS, a push server — which
   would reintroduce a server).

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
| Prompt decoding | `src/main/remote/promptExtract.ts` |
| Desktop UI | `src/renderer/components/PhoneSection.tsx` |
| Mobile client | `src/renderer-mobile/` |
| Mobile bundle config | `rspack.mobile.config.ts` |
