# Multi-Code

A desktop application for managing multiple Claude Code CLI instances from a single interface. Think of it as a terminal multiplexer with a classic QQ (early-2000s chat app) aesthetic — each Claude Code session appears as a "contact" in a sidebar, with full terminal fidelity and notification support.

## Why

When working with multiple Claude Code sessions across different projects simultaneously, you run into context contamination and missed notifications. Multi-Code solves this by giving each session its own isolated terminal view while providing unified notification management.

## Features

### Core
- **Instance Management** — Spawn, restart, and remove Claude Code sessions per project directory
- **Full Terminal Fidelity** — Real PTY via node-pty, rendered in xterm.js. No chat abstraction, no message parsing
- **Session Notifications** — Monitors Claude's session JSONL files; plays audio, flashes the contact, and bounces the macOS Dock when an agent finishes responding
- **Persistence** — Instance list saved to disk, survives app restart
- **Three-Column Layout** — Contact list | terminal | toolbox, with a draggable splitter between terminal and toolbox

### Toolbox (per-instance utility panel)
- **Git section** — Current branch, file counts (new / modified / staged), remote ahead/behind, clickable file list (opens file in VS Code). Polls every 5s while the section is expanded
- **Quick Actions** — One-click buttons for common operations:
  - **Go to Code Base** — Open the project in VS Code
  - **Show Cost / Clear / Compact** — Auto-type `/cost`, `/clear`, `/compact` into the terminal
  - **Resume Elsewhere** — Copy `claude --resume <session-id>` to clipboard for handoff to IDE-integrated Claude Code
- **Terminal section** — Embedded real shell (your default `$SHELL`) running in the project's directory. Persists in background across collapses and instance switches

### Visual / UX
- **QQ Aesthetic** — Aqua-blue gradients, compact avatars, familiar sidebar layout
- **Dock Bounce** — macOS Dock icon bounces when an agent finishes while the app is in the background

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Desktop | Electron 35 |
| Language | TypeScript (strict, ES2024, ESM) |
| Frontend | React 19 |
| Terminal | xterm.js 5.5 + FitAddon |
| PTY | node-pty 1.0 |
| Bundler | rspack 1.3 |
| Lint | oxlint + eslint |
| Test | vitest |
| Package Manager | pnpm (workspace monorepo) |

## Project Structure

```
multi-code/
├── workspace/
│   └── app/
│       ├── src/
│       │   ├── main/           # Electron main process
│       │   │   ├── index.ts          # Entry point, window creation, dock icon
│       │   │   ├── process-manager.ts # Spawns & manages claude CLI processes
│       │   │   ├── shell-manager.ts  # Spawns & manages shell PTYs (toolbox Terminal)
│       │   │   ├── session-watcher.ts # Monitors session JSONL for end_turn
│       │   │   ├── git-status.ts     # Git status reader (used by toolbox)
│       │   │   ├── ipc-handlers.ts    # IPC endpoint registration
│       │   │   ├── preload.ts         # Context bridge (electronAPI)
│       │   │   └── store.ts           # Persistent storage (~/.config/Multi-Code/)
│       │   ├── renderer/       # React UI
│       │   │   ├── App.tsx
│       │   │   ├── components/       # ContactList, TerminalView, Toolbox + sections, etc.
│       │   │   ├── hooks/            # useNotifications
│       │   │   ├── audio/            # Web Audio notification sounds
│       │   │   ├── assets/           # Icons (gaming.png), sound files
│       │   │   └── styles/           # Global CSS (QQ theme)
│       │   └── shared/         # Shared TypeScript types
│       ├── package.json
│       └── rspack.renderer.config.ts
├── docs/                       # Business docs, specs, knowledge base
├── package.json                # Root workspace config
├── pnpm-workspace.yaml
└── tsconfig.json
```

## Installing the .dmg (end users)

> Apple Silicon Macs only (M1/M2/M3/M4). Intel Macs are not supported.

You will receive a `Multi-Code-0.1.0-arm64.dmg` file directly (e.g. via Slack/Drive/AirDrop). Follow the steps below.

### Prerequisite: Claude Code CLI

Install the Claude Code CLI **before** launching Multi-Code:

```bash
curl -fsSL https://claude.ai/install.sh | sh
```

Verify it works:

```bash
claude --version
```

If that prints a version number, you're good.

### Step 1 — Install the app

1. Double-click the `Multi-Code-0.1.0-arm64.dmg` file you received
2. In the disk window that opens, drag the **Multi-Code** icon into the **Applications** folder
3. Eject the mounted disk (right-click → Eject, or drag it to the Trash)

### Step 2 — Clear the quarantine flag (required, do once)

This app is not signed with an Apple Developer certificate, so macOS Gatekeeper will block it from running by default. Run this command once in Terminal to remove the quarantine flag:

```bash
xattr -cr /Applications/Multi-Code.app
```

### Step 3 — Launch

Open Multi-Code from Launchpad or the Applications folder. From now on, double-click works as normal — you don't need to repeat Step 2.

### Troubleshooting

**"Multi-Code can't be opened" / nothing happens on double-click**
You skipped Step 2. Run the `xattr` command above and try again.

**Created an instance but the chat window says OFFLINE**
The `claude` CLI isn't on your PATH. Verify with `claude --version`. If that fails, reinstall the Claude Code CLI (see Prerequisite above).

**Upgrading to a new version**
Drag the new `Multi-Code.app` into Applications (replace the old one), then run `xattr -cr /Applications/Multi-Code.app` again before launching.

