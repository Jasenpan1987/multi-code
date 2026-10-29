// What each scenario of the phone dev harness starts as. The content is the
// mockups' (docs/specs/mobile-v2/mockups/index.html), so a screenshot of a phone
// screen can be held against its mockup. Times are relative to when the scenario
// was (re)set, so ages read the same on every run.

import type { RemoteSessionState, TranscriptEntry } from "../../src/shared/remote-protocol";
import type { OpenDialog, Session, Step } from "./world.ts";

export const SCENARIOS = [
  "home",
  "finished",
  "permission",
  "questions",
  "plan",
  "terminal",
  "empty",
] as const;
export type ScenarioName = (typeof SCENARIOS)[number];

export function isScenario(name: string): name is ScenarioName {
  return (SCENARIOS as readonly string[]).includes(name);
}

export const TERMINAL_COLS = 120;
export const TERMINAL_ROWS = 36;

const DAY_S = 24 * 3600;

export type ScriptedSession = Omit<Session, "dialog" | "idPrefix"> & { dialog?: Omit<OpenDialog, "seq"> };

// A transcript written backwards in time from `now`: `at(s)` is s seconds ago.
function writer(id: string, now: number) {
  const entries: TranscriptEntry[] = [];
  const add = (secondsAgo: number, fields: Omit<TranscriptEntry, "id" | "at">) =>
    entries.push({ id: `${id}-${entries.length + 1}`, at: now - secondsAgo * 1000, ...fields });
  return {
    entries,
    user: (ago: number, text: string) => add(ago, { kind: "user", text }),
    say: (ago: number, text: string) => add(ago, { kind: "assistant", text }),
    tool: (ago: number, step: Step) => call(ago, step, false),
    pending: (ago: number, step: Step) => call(ago, step, true),
    // A finished turn: the message, its calls 20 s apart, the conclusion.
    turn: (ago: number, user: string, steps: Step[], conclusion: string) => {
      add(ago, { kind: "user", text: user });
      steps.forEach((step, i) => call(ago - 20 * (i + 1), step, false));
      add(ago - 20 * (steps.length + 1), { kind: "assistant", text: conclusion });
    },
  };

  function call(ago: number, step: Step, pending: boolean) {
    if (step.say) add(ago + 1, { kind: "assistant", text: step.say });
    const { tool, text, outcome = "ok", added, removed } = step;
    add(ago, pending ? { kind: "tool", tool, text, pending } : { kind: "tool", tool, text, outcome, added, removed });
  }
}

function session(
  info: Session["info"],
  state: RemoteSessionState,
  since: number,
  entries: TranscriptEntry[],
  extra: Partial<ScriptedSession> = {}
): ScriptedSession {
  return {
    info,
    state,
    since,
    entries,
    steps: [],
    queued: [],
    cols: TERMINAL_COLS,
    rows: TERMINAL_ROWS,
    typed: "",
    ...extra,
  };
}

const CWD = "/Users/builder/code";

const CLAUDE_PERMISSION = (always: string) => [
  { effect: "allow-once" as const, label: "Yes" },
  { effect: "allow-always" as const, label: `Yes, and don't ask again for ${always}` },
  { effect: "deny" as const, label: "No, and tell Claude what to do differently" },
];

// secretary/dialog.ts CLAUDE_PLAN_OPTIONS: the plan box's labels on 2.1.295.
const CLAUDE_PLAN = [
  { effect: "approve-auto" as const, label: "Yes, and auto-accept edits" },
  { effect: "approve" as const, label: "Yes, manually approve edits" },
  { effect: "revise" as const, label: "No, tell Claude what to change" },
];

