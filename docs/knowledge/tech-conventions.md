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