---

## Development (run from source)

### Prerequisites

- Node.js >= 20
- pnpm >= 9
- Claude Code CLI installed and available in PATH (`claude`)

### Install & Run

```bash
pnpm install
pnpm start
```

### Scripts

```bash
pnpm start        # Build and launch the app
pnpm build        # Build renderer + main process
pnpm lint         # Run oxlint + eslint
pnpm lint:fix     # Auto-fix lint issues
pnpm type         # Type check without emit
pnpm test         # Run vitest
pnpm pack         # Package app (directory output)
pnpm dist         # Build distributable (dmg on macOS)
```

## 使用说明

Multi-Code 的核心定位是**轻量级 agent 调度中心**:你可以并行管理多个 Claude Code 会话,统一观察、批量发指令。需要边看代码边深度调改时,可以一键移交给 IDE 里的 Claude Code(VS Code 等)。

### 创建新实例

1. 点击左侧 sidebar 底部的 **"+ New"** 按钮
2. 选择项目目录(必须是绝对路径)
3. 可选:填写一个 alias(联系人显示名)
4. 点 Create —— 应用自动 spawn `claude` CLI 在该目录;首次进入若该目录还没历史 session,会启动新会话,否则用 `--continue` 续上

### 主界面布局(三栏)

```
┌──────────────┬─────────────────────┬─────────────────────┐
│ Contact List │ Terminal (claude)   │ Toolbox             │
│              │                     │  ▾ Git              │
│  + New       │                     │  ▸ Quick Actions    │
│              │                     │  ▸ Terminal         │
└──────────────┴─────────────────────┴─────────────────────┘
```

- **左**:实例列表。绿色头像 = running,灰色 = stopped。右键菜单可 Restart / Remove。停止的实例右侧有 ▶ 按钮启动
- **中**:claude 主聊天框(真终端)。底色白底 Aqua 风,适配深背景下的 ANSI diff 块
- **右**:工具箱,手风琴式 —— 同时只能展开一个 section,展开的撑满纵向。Git 默认展开
- **中右之间**:有一条**可拖动分栏**,左右调整聊天框 / 工具箱宽度。两侧最小 280px

### Toolbox 三个 section 详解

#### Git
- 显示当前 branch、文件变更计数、远端 ahead/behind
- 列出每一个变更的文件,**点击文件名直接在 VS Code 里打开它**
- 文件超过 20 个时只显示提示,不渲染列表
- 严格 cwd 检查:只看 cwd 自己的 `.git`,不向父目录搜索 —— 子目录不会显示父仓库状态

#### Quick Actions
| 按钮 | 行为 |
|------|------|
| Go to Code Base | `code <cwd>` —— 用 VS Code 打开项目;已经开着会激活已有窗口 |
| Show Cost | 在主聊天框敲 `/cost` |
| Clear | 在主聊天框敲 `/clear` |
| Compact | 在主聊天框敲 `/compact` |
| Resume Elsewhere | 复制 `claude --resume <session-id>` 到剪贴板 |

#### Terminal
- 真实 shell PTY(用 `$SHELL`),黑底白字,跟 Terminal.app 一样
- 在当前实例的项目目录下打开
- 第一次展开时才创建,之后**后台保活** —— 你切到别的实例 / 折叠 section,这里跑的进程不会停
- 可以放心跑 `vim`、`pnpm test`、`git commit` 等任何命令

### 通知行为

- Agent 完成回应(`end_turn`)→ 响一次"滴滴"提示音
- 头像闪烁 + 红点徽标
- macOS Dock 图标弹跳(`critical` 模式,持续到你切回 app)
- 当前选中的实例:闪烁 1.5 秒后自动消失(假定你已在看)
- 其他实例:闪烁直到你点进去

### 离线状态

- 已停止的实例显示灰色头像
- 选中已停止的实例:聊天框中央显示大号 **OFFLINE** 字样
- 工具箱所有 section 强制折叠,不可展开
- 想恢复:点联系人右侧 ▶ 按钮重启 claude

### Resume 到 IDE 的工作流

当某个 session 进入"需要边看代码边改"的深度模式:

1. 工具箱 → Quick Actions → 点 **Resume Elsewhere** —— 命令已复制
2. 在 VS Code 里打开终端(或开 iTerm/Terminal.app),`cd` 到项目根
3. 粘贴回车 → claude 在带 IDE 的环境里继续这个 session
4. Multi-Code 这边可以保持运行,也可以关掉

### 数据持久化

- 实例列表(目录 + alias)保存在 `~/.config/Multi-Code/contacts.json`
- App 重启后自动恢复联系人列表(状态都是 stopped,需手动启动)
- Session 内容由 Claude Code 自己管(`~/.claude/`),Multi-Code 不存任何对话内容

## How It Works

1. User creates an instance by selecting a project directory
2. App spawns `claude` (or `claude --continue` if a session exists) via node-pty in that directory
3. PTY stdout is piped in real-time to an xterm.js terminal in the renderer
4. SessionWatcher polls the Claude session JSONL file for `end_turn` events to detect completion
5. On completion: audio + flash + Dock bounce. The selected instance auto-clears unread state after 1.5s
6. Toolbox sections each manage their own lifecycle:
   - Git: shells out to `git` every 5s while expanded
   - Terminal: lazy-spawns a shell PTY on first expand, persists across collapses
7. Instances persist to `~/.config/Multi-Code/contacts.json`

## License

Private / Internal use.