// multi-code's earlier turns, the same in every scenario, so "Earlier turns" has
// something to load and the Markdown renderer gets a table and a code block.
const HISTORY: [string, Step[], string][] = [
  [
    "README 里的安装步骤还对吗？",
    [{ tool: "Read", text: "README.md" }, { tool: "Edit", text: "README.md", added: 1, removed: 1 }],
    "对的，只有 Node 版本写旧了，我改成了 22。",
  ],
  [
    "把 oxlint 升到最新",
    [{ tool: "Bash", text: "pnpm up oxlint" }, { tool: "Bash", text: "pnpm lint" }],
    "升到 0.16 了，lint 没有新的报错。",
  ],
  [
    "对比一下三种 token 存储方式",
    [{ tool: "WebFetch", text: "https://owasp.org/www-community/HttpOnly" }],
    "### 三种存储方式\n\n| 方式 | XSS | CSRF | 实现 |\n|---|---|---|---|\n| httpOnly cookie | 拿不到 | 要防 | 中等 |\n| localStorage | 拿得到 | 不受影响 | 简单 |\n| 内存 | 拿得到 | 不受影响 | 刷新就丢 |\n\n我倾向 httpOnly cookie。",
  ],
  [
    "sessionId 是在哪里生成的？",
    [{ tool: "Grep", text: "sessionId" }, { tool: "Read", text: "src/auth/session.ts" }],
    "在 `src/auth/session.ts` 的 `createSession()` 里，用的是 `crypto.randomUUID()`。",
  ],
  [
    "加一个健康检查接口",
    [
      { tool: "Write", text: "src/routes/health.ts", added: 14, removed: 0 },
      { tool: "Edit", text: "src/routes/index.ts", added: 2, removed: 0 },
    ],
    "加好了：`GET /health` 返回 `{ ok: true }`。",
  ],
  [
    "health 的测试呢",
    [
      { tool: "Write", text: "src/routes/health.test.ts", added: 22, removed: 0 },
      { tool: "Bash", text: "pnpm test --filter health" },
    ],
    "测试加了，2 个用例都过。",
  ],
  [
    "CI 为什么挂了",
    [{ tool: "Bash", text: "gh run view --log-failed" }],
    '是 lockfile 没更新：\n\n```\nERR_PNPM_OUTDATED_LOCKFILE  Cannot install with "frozen-lockfile"\n```\n\n我跑一下 `pnpm install` 再提交。',
  ],
  [
    "好，提交吧",
    [{ tool: "Bash", text: "pnpm install" }, { tool: "Bash", text: 'git commit -am "chore: update lockfile"' }],
    "提交了：`a1b2c3d chore: update lockfile`。",
  ],
  [
    "登录页的报错文案统一一下",
    [{ tool: "Grep", text: "登录失败" }, { tool: "Edit", text: "src/pages/Login.tsx", added: 4, removed: 6 }],
    "统一成「用户名或密码不对」了，一共 3 处。",
  ],
  [
    "把 dev server 端口改成 5174",
    [{ tool: "Edit", text: "vite.config.ts", added: 1, removed: 1 }],
    "改好了。",
  ],
  [
    "看一下 bundle 里有没有重复的 lodash",
    [{ tool: "Bash", text: "pnpm why lodash" }],
    "有两份：4.17.21 和 4.17.15，后者来自 `old-datepicker`。要换掉它吗？",
  ],
  ["先不换，记到 TODO 里", [{ tool: "Edit", text: "TODO.md", added: 1, removed: 0 }], "记下了。"],
];

const PLAN = `## JWT 迁移计划

1. 新增 \`src/auth/jwt.ts\`：签发、校验、刷新。
2. \`/login\` 同时下发 JWT 和旧 cookie，一周内两种都认。
3. 中间件先认 JWT，失败再认旧 cookie，打日志统计。
4. 11-05 以后删掉旧 cookie 的分支。
5. 补测试：过期、伪造、刷新、旧 cookie 兼容。

**风险**：iOS 老版本只认 cookie，要等它的使用量降下来。

**不改**：注册流程、找回密码。

### 要改的文件

| 文件 | 改动 |
|---|---|
| \`src/auth/jwt.ts\` | 新增 |
| \`src/routes/login.ts\` | 下发 JWT |
| \`src/middleware/auth.ts\` | 先认 JWT |
| \`src/auth/legacySession.ts\` | 兼容期 |
| \`src/routes/login.test.ts\` | 补用例 |
| \`src/middleware/auth.test.ts\` | 补用例 |
| \`docs/auth.md\` | 更新说明 |

### 中间件的顺序

\`\`\`ts
app.use(jwtAuth({ fallback: legacySession }));
\`\`\`

预计改 6 个文件，新增 1 个。`;

