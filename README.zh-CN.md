# Multi-Code

> [English](./README.md)

一个桌面应用,用单一界面管理多个终端型编码 agent 会话。支持两种后端:**Claude Code** 和 **OpenCode**,而且可以混着用。本质上是一个带 QQ 经典皮肤的终端多路复用器(QQ 是 2000 年代初的中文聊天软件),每个 agent 会话作为侧边栏里的"联系人"出现,保留完整的终端能力和通知。

**零残留:** Multi-Code 直接 spawn 真实的 `claude` / `opencode` CLI,从不往它们的配置或 session 目录里写东西。卸载这个 app 不会在 `~/.claude/`、`~/.config/opencode/` 或你的项目里留下任何痕迹,它只保存自己那份很小的联系人列表(见[数据持久化](#数据持久化))。

## 为什么做这个

当你同时跑多个编码 agent 会话(不同项目),会遇到 context 串扰和漏看回复的问题。Multi-Code 给每个会话独立的终端视图,并提供统一的通知管理,不管这个会话是 Claude Code 还是 OpenCode。

## 功能

### 核心
- **多后端** — 每个实例跑 **Claude Code** 或 **OpenCode**。创建实例时选后端,可以任意混用,甚至同一个项目目录里两个都开
- **实例管理** — 按项目目录 spawn / restart / remove agent 会话
- **完整终端能力** — 用 node-pty 接真 PTY,xterm.js 渲染。不做 chat 抽象,不解析消息
- **会话通知** — 检测 agent 完成一轮回复(Claude 读它的 session JSONL,OpenCode 读它的 session 数据库),播放声音、闪烁联系人、macOS Dock 弹跳
- **持久化** — 实例列表(含每个实例的后端)存盘,重启后恢复
- **三栏布局** — 联系人列表 | 终端 | 工具箱,终端和工具箱之间有可拖拽分栏

### 工具箱(每实例独立的工具面板)
- **Git section** — 当前 branch、文件计数(new / modified / staged)、远端 ahead/behind、可点击的文件列表(点击在 VS Code 里打开)。展开时每 5 秒轮询
- **Quick Actions** — 一键操作按钮:
  - **Go to Code Base** — 在 VS Code 里打开项目
  - **Show Cost / Clear / Compact** — 自动往终端敲 `/cost`、`/clear`、`/compact`(OpenCode 没有内联的 cost 命令,Show Cost 对它禁用)
  - **Resume Elsewhere** — 复制该后端的续接命令到剪贴板,方便交接给独立终端(`claude --resume <id>` 或 `opencode --session <id>`)
- **Terminal section** — 嵌入式真实 shell(用你的默认 `$SHELL`),在项目目录下运行。后台保活,折叠或切实例都不杀进程
- **View section** — 内联渲染 Markdown 文件:粘贴一个 `.md` 路径(或点终端输出里的 `.md` 路径,或点 Git section 里某个变更 `.md` 旁边的 View 入口)。支持 GitHub 风格 Markdown、数学公式(KaTeX)、Mermaid 图、本地和远程图片

### 视觉 / UX
- **QQ 美学** — Aqua 蓝渐变,紧凑头像,熟悉的侧边栏布局
- **一眼区分后端** — Claude Code 实例是**圆形**头像,OpenCode 实例是**圆角方形**头像
- **Dock 弹跳** — agent 完成而 app 不在前台时,macOS Dock 图标会弹跳

## 技术栈

| 层 | 技术 |
|----|------|
| Desktop | Electron 35 |
| 语言 | TypeScript(strict、ES2024、ESM) |
| 前端 | React 19 |
| 终端 | xterm.js 5.5 + FitAddon |
| PTY | node-pty 1.0 |
| 打包 | rspack 1.3 |
| Lint | oxlint + eslint |
| 测试 | vitest |
| 包管理 | pnpm(workspace monorepo) |

## 项目结构

```
multi-code/
├── workspace/
│   └── app/
│       ├── src/
│       │   ├── main/           # Electron 主进程
│       │   │   ├── index.ts          # 入口、窗口创建、dock 图标、mdimg:// 协议
│       │   │   ├── process-manager.ts # spawn 和管理 agent CLI 进程(后端无关)
│       │   │   ├── backends/          # 后端抽象:claude.ts、opencode.ts、注册表
│       │   │   ├── shell-manager.ts  # spawn 和管理 shell PTY(工具箱 Terminal)
│       │   │   ├── git-status.ts     # Git 状态读取(工具箱用)
│       │   │   ├── ipc-handlers.ts    # IPC 端点注册
│       │   │   ├── preload.ts         # context bridge(electronAPI)
│       │   │   └── store.ts           # 持久化(~/.config/Multi-Code/)
│       │   ├── renderer/       # React UI
│       │   │   ├── App.tsx
│       │   │   ├── components/       # ContactList、TerminalView、Toolbox + sections 等
│       │   │   ├── hooks/            # useNotifications
│       │   │   ├── audio/            # Web Audio 通知音
│       │   │   ├── assets/           # 图标(gaming.png)、声音文件
│       │   │   └── styles/           # 全局 CSS(QQ 主题)
│       │   └── shared/         # 共享 TypeScript 类型
│       ├── package.json
│       └── rspack.renderer.config.ts
├── docs/                       # 业务文档、规格、knowledge base
├── package.json                # 根 workspace 配置
├── pnpm-workspace.yaml
└── tsconfig.json
```

## 安装 .dmg(给最终用户)

> 仅支持 Apple Silicon Mac(M1 / M2 / M3 / M4)。Intel Mac 暂不支持。

你会直接收到一个 `Multi-Code-0.1.0-arm64.dmg` 文件(比如通过 Slack / Drive / AirDrop)。按下面步骤来。

### 前置依赖:后端 CLI

Multi-Code 驱动的是真实的 agent CLI,启动前**至少装一个**后端。只需要装你实际会用的后端,如果只用其中一个,另一个不装也行。

**Claude Code CLI**(用于 Claude Code 实例):

```bash
curl -fsSL https://claude.ai/install.sh | sh
claude --version   # 验证
```

**OpenCode CLI**(可选,只在要开 OpenCode 实例时需要):

```bash
curl -fsSL https://opencode.ai/install | bash
opencode --version   # 验证
```

对应命令能输出版本号就 OK。如果在 app 里选了某个后端但它的 CLI 没装,那个实例创建后会直接显示 OFFLINE。

### 第 1 步 — 安装 app

1. 双击你拿到的 `Multi-Code-0.1.0-arm64.dmg` 文件
2. 在弹出的磁盘窗口里,把 **Multi-Code** 图标拖到 **Applications** 文件夹
3. 弹出挂载的磁盘(右键 → 推出,或拖到废纸篓)

### 第 2 步 — 清除隔离标记(必做,只做一次)

这个 app 没有用 Apple Developer 证书签名,默认情况下 macOS Gatekeeper 会拒绝运行。在终端里跑这一行命令清掉隔离标记:

```bash
xattr -cr /Applications/Multi-Code.app
```

### 第 3 步 — 启动

从 Launchpad 或 Applications 文件夹双击打开 Multi-Code。**第 2 步只需做一次**,以后双击直接开。

### 常见问题

**双击没反应 / 弹窗"无法打开"**
没做第 2 步。去终端跑那行 `xattr` 命令,然后再试。

**创建实例后聊天框一直显示 OFFLINE**
对应后端的 CLI 不在 PATH 里。Claude Code 实例用 `claude --version` 验证,OpenCode 实例用 `opencode --version` 验证,不通就回到顶部重装对应的 CLI。

**升级到新版**
把新的 `Multi-Code.app` 拖到 Applications(覆盖旧的),然后**再跑一次** `xattr -cr /Applications/Multi-Code.app`,然后启动。

---

## 开发(从源码运行)

### 前置依赖

- Node.js >= 20
- pnpm >= 9
- PATH 里至少有一个后端 CLI:Claude Code(`claude`)和/或 OpenCode(`opencode`)

### 安装并运行

```bash
pnpm install
pnpm start
```

### 脚本

```bash
pnpm start        # 构建并启动 app
pnpm build        # 构建 renderer + main 进程
pnpm lint         # 跑 oxlint + eslint
pnpm lint:fix     # 自动修复 lint 问题
pnpm type         # 类型检查(不输出)
pnpm test         # 跑 vitest
pnpm pack         # 打包 app(目录形式)
pnpm dist         # 打可分发包(macOS 上是 dmg)
```

## 使用说明

Multi-Code 的核心定位是**轻量级 agent 调度中心**:你可以并行管理多个 Claude Code / OpenCode 会话,统一观察、批量发指令。需要边看代码边深度调改时,可以一键移交给 IDE 里或独立终端里的 agent。

### 创建新实例

1. 点击左侧 sidebar 底部的 **"+ New"** 按钮
2. 选一个**后端**:**Claude Code** 或 **OpenCode**。选择器默认是你上次用的那个。如果选了 OpenCode 但它的 CLI 不在 PATH 里,会出一条内联提示(仍然可以创建)
3. 选择项目目录(必须是绝对路径)
4. 可选:填写一个 alias(联系人显示名)
5. 点 Create,应用自动 spawn 选中的 CLI 在该目录(`claude` 或 `opencode`),有历史 session 就续上。实例头像**圆形是 Claude Code,圆角方形是 OpenCode**

> 同一个目录可以同时开一个 Claude Code 实例和一个 OpenCode 实例,互不干扰。同一目录里再创建**相同**后端的实例,还是会像以前那样给你警告。

### 主界面布局(三栏)

```
┌──────────────┬─────────────────────┬─────────────────────┐
│ Contact List │ Terminal (agent)    │ Toolbox             │
│              │                     │  ▾ Git              │
│  + New       │                     │  ▸ Quick Actions    │
│              │                     │  ▸ Terminal         │
│              │                     │  ▸ View             │
└──────────────┴─────────────────────┴─────────────────────┘
```

- **左**:实例列表。绿色头像 = running,灰色 = stopped。右键菜单可 Restart / Remove。停止的实例右侧有 ▶ 按钮启动
- **中**:agent 主聊天框(真终端,Claude Code 或 OpenCode 的 TUI)。底色白底 Aqua 风,适配深背景下的 ANSI diff 块
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
| Go to Code Base | `code <cwd>`,用 VS Code 打开项目;已经开着会激活已有窗口 |
| Show Cost | 在主聊天框敲 `/cost`。**OpenCode 下禁用**(没有内联 cost 命令),带说明 tooltip |
| Clear | 在主聊天框敲 `/clear` |
| Compact | 在主聊天框敲 `/compact` |
| Resume Elsewhere | 复制该后端的续接命令(`claude --resume <session-id>` 或 `opencode --session <session-id>`)到剪贴板 |

#### View
- 在工具箱这一栏内联渲染 Markdown 文件
- 三种打开方式:在输入框粘贴路径回车、**点终端输出里的 `.md` 路径**、点 Git section 里某个变更 `.md` 旁边的 **View** 入口
- 支持 GitHub 风格 Markdown、数学公式(`$…$` / `$$…$$`,走 KaTeX)、Mermaid 图、图片(本地图片相对文件解析,远程 `https://` 图片直接加载)
- 只支持 `.md` / `.markdown`,上限 2 MB,其他类型显示一条纯文本提示。Markdown 里的原始 HTML 不会被执行

#### Terminal
- 真实 shell PTY(用 `$SHELL`),黑底白字,跟 Terminal.app 一样
- 在当前实例的项目目录下打开
- 第一次展开时才创建,之后**后台保活** —— 你切到别的实例 / 折叠 section,这里跑的进程不会停
- 可以放心跑 `vim`、`pnpm test`、`git commit` 等任何命令

### 通知行为

两种后端的通知行为完全一致,只是检测来源不同(Claude Code 读 session JSONL,OpenCode 读 session 数据库)。

- Agent 完成一轮回应 → 响一次"滴滴"提示音
- 头像闪烁 + 红点徽标
- macOS Dock 图标弹跳(`critical` 模式,持续到你切回 app)
- 当前选中的实例:闪烁 1.5 秒后自动消失(假定你已在看)
- 其他实例:闪烁直到你点进去

### 离线状态

- 已停止的实例显示灰色头像
- 选中已停止的实例:聊天框中央显示大号 **OFFLINE** 字样
- 工具箱所有 section 强制折叠,不可展开
- 想恢复:点联系人右侧 ▶ 按钮重启它的后端 CLI

### Resume 到 IDE 的工作流

当某个 session 进入"需要边看代码边改"的深度模式:

1. 工具箱 → Quick Actions → 点 **Resume Elsewhere**,该后端的续接命令已复制(`claude --resume <id>` 或 `opencode --session <id>`)
2. 在 VS Code 里打开终端(或开 iTerm/Terminal.app),`cd` 到项目根
3. 粘贴回车,agent 在那个环境里继续这个 session
4. Multi-Code 这边可以保持运行,也可以关掉

### 数据持久化

- 实例列表(目录 + alias + 后端)保存在 `~/.config/Multi-Code/contacts.json`
- App 重启后自动恢复联系人列表(状态都是 stopped,需手动启动)
- Session 内容由后端 CLI 自己管(Claude Code 在 `~/.claude/`,OpenCode 在 `~/.local/share/opencode/`),Multi-Code 不存任何对话内容,也从不往这些目录里写

## 工作原理

1. 用户选一个项目目录和后端(Claude Code / OpenCode)创建实例
2. App 通过 node-pty 在该目录 spawn 对应后端 CLI(`claude` / `opencode`,有历史 session 就续上)。后端在 `src/main/backends/` 的一个小 `Backend` 接口后面可插拔
3. PTY stdout 实时管道到 renderer 里的 xterm.js 终端
4. 按后端各自的完成检测器监听一轮结束,Claude 读它的 session JSONL,OpenCode 读它的 session 数据库,都是只读,不回写任何东西
5. 完成时:声音 + 闪烁 + Dock 弹跳。当前选中的实例 1.5 秒后自动 mark read
6. 工具箱 sections 各自管理生命周期:
   - Git:展开期间每 5s 调用 `git`
   - Terminal:第一次展开时 lazy-spawn 一个 shell PTY,之后保活
7. 实例信息持久化到 `~/.config/Multi-Code/contacts.json`

## 许可

私有 / 内部使用。
