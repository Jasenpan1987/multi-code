# Tech Conventions

Reference project: `apra-amcos-admin-msk`

## Code Style & Toolchain

| Aspect | Choice | Notes |
|--------|--------|-------|
| Language | TypeScript (strict) | target es2024, ESM |
| Package manager | pnpm + workspace | monorepo structure |
| Lint | oxlint + eslint | oxlint for fast checks, eslint for fine-grained rules |
| Type checking | tsgo | TypeScript native preview |
| Testing | vitest | with @testing-library |
| Bundler | rspack | faster alternative to webpack |
| Module type | ESM | `"type": "module"` |

## Desktop Application Framework

- Electron (confirmed)
- Frontend: React + UI library (TBD, reference project uses MUI)
- UI aesthetic: Classic QQ (early 2000s) — compact, information-dense, no modern bloat

## Project Structure (Expected)

```
multi-code/
├── workspace/
│   ├── app/          # Electron main process + renderer
│   └── shared/       # Shared types and utilities
├── package.json      # root workspace
├── pnpm-workspace.yaml
└── tsconfig.json     # root tsconfig
```

## Multi-Backend Pattern (added 2026-05-18)

When new logic needs different behavior per backend (claude / opencode), prefer this pattern:

```
src/main/backends/
  ├── types.ts          # Backend interface (spawn args, hook installer, resume cmd builder)
  ├── claude.ts         # Implementation for claude
  ├── opencode.ts       # Implementation for opencode
  └── index.ts          # Registry / factory
```

Anywhere in the codebase that needs backend-specific behavior, look up the backend by name and call the abstraction — never hardcode `if (backend === "claude") ... else ...` branches scattered across files. Adding a new backend should mean:

1. Drop a new file under `backends/`
2. Register it in the index
3. Add the visual treatment (new avatar shape) and the dialog option

If the abstraction starts feeling forced, fix the abstraction — don't put a third backend hack into a corner.

(source: 2026-05-18 opencode-support ideation)

## Verifying UI changes without a human (added 2026-09-15)

`osascript` cannot drive this app. `click at {x,y}` fails with
`AppleEvent timed out (-1712)` because Electron's web content doesn't accept synthetic
System Events clicks, and the accessibility tree stops at a `group`.

Use CDP instead — it clicks reliably and, more importantly, lets a change be *inspected*
rather than eyeballed:

```bash
cd workspace/app && npx electron . --remote-debugging-port=9333   # 9222 is often Chrome's
curl -s http://127.0.0.1:9333/json                                # → webSocketDebuggerUrl
```

Then `Runtime.evaluate` over that socket (`ws` is already a dependency). React's event
delegation responds to a native `click()`, so:

```js
[...document.querySelectorAll(".contact-item")]
  .find(el => el.querySelector(".contact-name")?.textContent === "portals-be")
  ?.querySelector(".start-btn").click()
```

Two related facts that make self-verification practical:

- **The dev app and a packaged build use different userData directories** (`multi-code`
  vs `Multi-Code`), so both can run at once without fighting over `contacts.json`. They
  do share port 6768; that's handled and only disables phone link. Kill the dev one with
  `pkill -f "node_modules/electron"`, which cannot match `/Applications/Multi-Code.app`.
- **Compiled main-process modules with no electron import can be required directly** from
  a plain node script — `dist/main/run-state.js`, `dist/main/backends/claude.js` — and
  paired with `node_modules/node-pty` to drive a real CLI. `backends/index.js` and
  `opencode.js` cannot: they pull in `better-sqlite3`, built for Electron's ABI.

(source: 2026-09-15, verifying the manager agent's dispatch path)

Three additions from the same day, each after the naive approach cost real time:

- **To exercise a first-run path, launch an isolated instance**:
  `electron . --remote-debugging-port=9444 --user-data-dir=/tmp/mc-test`. Electron makes
  `app.getPath("userData")` follow that flag, so it comes up with no contacts and no
  manager directory — which is the only clean way to test "+ Manager" or a trust dialog.
  The alternative was tried first: moving the user's real `manager/CLAUDE.md` aside, with
  the backup in `/tmp`. They then rebooted, and `/tmp` is cleared on reboot.
- **A CDP helper must check `exceptionDetails`.** Reading only `result.result.value`
  returns `undefined` for an expression that threw, so a probe that never ran looks like a
  finding about the app. Also don't pass the expression through `execSync` +
  `JSON.stringify` — the shell mangles the newlines. Write it to a file, or hold one
  persistent websocket.
- **Read terminal contents from `.xterm-rows`' `innerText`**, not `.xterm-screen`'s
  `textContent`. The latter includes the `<style>` block xterm injects, which is thousands
  of characters of CSS before any output.

## Tests must not read the real HOME (added 2026-09-15)

Two tests were found reading the developer's own files through a default parameter, which
makes them pass or fail depending on whose machine runs them:

- `contextUsage.test.ts` picked up the real `~/.claude/settings.json` once
  `readClaudeContextUsage` gained a `settingsPath` default, and started asserting against
  whatever model that machine had configured. Fixed by pinning every call to a path that
  cannot exist.
- `process-manager.write-gate.test.ts` wrote `contacts.json` **into the repo**: `store.ts`
  computes `STORE_PATH` at *import* time, when the mocked `app.getPath("userData")` is
  still `""`, so `path.join` yields a relative path. Fixed by mocking `./store`.

So: when a reader gains a config-path parameter, give every existing test an explicit
unreachable path in the same commit, and mock `./store` in any test that imports
process-manager.

## Manager guidance is versioned by content hash (added 2026-09-15)

`manager-workspace.ts` keeps the sha256 of every version of the manager's `CLAUDE.md` it
has ever seeded, in `SEEDED_HASHES`. A file matching one of them is ours and gets
rewritten; anything else is the user's edit and is never touched.

**Changing `GUIDANCE` means adding the outgoing hash to that array in the same commit.**
Otherwise existing installs stop being recognised and stop being upgraded — which is the
bug this replaced: the file was seeded once at T-209 listing only the two read tools, and
weeks later, with the write tools shipped, the manager was still reading it and telling
the user to go and run things themselves. The v1 bytes are checked in at
`main/__fixtures__/manager-guidance-v1.md` so the upgrade path is tested against a real
previous version.

## The write-safety gate is not the place to fix a timing bug (added 2026-09-15)

When a write to a session gets refused, check the caller's timing before touching
`run-state.ts`. Measured: the manager called `start_session` and `send_task` in the same
turn (the model issues them in parallel), the dispatch landed two seconds into the CLI's
startup and was swallowed, and the gate then correctly refused the retry because nothing
had reacted. The gate was right; the caller was writing at a moment when writes get lost.
The fix belonged in the tool — wait for the target to settle — and loosening the silence
guard to make that case pass would have removed the only protection against a write
landing on a dialog.
