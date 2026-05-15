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