function planDialog(plan: string): Omit<OpenDialog, "seq"> {
  return {
    summary: "Plan: JWT 迁移计划",
    dialog: { kind: "plan", plan, options: CLAUDE_PLAN },
    asking: { tool: "ExitPlanMode", text: "" },
    after: [
      { tool: "Write", text: "src/auth/jwt.ts", added: 52, removed: 0 },
      { tool: "Edit", text: "src/routes/login.ts", added: 14, removed: 28 },
      { tool: "Edit", text: "src/middleware/auth.ts", added: 9, removed: 3 },
      { tool: "Bash", text: "pnpm test" },
    ],
    conclusion: "按计划改完了，测试全过。旧 cookie 的分支 11-05 以后再删。",
    revised: (feedback) => ({
      ...planDialog(`${plan}\n\n> 按你的意见改了：${feedback}`),
      asking: { say: "好，按你说的改了计划。", tool: "ExitPlanMode", text: "" },
    }),
  };
}

// multi-code: the session every dialog mockup is drawn on, so each scenario puts
// a different moment of it on screen.
function multiCode(scenario: ScenarioName, now: number): ScriptedSession {
  const w = writer("multi-code", now);
  HISTORY.forEach(([user, steps, conclusion], i) => w.turn((HISTORY.length - i) * 3600 + 900, user, steps, conclusion));
  const info = { id: "multi-code", name: "multi-code", cwd: `${CWD}/multi-code`, backend: "claude", status: "running" as const };

  if (scenario === "finished") {
    // Mockups 2.1 and 2.2: 12 tools, 2m 41s, a Markdown conclusion.
    w.user(221, "把登录接口改成 JWT，旧的 cookie session 兼容一周");
    const steps: Step[] = [
      { tool: "Read", text: "src/auth/session.ts" },
      { tool: "Read", text: "src/routes/login.ts" },
      { tool: "Grep", text: "sessionId" },
      { tool: "Read", text: "src/db/user.ts" },
      { tool: "Read", text: "src/middleware/auth.ts" },
      { tool: "Read", text: "package.json" },
      { say: "先把签发和校验放到新文件里，旧的 cookie session 单独留着。", tool: "Write", text: "src/auth/jwt.ts", added: 48, removed: 0 },
      { tool: "Edit", text: "src/routes/login.ts", added: 12, removed: 30 },
      { tool: "Edit", text: "src/auth/legacySession.ts", added: 9, removed: 2 },
      { tool: "Bash", text: "pnpm test", outcome: "error" },
      { say: "有 3 个测试失败，是过期时间的单位写成了毫秒。", tool: "Edit", text: "src/auth/jwt.ts", added: 3, removed: 1 },
      { tool: "Bash", text: "pnpm test" },
    ];
    steps.forEach((step, i) => w.tool(205 - i * 12, step));
    w.say(
      60,
      "改好了。\n\n- `src/auth/jwt.ts`：新增签发和校验\n- 旧 cookie session 在 `legacySession.ts` 里保留到 11-05\n- 42 个单元测试全过\n\n还有一个问题要你定：refresh token 放 httpOnly cookie，还是放 localStorage？我建议 cookie，XSS 拿不到。"
    );
    return session(info, "finished", now - 60 * 1000, w.entries);
  }

  if (scenario === "permission") {
    // Mockup 3.1: "4 tools · 3 read · 1 command · 1m 05s", then the Bash box.
    w.user(95, "打包体积好像变大了，查一下");
    w.tool(90, { tool: "Read", text: "package.json" });
    w.tool(80, { tool: "Read", text: "rspack.renderer.config.ts" });
    w.tool(70, { tool: "Glob", text: "dist/**/*.map" });
    w.tool(50, { tool: "Bash", text: "du -sh dist" });
    w.say(35, "`dist/` 里还留着上次的 sourcemap，有 38 MB。我清掉重新打一次，再看真实体积。");
    w.pending(30, { tool: "Bash", text: "rm -rf dist && pnpm build" });
    return session(info, "needs-you", now - 30 * 1000, w.entries, {
      dialog: {
        summary: "Bash: rm -rf dist && pnpm build",
        dialog: {
          kind: "permission",
          tool: "Bash",
          subject: "rm -rf dist && pnpm build",
          description: "Clean and rebuild the bundle",
          options: CLAUDE_PERMISSION("rm commands in multi-code"),
          reasonAllowed: true,
        },
        asking: { tool: "Bash", text: "rm -rf dist && pnpm build" },
        after: [{ tool: "Bash", text: "du -sh dist" }],
        conclusion:
          "清掉旧的 sourcemap 以后，`dist/` 是 4.2 MB，比上个版本还小 0.3 MB。\n\n体积没有变大，是上次打包留下的 sourcemap。",
      },
    });
  }

  if (scenario === "questions") {
    // Mockup 3.2: two questions, the second multi-select.
    w.user(70, "refresh token 的事你问我吧");
    w.say(50, "好，有两个问题要你定。");
    w.pending(45, { tool: "AskUserQuestion", text: "" });
    return session(info, "needs-you", now - 45 * 1000, w.entries, {
      dialog: {
        summary: "refresh token 放在哪里？",
        dialog: {
          kind: "questions",
          textAllowed: true,
          questions: [
            {
              header: "Storage",
              question: "refresh token 放在哪里？",
              multiSelect: false,
              options: [
                { label: "httpOnly cookie", description: "XSS 拿不到，要防 CSRF" },
                { label: "localStorage", description: "实现简单，XSS 拿得到" },
                { label: "内存", description: "刷新页面就要重新登录" },
              ],
            },
            {
              header: "Clients",
              question: "哪些端要先支持新的登录方式？",
              multiSelect: true,
              options: [
                { label: "Web", description: "主站和 apra-portal" },
                { label: "iOS", description: "要发新版本" },
                { label: "Android", description: "要发新版本" },
                { label: "Admin console", description: "内部用，可以晚点" },
              ],
            },
          ],
        },
        asking: { tool: "AskUserQuestion", text: "" },
        after: [
          { tool: "Edit", text: "src/auth/jwt.ts", added: 6, removed: 2 },
          { tool: "Edit", text: "src/routes/login.ts", added: 3, removed: 0 },
        ],
        conclusion: "按你的选择改了，下一步写刷新接口。",
      },
    });
  }

  if (scenario === "plan") {
    // Mockup 3.3.
    w.user(80, "先出个计划，我看完再改");
    w.tool(70, { tool: "Read", text: "src/auth/session.ts" });
    w.tool(55, { tool: "Read", text: "src/middleware/auth.ts" });
    w.tool(40, { tool: "Grep", text: "cookie" });
    w.pending(20, { tool: "ExitPlanMode", text: "" });
    return session(info, "needs-you", now - 20 * 1000, w.entries, { dialog: planDialog(PLAN) });
  }

  if (scenario === "terminal") {
    // Mockup 4.1: an MCP form, which the phone can't show.
    w.user(150, "把这个 bug 记到 Linear 里");
    w.tool(140, { tool: "Read", text: "src/upload/handler.ts" });
    w.tool(130, { tool: "Read", text: "src/upload/limits.ts" });
    w.tool(120, { tool: "Read", text: "logs/upload-error.log" });
    w.pending(90, {
      say: "MCP 服务器要你填一个表单，手机界面没法显示，用终端答。",
      tool: "mcp__linear__create_issue",
      text: "上传超过 100 MB 失败",
    });
    return session(info, "needs-you", now - 90 * 1000, w.entries, {
      dialog: {
        summary: "linear-mcp needs input",
        asking: { tool: "mcp__linear__create_issue", text: "上传超过 100 MB 失败" },
        after: [],
        conclusion: "在 Linear 建好了：APRA-1423「上传超过 100 MB 失败」。",
      },
    });
  }

  // home: mockup 1A's first row, a Bash permission (the 1B card's context).
  w.user(260, "跑一下全部测试，包括 e2e");
  w.tool(250, { tool: "Bash", text: "pnpm test" });
  w.pending(120, { say: "单元测试 42 个全过，现在跑 e2e。", tool: "Bash", text: "pnpm test:e2e" });
  return session(info, "needs-you", now - 120 * 1000, w.entries, {
    dialog: {
      summary: "Bash: pnpm test:e2e",
      dialog: {
        kind: "permission",
        tool: "Bash",
        subject: "pnpm test:e2e",
        description: "Run the end-to-end tests",
        options: CLAUDE_PERMISSION("pnpm test:e2e commands in multi-code"),
        reasonAllowed: true,
      },
      asking: { tool: "Bash", text: "pnpm test:e2e" },
      after: [],
      conclusion: "e2e 也全过了：18 个用例，用时 1m 12s。",
    },
  });
}

