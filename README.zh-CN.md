# Multi-Code

> [English](./README.md)

一个桌面应用,用单一界面管理多个终端型编码 agent 会话。支持两种后端:**Claude Code** 和 **OpenCode**,而且可以混着用。每个 agent 会话在侧边栏里占一行,保留完整的终端能力和通知。

**零残留:** Multi-Code 直接 spawn 真实的 `claude` / `opencode` CLI,从不往它们的配置或 session 目录里写东西。卸载这个 app 不会在 `~/.claude/`、`~/.config/opencode/` 或你的项目里留下任何痕迹,它只在自己的数据目录里存几个小文件(见[数据持久化](#数据持久化))。

## 为什么做这个

当你同时跑多个编码 agent 会话(不同项目),会遇到 context 串扰和漏看回复的问题。Multi-Code 给每个会话独立的终端视图,并提供统一的通知管理,不管这个会话是 Claude Code 还是 OpenCode。终端多到看不过来的时候,还可以让一个 **Manager** agent 替你盯着、替你派活(见[Manager Agent](#manager-agent-1))。人离开屏幕的时候,还有一个**秘书**把每个会话做了什么、在问什么念给你听,你用大白话回答它就行(见[语音秘书](#语音秘书-1))。

## 功能

### 核心
- **多后端** — 每个实例跑 **Claude Code** 或 **OpenCode**。创建实例时选后端,可以任意混用,甚至同一个项目目录里两个都开
- **实例管理** — 按项目目录 spawn / restart / remove agent 会话
- **完整终端能力** — 用 node-pty 接真 PTY,xterm.js 渲染。不做 chat 抽象,不解析消息
- **会话通知** — 知道 agent 什么时候做完、什么时候在等你(Claude 通过 Multi-Code 启动时传给它的 hooks 自己上报,OpenCode 通过 Multi-Code 给它加载的插件上报),播放声音、闪烁联系人、macOS Dock 弹跳
- **Context 用量一眼可见** — 每一行联系人都显示这个会话的 context 窗口用了百分之多少,并按用量上色。鼠标悬停能看到精确 token 数、模型和统计时间。窗口大小确定不了的时候只显示 token 数,不瞎猜百分比。已停止的会话也显示最后一次的用量
- **跟得上 `/clear` 和 `/new`** — 运行中的 CLI 切到新 session 时,Multi-Code 会跟过去,context 用量、通知和 Manager 看到的都是当前那个 session
- **持久化** — 实例列表(含每个实例的后端)存盘,重启后恢复
- **拖拽排序** — 在侧边栏上下拖动联系人,顺序会保存,重启后还在
- **消息编辑框** — `Cmd+L` 在终端上唤起一个编辑框:多行输入、鼠标编辑、`Enter` 发送 / `Shift+Enter` 换行,还能粘贴图片(带缩略图预览)一起发出去。适合折叠 TUI 输入框里写不方便的长消息。两种后端都能用
- **左右对照 diff** — 在 Git section 里打开任意变更文件的 diff 窗口,可以拖动、可以缩放。选中几行点 **Ask agent**,就会把 `@path:start-end` 引用塞进编辑框
- **三栏布局** — 联系人列表 | 终端 | 工具箱,终端和工具箱之间有可拖拽分栏

### Manager Agent
- **只跟一个 agent 说话** — 点 **+ Manager** 创建一个 Claude Code 实例,它的活就是管你其他的会话。想知道哪个项目进展如何,或者想派活出去,跟它说就行,不用自己挨个切终端
- **读进度不打扰** — 它直接读别的会话的 transcript,对方不花 token,也不占一轮对话。已停止的会话也能读
- **能派活,而且安全** — 它可以启动已停止的会话、发任务、执行白名单里的 slash 命令(`/clear`、`/new`、`/compact`、`/context`、`/handoff`),还能等某个会话空闲下来。有一道写入安全闸:会话正卡在权限确认框上时,拒绝往里打字,Manager 不会替你误批准什么
- **跨后端** — OpenCode 会话和 Claude Code 会话它都能派活
- **一举一动都看得见** — 它的每次调用,包括被拒绝的、以及它自己的 Bash/Edit/Write,都实时显示在工具箱的 **Manager** section 里
- **只在本机** — 它的工具由一个绑在 `127.0.0.1` 上的 MCP server 提供,bearer token 放在权限 `0600` 的文件里,从不出现在命令行上

### 工具箱(每实例独立的工具面板)
- **Git section** — 当前 branch、文件计数(new / modified / staged)、远端 ahead/behind,以及文件列表。每一行有 **View**(左右对照 diff)、**Go To**(在 VS Code 里打开),Markdown 文件还有 **MD**(预览)。改名的文件按改名显示。展开时每 5 秒轮询
- **Quick Actions** — 一键操作按钮:
  - **Go to Code Base** — 在 VS Code 里打开项目
  - **Show Cost / Clear / Compact** — 自动往终端敲 `/cost`、`/clear`、`/compact`(OpenCode 没有内联的 cost 命令,Show Cost 对它禁用)
  - **Resume Elsewhere** — 复制该后端的续接命令到剪贴板,方便交接给独立终端(`claude --resume <id>` 或 `opencode tui --session <id>`)
  - **Rename Session** — 给当前会话起个名字,走各后端自己的 `/rename`
- **Terminal section** — 嵌入式真实 shell(用你的默认 `$SHELL`),在项目目录下运行。后台保活,折叠或切实例都不杀进程
- **View section** — 内联渲染 Markdown 文件:粘贴一个 `.md` 路径(或点终端输出里的 `.md` 路径,或点 Git section 里某个变更 `.md` 旁边的 MD 标签)。支持 GitHub 风格 Markdown、数学公式(KaTeX)、Mermaid 图、本地和远程图片
- **Phone section** — 配对手机,在手机上看和操作 agent(见下面的[手机互联](#手机互联))
- **Secretary section** — 秘书模式开关和语音服务器设置(见下面的[语音秘书](#语音秘书-1))
- **Manager section** — Manager agent 每一次调用的实时记录,最新的在上面,点一下能看完整参数和结果

### 手机互联
- **不经过中间服务器** — 手机直连你的电脑,数据不经过任何第三方,包括我们
- **出门也能用** — 装了 [Tailscale](https://tailscale.com) 之后,人在外面手机照样是直连电脑。在家同一个 WiFi 下什么都不用配
- **不用装 App** — 电脑端直接把手机网页发给你,扫码即用,加到主屏幕就跟 App 一样
- **实时同步** — 终端输出实时推过来;中途才打开手机也会先收到当前屏幕的快照,不是一片空白
- **点一下就回答** — Agent 弹选项时,选项在手机上渲染成按钮,点一下 agent 就继续跑
- **也能打字回答** — 开放式问题用输入框回,发送机制跟电脑端 `Cmd+L` 那个框一样
- **端到端加密** — NaCl box(Curve25519 + XSalsa20-Poly1305)。配对时手机会 pin 住电脑的公钥,同一个地址上的冒充者过不了这一关
- **可吊销** — 每台配对的手机有自己的 token,吊销一台立刻断开,不影响别的

### 语音秘书
- **是汇报,不是念屏幕** — 会话做完或需要你的时候,秘书用自己的话把事情讲一遍:你让它干什么、它干了什么、成没成。遇到确认框,先讲这个操作是干什么的、为什么要做,再问你
- **不用看屏幕也能听** — 打开秘书模式后,屏幕上正显示的那个会话一有消息就自己播报。别的会话要等你点它的红点才播,所以两个会话不会同时说话
- **用话回答** — 确认框的卡片上有自己的回复框。打字或语音输入"可以""不行,改成 X""以后都可以",秘书替你按对的选项。拿不准你的意思就反问你,什么都不按
- **跟你的语言走** — 每条汇报跟着你在那个会话里最近一句话的语言:英文就用英文,中文就用中文,英文技术名词原样保留
- **语音可选** — 声音来自你配置的语音服务器。没配,或者服务器挂了,卡片上照样显示文字,其他功能不受影响
- **两种后端都有** — Claude Code 和 OpenCode 的会话都有秘书

### 视觉 / 体验
- **紧凑布局** — 侧边栏排得密、头像小、蓝色渐变外框,一屏能放下很多会话
- **主题** — 亮色、暗色、护眼(sepia)三种,右上角切换
- **一眼区分后端** — Claude Code 实例是**圆形**头像、蓝色窗口外框;OpenCode 实例是**圆角方形**头像、绿色外框。标题栏也会写明是哪个后端
- **Manager 置顶** — Manager 那一行永远在列表最上面,样式跟项目区分开
- **长名字气泡** — 名字太长显示不下时,鼠标悬停会在那一行旁边弹出气泡,显示完整名字
- **面板可收起** — 面板边上的小箭头可以把会话列表、终端或工具箱收成一条细边,点那条细边就展开回来。收起终端后工具箱会占满窗口,适合整屏读 Markdown
- **版本号** — 窗口右上角(主题切换按钮旁)显示当前构建版本号,随时能看到跑的是哪一版。开发版会多一个 **DEV** 标签,标题栏还有琥珀色条纹,不会跟安装版搞混
- **Mac 习惯的快捷键** — 在 agent 终端里,`Cmd+Backspace` 清空输入行,`Cmd+Left` / `Cmd+Right` 跳到行首 / 行尾。`Cmd+R` 被禁用,不会误刷新窗口
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
│       │   │   ├── run-state.ts       # 写入安全闸(每个实例的 idle / busy / blocked)
│       │   │   ├── manager-mcp/       # 给 Manager agent 用的本地 MCP server 和工具
│       │   │   ├── manager-workspace.ts # 初始化 Manager 自己的目录和 guidance
│       │   │   ├── remote/            # 手机互联:WebSocket server、加密、已配对设备
│       │   │   ├── secretary/         # 语音秘书:写汇报、语音客户端、理解回复
│       │   │   ├── shell-manager.ts  # spawn 和管理 shell PTY(工具箱 Terminal)
│       │   │   ├── git-status.ts     # Git 状态读取(工具箱用)
│       │   │   ├── git-diff.ts       # 把文件 diff 读成新旧对齐的行
│       │   │   ├── ipc-handlers.ts    # IPC 端点注册
│       │   │   ├── preload.ts         # context bridge(electronAPI)
│       │   │   ├── settings-store.ts  # settings.json(主题、手机互联、秘书)和语音密钥
│       │   │   └── store.ts           # contacts.json(在 Electron 的 userData 目录里)
│       │   ├── renderer/       # React UI
│       │   │   ├── App.tsx
│       │   │   ├── components/       # ContactList、TerminalView、Toolbox + sections、DiffWindow 等
│       │   │   ├── hooks/            # useNotifications、useTheme
│       │   │   ├── audio/            # Web Audio 通知音
│       │   │   ├── assets/           # 图标(gaming.png)、声音文件
│       │   │   └── styles/           # 全局 CSS
│       │   ├── renderer-mobile/ # 手机互联的网页客户端(发给手机用)
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

你会直接收到一个 `Multi-Code-0.1.0-arm64.dmg` 文件(比如通过 Slack / Drive / AirDrop)。按下面步骤来。文件名里的 `0.1.0` 只是举例,你拿到的是哪个版本就是哪个。

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
│  + Manager   │                     │  ▸ Terminal         │
│              │                     │  ▸ View             │
│              │                     │  ▸ Phone            │
│              │                     │  ▸ Secretary        │
│              │                     │  ▸ Manager          │
└──────────────┴─────────────────────┴─────────────────────┘
```

- **左**:实例列表。绿色头像 = running,灰色 = stopped。每一行显示 context 用量。可以拖动排序(Manager 固定在最上面)。右键菜单可 Restart / Remove。停止的实例右侧有 ▶ 按钮启动
- **中**:agent 主聊天框(真终端,Claude Code 或 OpenCode 的 TUI)。底色白底 Aqua 风,适配深背景下的 ANSI diff 块
- **右**:工具箱,手风琴式 —— 同时只能展开一个 section,展开的撑满纵向。Git 默认展开
- **中右之间**:有一条**可拖动分栏**,左右调整聊天框 / 工具箱宽度。两侧最小 280px

### 消息编辑框(Compose Box)

TUI 自带的输入框是折叠的,写长消息、多行内容或要贴图时不方便。用编辑框代替:

1. 在终端里按 **`Cmd+L`** 唤起编辑框(任何运行中的实例都行,Claude Code 或 OpenCode;已停止的实例无效)
2. 随便打字,**`Enter` 发送**,**`Shift+Enter` 换行**,**`Esc` 取消**
3. 想附图就直接 **粘贴图片**(比如截图),会出现一个缩略图 chip;发送时图片作为 `@<路径>` 附件一起发给 claude
4. 切换实例会丢弃草稿(每个实例的草稿独立)

### Toolbox 各 section 详解

#### Git
- 显示当前 branch、文件变更计数、远端 ahead/behind
- 列出每一个变更的文件,行尾有几个标签:
  - **View**:打开这个文件的左右对照 diff(见下面的 [Diff 窗口](#diff-窗口))
  - **Go To**:在 VS Code 里打开并定位文件。先打开/聚焦这个项目的窗口,项目没开时会自动把整个 repo 窗口拉起来(而不是把单文件塞进当前最前面的窗口)
  - **MD**:`.md` / `.markdown` 文件才有,点它在下方 View section 内联预览
- 改名的文件显示新名字,diff 也按改名来算,不会当成一个全新文件
- 文件超过 20 个时只显示提示,不渲染列表
- 严格 cwd 检查:只看 cwd 自己的 `.git`,不向父目录搜索,子目录不会显示父仓库状态

#### Quick Actions
| 按钮 | 行为 |
|------|------|
| Go to Code Base | `code <cwd>`,用 VS Code 打开项目;已经开着会激活已有窗口 |
| Show Cost | 在主聊天框敲 `/cost`。**OpenCode 下禁用**(没有内联 cost 命令),带说明 tooltip |
| Clear | 在主聊天框敲 `/clear` |
| Compact | 在主聊天框敲 `/compact` |
| Resume Elsewhere | 复制该后端的续接命令(`claude --resume <session-id>` 或 `opencode tui --session <session-id>`)到剪贴板 |
| Rename Session | 弹框输入名字,通过该后端自己的 `/rename` 给会话改名 |

#### View
- 在工具箱这一栏内联渲染 Markdown 文件
- 三种打开方式:在输入框粘贴路径回车、**点终端输出里的 `.md` 路径**、点 Git section 里某个变更 `.md` 旁边的 **MD** 标签
- 支持 GitHub 风格 Markdown、数学公式(`$…$` / `$$…$$`,走 KaTeX)、Mermaid 图、图片(本地图片相对文件解析,远程 `https://` 图片直接加载)
- 只支持 `.md` / `.markdown`,上限 2 MB,其他类型显示一条纯文本提示。Markdown 里的原始 HTML 不会被执行

#### Terminal
- 真实 shell PTY(用 `$SHELL`),黑底白字,跟 Terminal.app 一样
- 在当前实例的项目目录下打开
- 第一次展开时才创建,之后**后台保活** —— 你切到别的实例 / 折叠 section,这里跑的进程不会停
- 可以放心跑 `vim`、`pnpm test`、`git commit` 等任何命令

#### Manager
- Manager agent 每一次调用的实时记录,最新的在上面
- 每条显示目标会话和一行预览,点开能看完整参数和结果
- 调用一开始就会出现,所以一个很久的 `wait_for_idle` 在跑的时候也看得见
- 被拒绝的调用也会列出来,带着原因。Manager 自己的 Bash / Edit / Write 调用带一个 **own** 标记

### Diff 窗口

在 Git section 某一行点 **View**,打开这个文件的 diff。

- 左边旧版本,右边新版本,逐行对齐,显示整个文件的上下文。滚一下两边一起动
- 它是个窗口,不是弹框:拖标题栏移动,拖右下角缩放,app 其他地方照常能点。再打开另一个文件会复用同一个窗口、同一个位置。`Esc` 关闭
- **选中几行**:点一行,shift 点扩展,或者拖动选一段。会有一条提示栏显示这段选区对应的引用(`@path:start-end`)
- **Ask agent**:把这个引用追加到编辑框里并打开编辑框,光标停在引用后面,接着打你的问题就行。问两处就会攒下两个引用
- 从 diff 里复制文字只复制代码,不带行号
- diff 显示不了的时候会告诉你原因:二进制文件、太大、找不到、没有改动、或者 git 出错。特别长的文件截到 5000 行,并给出提示

### Manager Agent

Manager 是一个 Claude Code agent,你只跟它说话,不用自己挨个跟每个会话说。

**设置:**

1. 点侧边栏底部的 **+ Manager**。它会在 Multi-Code 数据目录里建一个自己的文件夹来跑,建好之后这个按钮就消失了
2. 第一次启动时,Claude Code 会问你是否信任这个文件夹。**默认高亮的是 "No, exit",直接按回车会把 Manager 关掉。** 按一下方向键下,选 "Yes, I trust this folder",再回车。第一次 Multi-Code 会弹提示提醒你

**它能做什么:**

| 工具 | 作用 |
|------|------|
| `list_sessions` | 列出所有会话,带状态(idle / busy / blocked / stopped)和 context 用量 |
| `read_session` | 读某个会话最近的 transcript,不打扰它。已停止的会话也能读 |
| `send_task` | 给某个会话发消息。会话卡在确认框上时拒绝 |
| `run_command` | 在某个会话里执行 `/clear`、`/new`、`/compact`、`/context`、`/handoff` 之一,其他一律拒绝 |
| `start_session` | 启动一个已停止的会话 |
| `wait_for_idle` | 等某个会话跑完这一轮,不用轮询 |

它也有 Claude Code 本身的工具(Bash、Edit、Write),可以自己去核实某个会话说的话,或者顺手修点小问题。它的 guidance 里写了:别去改正在忙的会话所在的项目。

会话按侧边栏里显示的名字来叫。两个会话重名的话,给其中一个设个 alias。

**安全:** Manager 往某个会话里写东西之前,有一道闸先检查那个会话是不是卡在权限确认框上。往确认框里打字可能会批准你根本没看到的操作,所以这种写入会被拒绝,原因会显示在 Manager section 里。你自己打的字,不管是电脑上还是手机上,都不受这道闸限制。

Manager 的角色 guidance 放在它文件夹里的 `CLAUDE.md`。你可以改;只有这个文件还跟 Multi-Code 写过的某个版本一模一样时,Multi-Code 才会升级它。

### 通知行为

两种后端的通知行为完全一致,只是来源不同。Claude Code 通过 hooks 上报自己的状态:Multi-Code 启动的每个 `claude` 都带一个来自 Multi-Code 数据目录的 `--settings` 文件,里面的 hooks 把状态发到 app 本地的 `/alert` 接口。不会写你自己的 Claude 配置,所以在普通终端里跑 `claude` 不受影响。OpenCode 也一样,靠一个只上报的插件:Multi-Code 启动的每个 `opencode` 都从 Multi-Code 数据目录加载它,插件写在这个进程的 `OPENCODE_CONFIG_CONTENT` 里,叠加在你自己的配置之上,不会往 `~/.config/opencode/` 或项目的 `.opencode/` 里写任何东西。

- Agent 做完了,或停下来等你(权限确认、提问、计划审批)→ 响一次"滴滴",每个实例都响,包括你正在看的那个
- 头像闪烁 + 红点徽标
- Multi-Code 不在前台时 macOS Dock 图标弹跳(`critical` 模式,持续到你切回 app)
- 在某个会话的页面里打字或点任意位置,停掉它的提示音、清掉它的红点。在列表里点某个联系人,对那个联系人也一样。不会因为计时或窗口获得焦点就自动清掉
- 你按 Esc 打断的一轮,或你拒绝的弹窗,不会响
- 如果某个会话的 hooks 或插件一直没上报(比如你的 Claude 配置里有 `"disableAllHooks": true`),它的页面上会出一条提示,说 Multi-Code 没法知道它什么时候做完,而不是悄悄不响

### 离线状态

- 已停止的实例显示灰色头像
- 选中已停止的实例:聊天框中央显示大号 **OFFLINE** 字样
- 工具箱所有 section 强制折叠,不可展开
- 想恢复:点联系人右侧 ▶ 按钮重启它的后端 CLI

### Resume 到 IDE 的工作流

当某个 session 进入"需要边看代码边改"的深度模式:

1. 工具箱 → Quick Actions → 点 **Resume Elsewhere**,该后端的续接命令已复制(`claude --resume <id>` 或 `opencode tui --session <id>`)
2. 在 VS Code 里打开终端(或开 iTerm/Terminal.app),`cd` 到项目根
3. 粘贴回车,agent 在那个环境里继续这个 session
4. Multi-Code 这边可以保持运行,也可以关掉

### 手机互联

人不在电脑前的时候,在手机上看 agent 干到哪了、回答它的问题,别让它干等着。

**一次性设置:**

1. 工具箱 → **Phone** → 点 **Phone link: OFF** 打开。它会监听 6768 端口,默认是关的,毕竟这是往局域网上开了个口
2. 点 **Pair a phone**,出二维码
3. 用手机相机扫,然后用浏览器的"添加到主屏幕",之后打开起来跟 App 一样

在家同一个 WiFi 就这样够了。想**出门在外也能连**,电脑和手机都装 [Tailscale](https://tailscale.com) 并登同一个账号。Phone section 会告诉你有没有找到 Tailscale 地址,没有的话配对只在本地网络内有效。

**用法:**

- 手机上的实例列表跟电脑端联系人列表一致,点进去
- Agent 需要你的时候手机会震动,列表里那一项打红点
- 带选项的问题渲染成按钮,点一下就回答了
- 开放式问题在输入框打字,点 Send
- 展开 **Terminal** 能看到跟电脑端一模一样的原始终端画面

**安全相关:**

- 二维码里带着设备密钥,当密码看待,泄露了就重新生成一个
- 流量端到端加密,不经过任何服务器
- 配对时手机会 pin 住电脑的公钥,所以同一个地址上的其他东西冒充不了你的电脑
- 手机丢了在同一个面板里吊销,立刻断连,token 随即失效

**有个限制值得知道:** 读取问题是可靠的(直接解析 CLI 自己写的 session 文件),但**用按钮回答**依赖 CLI 的选项框接受数字键。哪天 CLI 改了这个行为,按钮可能失效,其他功能照常 —— 终端视图一直在那儿兜底。

### 语音秘书

给你离开屏幕的时候用。每个会话配一个秘书,会话做完或需要你的时候,它把事情念给你听,就像秘书给老板汇报:是带细节的转述,不是照着屏幕念。

**需要什么:**

- **写汇报:** Claude Code 要配好 Amazon Bedrock,并且能用 `global.anthropic.claude-sonnet-5-5`。秘书用的是你电脑上现成的 `claude` CLI,走你 `~/.claude/settings.json` 里的 Bedrock 配置,不需要另外的密钥。每次都是一次性调用:不带任何工具,也不会存进你的会话历史
- **语音(可选):** 一台用 `deploy/tts-server/` 搭起来的语音服务器(Qwen3-TTS,声音是 Serena)。其他同样是 OpenAI 语音接口的引擎过不了 **Test**,因为请求里点名要 Serena 这个声音。没有服务器的话,每条汇报都只有文字

**设置:**

1. 工具箱 → **Secretary**。想要声音的话,在 **Speech server** 下填好 **Address** 和 **Key**,点 **Save**,再点 **Test**。Test 会告诉你服务器通不通、密钥认不认、能不能拿回一段试听。两个都留空就是只要文字
2. 点 **Secretary Mode: OFF** 打开。对所有会话生效,重启后还是开着。已经亮着红点的会话会马上开始准备汇报

**用法:**

- 提示音、红点、Dock 弹跳都跟以前一模一样,秘书只是在同样的时刻多加一条汇报
- 屏幕上正显示的那个会话,语音准备好后自己打开卡片开始播
- 别的会话等你:点它的红点,卡片打开并开始播。点没有红点的联系人什么都不播
- 同一时间只播一条。卡片上有 **▶ Replay**(重播)、**■ Stop**(停止)和 **×**(关闭)
- 你在会话里打字或回答了确认框,卡片也还在。关掉之后,会话标题栏上的 **Secretary** 按钮能把最近一条汇报找回来,不会自己播,按 Replay 才播
- 关掉秘书模式会停止播放并关掉卡片

**用话回答确认框:**

权限确认、提问、计划审批的卡片上有一个回复框。它不是消息编辑框,你在这里打的字不会当成文字敲进终端。

- 可以说"可以""不行",按名字或编号选一个选项,或者给"Other"写你自己的答案
- "不行,改成 X"会先拒绝,再把"改成 X"当成你的下一条消息发出去。打回的计划会带上你想改的地方
- 有好几个问题的提问框,或者多选的,要整个答完。可以一次说完,也可以分几次说;每个问题都有答案之前什么都不按
- "以后不再询问"和计划的"自动接受修改",只有你明确要求时才会选,而且秘书会先跟你确认,你说"是"才按
- 回复有两种理解就反问你。问的是问题(比如"这个脚本会删什么?")就回答你。两种情况都不按任何键
- 按完之后,卡片上会有一行字说它做了什么
- 你回复的时候确认框已经没了或者变了,或者它按键的时候有人在终端里打字,它会停下来并告诉你
- OpenCode 的话,能回答的跟手机一样:权限确认(Reject 后面不能带理由)和只有一个单选问题的提问框。其他的会让你去终端操作
- 做完一轮的卡片没有回复框,照常在终端里回复。Manager 没有秘书

**隐私:**

- 会话记录的片段只发给写汇报的那个模型,汇报的文字只发给你的语音服务器
- 汇报和音频只放在内存里,不写盘
- 语音密钥单独放在 Multi-Code 数据目录里一个权限 `0600` 的文件里。保存后不再显示,不写日志,也不会发给界面
- 秘书模式关着的时候,什么都不调用,不花一分钱

**跟手机一样的限制:** 回答靠的是按 CLI 的选项键,这是界面上的习惯,不是 API。秘书没法把你的回答对应到一个它信得过的按键时,会直说,并让你去终端操作。

### 数据持久化

Multi-Code 自己存的东西都在 Electron 的 userData 目录里。macOS 上安装版是 `~/Library/Application Support/Multi-Code/`,从源码跑是 `~/Library/Application Support/multi-code/`。macOS 默认的磁盘格式文件名不分大小写,所以这其实是同一个文件夹:开发版和安装版共用一份联系人列表,两个同时开会互相覆盖对方的文件。

- `contacts.json`:实例列表(目录 + alias + 后端),按侧边栏顺序
- `settings.json`:主题、手机互联开没开、秘书模式、语音服务器地址
- `speech-key`:秘书的语音服务器密钥,单独一个 `0600` 文件。不放进 `settings.json`,不写日志,重启后保留
- `remote-identity.json`、`remote-devices.json`:手机互联的密钥和已配对手机
- `manager/`:Manager agent 的工作目录和它的 `CLAUDE.md`
- `manager-mcp.json`:Manager 的 MCP 配置,因为里面有 bearer token 所以权限是 `0600`,退出时删除
- `manager-settings.json`、`manager-hook.curl`:Manager 的 `--settings`(它自己的活动 hooks 加上提醒 hooks)和存 hook token 的 curl 配置;`0600`,退出时删除
- `alert-settings.json`、`alert-hook.curl`:其他每个 Claude 实例的 `--settings`(只有提醒 hooks)和存 `/alert` token 的 curl 配置;`0600`,退出时删除
- `opencode/multicode-plugin.js`、`opencode/alert.json`:每个 OpenCode 实例加载的只上报插件,以及它读取的 `/alert` 地址和 token;`0600`,退出时删除
- App 重启后自动恢复联系人列表(状态都是 stopped,需手动启动)
- Session 内容由后端 CLI 自己管(Claude Code 在 `~/.claude/`,OpenCode 在 `~/.local/share/opencode/`),Multi-Code 不存任何对话内容,也从不往这些目录里写

## 工作原理

1. 用户选一个项目目录和后端(Claude Code / OpenCode)创建实例
2. App 通过 node-pty 在该目录 spawn 对应后端 CLI(`claude` / `opencode`,有历史 session 就续上)。后端在 `src/main/backends/` 的一个小 `Backend` 接口后面可插拔
3. PTY stdout 实时管道到 renderer 里的 xterm.js 终端
4. 每个 agent 的状态来自 agent 自己:Claude Code 通过启动时用 `--settings` 传入的只上报 hooks 报告(做完了、在等权限确认或回答问题),OpenCode 通过写在它 `OPENCODE_CONFIG_CONTENT` 里的只上报插件报告。两者都不往用户自己的配置里写任何东西
5. 做完或等你时:声音 + 闪烁 + Dock 弹跳,每个实例都一样。红点一直留着,直到你在那个会话里打字、点击,或选中它
6. 工具箱 sections 各自管理生命周期:
   - Git:展开期间每 5s 调用 `git`
   - Terminal:第一次展开时 lazy-spawn 一个 shell PTY,之后保活
7. 实例信息持久化到 userData 目录里的 `contacts.json`
8. 主进程在 app 打开期间一直在 `127.0.0.1` 上跑一个小 HTTP server(端口由系统分配,bearer token 鉴权)。它给 Manager 提供 MCP 工具:Manager 的 `claude` 启动时带 `--mcp-config` 指向它,另外挂了 hooks,把它自己的工具调用报回活动记录。它还有一个 `/alert` 路径,用单独的 token,给 agent 上报自己的状态
9. 手机互联打开时,主进程还会在 6768 端口起一个 WebSocket server,既托管手机网页,又把同一份 PTY 字节流和解析出来的 prompt 推给已配对的手机。每一帧用 NaCl box 封装;手机通过局域网或 Tailscale 直连电脑,中间没有任何 relay
10. 秘书模式打开时,每次做完或等你的事件都交给一次性的 `claude -p --bare --no-session-persistence` 调用来写汇报,再交给语音服务器出音频。卡片上的回复走第二次这样的调用,由它决定按什么;只有同一个确认框还显示着的时候才会按键

## 许可

[MIT](./LICENSE)
