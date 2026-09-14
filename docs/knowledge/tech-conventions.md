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