export function buildScenario(scenario: ScenarioName, now: number): ScriptedSession[] {
  if (scenario === "empty") return [];
  const ago = (seconds: number) => now - seconds * 1000;

  // OpenCode, on a single question (mockup 1A, the 1B card).
  const pipeline = writer("data-pipeline", now);
  pipeline.user(900, "写一个把 orders_v1 迁到 orders 的迁移脚本");
  pipeline.tool(880, { tool: "read", text: "db/schema.sql" });
  pipeline.tool(860, { tool: "read", text: "db/migrations/0041_orders.sql" });
  pipeline.tool(700, { tool: "write", text: "db/migrations/0042_orders_v2.sql", added: 64, removed: 0 });
  pipeline.tool(560, { tool: "bash", text: "pnpm db:migrate --dry-run" });
  pipeline.pending(480, { say: "迁移脚本写好了，dry run 通过。跑之前有一件事要你定。", tool: "question", text: "" });
  const dataPipeline = session(
    { id: "data-pipeline", name: "data-pipeline", cwd: `${CWD}/data-pipeline`, backend: "opencode", status: "running" },
    "needs-you",
    ago(480),
    pipeline.entries,
    {
      dialog: {
        summary: "迁移脚本要保留旧表 orders_v1 吗？",
        dialog: {
          kind: "questions",
          textAllowed: true,
          questions: [
            {
              header: "Old table",
              question: "迁移脚本要保留旧表 orders_v1 吗？",
              multiSelect: false,
              options: [
                { label: "保留 30 天", description: "改名为 orders_v1_backup，30 天后删" },
                { label: "直接删除", description: "迁移完成后立即 DROP" },
              ],
            },
          ],
        },
        asking: { tool: "question", text: "" },
        after: [
          { tool: "edit", text: "db/migrations/0042_orders_v2.sql", added: 5, removed: 1 },
          { tool: "bash", text: "pnpm db:migrate --dry-run" },
        ],
        conclusion: "按你的选择改好了，dry run 通过。正式迁移要你在电脑上跑 `pnpm db:migrate`。",
      },
    }
  );

  // Working (mockup 2.3): five tools in, Bash running for 41 s; finishes about half
  // a minute after the scenario starts, at one call per tick.
  const portal = writer("apra-portal", now);
  portal.user(200, "登录页加一个“记住我”勾选框，勾上以后 30 天免登录");
  portal.say(190, "先看一下现在的登录表单和 token 的有效期设置。");
  portal.tool(185, { tool: "Read", text: "src/pages/Login.tsx" });
  portal.tool(170, { tool: "Read", text: "src/api/auth.ts" });
  portal.tool(140, { tool: "Edit", text: "src/pages/Login.tsx", added: 18, removed: 2 });
  portal.tool(90, { tool: "Edit", text: "src/api/auth.ts", added: 6, removed: 0 });
  portal.pending(41, { tool: "Bash", text: "pnpm test --filter login" });
  const apraPortal = session(
    { id: "apra-portal", name: "apra-portal", cwd: `${CWD}/apra-portal`, backend: "claude", status: "running" },
    "working",
    ago(200),
    portal.entries,
    {
      running: { tool: "Bash", text: "pnpm test --filter login" },
      steps: [
        { say: "登录相关的测试过了，再补一个“记住我”的用例。", tool: "Read", text: "src/pages/Login.test.tsx" },
        { tool: "Edit", text: "src/pages/Login.test.tsx", added: 24, removed: 0 },
        { tool: "Read", text: "src/api/auth.test.ts" },
        { tool: "Edit", text: "src/api/auth.test.ts", added: 16, removed: 1 },
        { tool: "Bash", text: "pnpm lint" },
        { tool: "Bash", text: "pnpm test --filter login" },
      ],
      end: {
        conclusion:
          "加好了。\n\n- 登录页多了“记住我”勾选框，默认不勾\n- 勾上时 refresh token 有效期是 30 天，不勾还是 1 天\n- 补了 2 个测试，都过了",
      },
    }
  );

  // Finished 15 min ago (mockup 1A's row; its conversation is mockup 4.2's).
  const infra = writer("infra-terraform", now);
  infra.turn(4000, "给 logs bucket 加 lifecycle，30 天转 Glacier", [
    { tool: "Edit", text: "modules/logs/main.tf", added: 11, removed: 0 },
  ], "改好了，还没 plan。");
  infra.user(948, "plan 有删除吗？");
  infra.tool(940, { tool: "Read", text: "modules/logs/main.tf" });
  infra.tool(930, { tool: "Read", text: "modules/ci/iam.tf" });
  infra.tool(910, { tool: "Bash", text: "terraform plan -out=tfplan" });
  infra.say(
    900,
    "没有删除。`terraform plan` 显示 2 处变更：\n\n- `aws_s3_bucket.logs`：加 lifecycle 规则\n- `aws_iam_role.ci`：加一条 policy\n\n要我 apply 吗？"
  );
  const infraTerraform = session(
    { id: "infra-terraform", name: "infra-terraform", cwd: `${CWD}/infra-terraform`, backend: "claude", status: "running" },
    "finished",
    ago(900),
    infra.entries,
    { preview: "改好了。plan 显示 2 处变更，没有删除。要我 apply 吗？" }
  );

  // OpenCode, idle since yesterday; in "permission" it waits on an OpenCode
  // permission instead (Allow once / Always allow / Reject).
  const docs = writer("docs-site", now);
  docs.turn(DAY_S + 2 * 3600, "首页文案换成新版的", [
    { tool: "read", text: "src/pages/index.mdx" },
    { tool: "edit", text: "src/pages/index.mdx", added: 12, removed: 9 },
  ], "首页文案已经换成新版。");
  const docsInfo = { id: "docs-site", name: "docs-site", cwd: `${CWD}/docs-site`, backend: "opencode", status: "running" as const };
  let docsSite = session(docsInfo, "idle", ago(DAY_S + 2 * 3600 - 60), docs.entries);
  if (scenario === "permission") {
    docs.user(420, "把文档站部署一个预览版");
    docs.tool(400, { tool: "bash", text: "pnpm build" });
    docs.pending(300, { say: "构建过了，现在部署预览。", tool: "bash", text: "pnpm run deploy:preview" });
    docsSite = session(docsInfo, "needs-you", ago(300), docs.entries, {
      dialog: {
        summary: "bash: pnpm run deploy:preview",
        dialog: {
          kind: "permission",
          tool: "bash",
          subject: "pnpm run deploy:preview",
          description: "Deploy a preview of the docs site",
          // secretary/dialog.ts OPENCODE_PERMISSION.
          options: [
            { effect: "allow-once", label: "Allow once" },
            {
              effect: "allow-always",
              label: "Always allow",
              description: "Allow it, and save that for this project: calls like it are allowed from now on",
            },
            { effect: "deny", label: "Reject" },
          ],
          reasonAllowed: true,
        },
        asking: { tool: "bash", text: "pnpm run deploy:preview" },
        after: [],
        conclusion: "预览部署好了：https://preview-42.docs.example.com",
      },
    });
  }

  // Stopped since Monday: no PTY, so `prompt` and Stop are refused (not-running).
  const review = writer("multi-code-review", now);
  review.turn(3 * DAY_S + 5 * 3600, "review 一下 feat/file-drop 的改动", [
    { tool: "Bash", text: "git diff master...feat/file-drop --stat" },
    { tool: "Read", text: "src/main/file-drop.ts" },
    { tool: "Edit", text: "src/main/file-drop.ts", added: 7, removed: 3 },
  ], "review 完了，3 个问题都修了。");
  const multiCodeReview = session(
    { id: "multi-code-review", name: "multi-code (review)", cwd: `${CWD}/multi-code`, backend: "claude", status: "stopped" },
    "idle",
    ago(3 * DAY_S + 5 * 3600 - 80),
    review.entries
  );

  return [multiCode(scenario, now), dataPipeline, apraPortal, infraTerraform, docsSite, multiCodeReview];
}
