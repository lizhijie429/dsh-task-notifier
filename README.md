# dsh-task-notifier

> [English](README.en.md) | 中文

DSH（DeepSeek Harness）插件：监控任务（= 一个 `turn`）执行状态，在任务结束/失败时调用**系统通知**提醒；如果失败原因是**模型请求失败次数超限**（`llm/retry` 重试预算耗尽），自动向当前会话发送一条 `继续`，让 Agent 接着干。

- npm 包名：`@lizhijie429/dsh-task-notifier`；源码仓库：<https://github.com/lizhijie429/dsh-task-notifier>。
- 零运行时依赖，纯 ESM 单目录插件，可按绝对路径直接挂载，无需构建/安装。
- 通知通道：Windows Toast（PowerShell 5.1 WinRT）、macOS `osascript`、Linux `notify-send`，也可降级为纯日志。
- **Windows Toast 使用 DSH 图标与名称**（注册 `DSH.TaskNotifier` AUMID），不再是 “Windows PowerShell”。
- 状态判定只读**持久化会话事件**（`turn/start`、`llm/retry`、`turn/end`），不猜测运行中状态。

## 目录结构

```text
dsh-task-notifier/
├── index.mjs              # Cordis 插件入口：日志、配置、observer、事件订阅
├── package.json           # dsh.bundle.patch 指向 bundle patch（用于 bundle 方式安装）
├── cordis.patch.yml       # bundle patch：插入 task-notifier 默认配置
├── lib/
│   ├── config.mjs         # 默认配置、校验、归一化（非法值回退 + warning）
│   ├── format.mjs         # 事件分类、失败码、通知文案（中文）、重试耗尽判定
│   ├── notify.mjs         # 通道选择、命令执行、macOS AppleScript 构造
│   ├── win-appid.mjs      # Windows 通知身份（AUMID）注册与 DSH 图标定位
│   ├── win-toast.ps1      # Windows Toast（WinRT）+ 托盘气泡兜底
│   ├── file-log.mjs       # JSONL 调试日志（256KB 轮转）
│   └── observer.mjs       # 每个会话的 turn 状态机 + 自动继续
├── assets/
│   ├── tray.ico           # 通知身份图标（Shell 图标）
│   └── icon.png           # Toast 内 appLogoOverride 图片
└── test/
    ├── config.test.mjs
    ├── format.test.mjs
    ├── notify.test.mjs
    ├── observer.test.mjs
    └── e2e/               # 本地端到端验证补丁与脚本（不参与单元测试）
```

## 安装

### 方式一：直接挂载到 `desktop` profile（推荐，当前桌面端）

`desktop` profile 被 Electron 占用，`dsh plugin` / `--dump-config` 等 CLI 命令会拒绝它，因此直接编辑用户补丁层 `$env:USERPROFILE\.dsh\profiles\desktop\cordis.patch.yml`（把下面示例中的 `<user>` 替换为你的 Windows 用户名）追加：

```yaml
- insert:
    - id: task-notifier
      name: 'C:\Users\<user>\.dsh\plugins\dsh-task-notifier\index.mjs'
      config:
        channel: auto
        logFile: 'C:\Users\<user>\.dsh\plugins\dsh-task-notifier\state\task-notifier.log'
        notifyOnStart: false
        notifyOnComplete: true
        notifyOnError: true
        notifyOnAbort: false
        notifyOnStep: false
        notifySubagents: false
        titlePrefix: DSH
        maxBodyChars: 240
        autoContinue:
          enabled: true
          message: 继续
          maxAttempts: 3
          cooldownMs: 5000
          requireRetryExhausted: false
```

- `name` 必须是**绝对路径**（或 file URL）；也可以用包名，但需要该包在 profile 的依赖里。
- 保存后：`desktop` profile 的 `patchReload` 缺省为 `live`，运行中的桌面端通常会热加载并挂载插件；若未生效，重启 DeepSeek Harness。
- 验证：查看 `state/task-notifier.log` 出现 `plugin.mounted`。

也可以在自己的 profile 里对同一 `id` 覆盖 `config`（补丁会**整体替换**该行的 `config`，未写的字段回退插件默认值）。

### 方式二：作为 bundle 安装到普通 profile（web / headless / 自建）

若已发布到 npm：

```powershell
dsh plugin --profile web add "@lizhijie429/dsh-task-notifier"
```

直接从 GitHub 安装（无需 npm 发布；本插件无构建步骤）：

```powershell
dsh plugin --profile web add "github:lizhijie429/dsh-task-notifier"
```

从本地 checkout 安装：

```powershell
cd "$env:USERPROFILE\.dsh\plugins\dsh-task-notifier"
dsh plugin --profile web add "file:$PWD"
```

`package.json` 的 `dsh.bundle.patch` 会让 profile 自动加载 `cordis.patch.yml` 中的默认配置（id 为 `task-notifier`）；`engines.dsh` 要求 DSH `>=0.2.1`。

### 方式三：临时验证（不修改任何 profile）

```powershell
$pluginDir = "$env:USERPROFILE\.dsh\plugins\dsh-task-notifier"
$patch = @"
- insert:
    - id: task-notifier
      name: '$pluginDir\index.mjs'
      config:
        channel: log
        logFile: '$pluginDir\state\e2e.log'
        autoContinue: { enabled: true, message: 继续, maxAttempts: 2, cooldownMs: 0 }
"@
Set-Content -Path "$env:TEMP\task-notifier.patch.yml" -Value $patch -Encoding UTF8
dsh headless --patch "$env:TEMP\task-notifier.patch.yml" "只回复 OK，不要调用工具。"
```

## 配置参考

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `notifyOnStart` | `false` | `turn/start` 时通知（开始刷屏，默认关） |
| `notifyOnComplete` | `true` | `turn/end` 且 `reason.kind` 为 `completed`/`max-tokens` 时通知 |
| `notifyOnError` | `true` | `error`/`blocked`/`interrupted` 时通知 |
| `notifyOnAbort` | `false` | 用户取消（`aborted`）时是否通知 |
| `notifyOnStep` | `false` | 每步（`step/start`）通知，调试用 |
| `notifySubagents` | `false` | 是否通知子代理会话（默认只通知主会话） |
| `channel` | `auto` | `auto`/`windows`/`macos`/`linux`/`log`/`none` |
| `titlePrefix` | `DSH` | 通知标题前缀（≤60 字符，超出截断并告警） |
| `windowsAppId` | `DSH.TaskNotifier` | Windows Toast 的 AppUserModelID（决定通知中的应用名/图标） |
| `windowsAppName` | `DSH` | Windows Toast 显示的应用名 |
| `maxBodyChars` | `240` | 正文裁剪长度（60–2000） |
| `includePreview` | `false` | 是否在通知里附模型输出预览（默认关，避免锁屏泄露内容） |
| `logFile` | `<插件目录>/state/task-notifier.log` | JSONL 调试日志；相对路径按插件目录解析；256KB 轮转为 `.1` |
| `autoContinue.enabled` | `true` | 是否允许自动继续 |
| `autoContinue.message` | `继续` | 自动发送的用户消息内容 |
| `autoContinue.maxAttempts` | `3` | 每个任务最多自动继续次数（硬上限 50） |
| `autoContinue.cooldownMs` | `5000` | 两次自动继续之间的最小间隔；`0` 表示立即 |
| `autoContinue.requireRetryExhausted` | `false` | 默认 `false`：网络/模型请求类失败（`TRANSPORT`、`TIMEOUT`、`RATE_LIMIT`、`SERVER`、provider 的 `PI_AI_ERROR` 等）都会继续；设为 `true` 时仅继续“重试预算耗尽”的失败 |
| `autoContinue.respectProviderRetryAfter` | `true` | 若失败带 `providerRetryAfterMs`，至少等待该时长再继续（>120s 则跳过） |
| `autoContinue.retryableCodes` | `EMPTY_RESPONSE,RATE_LIMIT,SERVER,TIMEOUT,TRANSPORT,PI_AI_ERROR,AI_ERROR,PROVIDER,MODEL,OVERLOADED,NETWORK,CONNECTION,ECONNRESET,ECONNREFUSED,ETIMEDOUT,ENOTFOUND,EAI_AGAIN,SOCKET` | 视为可继续的失败码（网络/模型请求类） |

非法配置不会抛错：逐项回退默认值，既写 Host 日志，也作为 `config.warning` 事件写进调试日志，并汇总到 `plugin.mounted` 的 `warnings` 字段；未知配置键（手写 patch 拼写错误）同样会告警，不再静默失效。

## 判定逻辑

1. **任务 = 一个 `turn`**：多步工具调用仍是一个 turn，只在 `turn/end` 发一次通知。
2. **状态分类**（`reason.kind`）：
   - `completed` → ✅ 任务完成（附耗时、步数、最后一条助手文本预览）
   - `error` → ❌ 任务失败（附失败码/信息）
   - `aborted` → ⏹️ 任务已取消（可选，附取消原因）
   - `blocked` → ⛔ 任务被阻塞
   - `max-tokens` → ⚠️ 任务达到输出上限
3. **失败是否值得继续**（`lib/observer.mjs#decideContinuation`）：
   - 失败必须是 `error`，且失败码在 `retryableCodes` 内；否则跳过并显示“失败不属于可继续的类型”（`AUTH`、`UNKNOWN` 等不继续）。
   - 默认 `requireRetryExhausted: false`：网络与模型请求类失败直接继续（例如 `TRANSPORT: Connection error.`，以及 provider 返回的 `PI_AI_ERROR`）。
   - `requireRetryExhausted: true` 时更严格：还要求本轮存在 `llm/retry` 且最后一条 `retry >= maxRetries`（normal 模式预算耗尽）；没有 `llm/retry` 事件时视为首次请求即失败（`maxRetries: 0` 或瞬态失败），同样视为耗尽。
   - `always` 模式不会“耗尽”，因此严格模式下不会触发自动继续。
   - 失败若带 `providerRetryAfterMs`（provider 要求稍后重试），插件会按该值延迟再继续；超过 120s 则跳过（由 `autoContinue.respectProviderRetryAfter` 控制）。
4. **自动继续的落地时机**：在 `agent/status` 的 `idle` 边上调用 `agent.followup()`，而不是在 `turn/end` 监听器里直接调用。
   - 原因：`Session.append()` 禁止在 `turn/end` 发布过程中重入 append；`followup` 会写 inbox 事件，直接调用会抛错。
   - `idle` 边也是内置 goal 轮次驱动使用的续跑时机；在此入队后 `agent.whenIdle()` 不会提前 resolve，headless 模式也能把继续的轮次跑完。
   - 「继续」不在 `agent/status` 监听器里同步发送，而是延后一个微任务：先让 Host 发出本轮 idle 状态，再启动续跑轮次的 running 状态（顺序反了会让客户端把续跑轮次误判为“未运行”，发送按钮不切换成「停止」）。
   - 若 `turn/end` 时 inbox 已有**下一轮**条目（goal/schedule/subagent-settled 等），驱动器会直接开下一轮、不经过 idle；插件此时跳过继续并记 `next-turn-pending`，避免预算被“永远发不出去”的指令消耗。
5. **消息来源**：自动消息 `source = { kind: 'task-notifier', plugin: 'task-notifier' }`。持久化格式 v4 明确拒绝 `kind: 'plugin'`（会报 `format v4 message requires a producer-owned source kind`），所以用插件自有的 producer kind。

### 与最新 DSH 的集成

- **显示元数据**：`locale/en.json`、`locale/zh.json` 提供 `meta.title`/`meta.description`，并通过 `exports["./icon"]` 暴露 `assets/icon.png`；Plugin Manager / Settings 无需激活插件即可显示名称、描述与图标。
- **必需 `agents` 服务**：Cordis 只向声明了 `inject` 的插件暴露服务；插件声明 `inject: ['agents']` 以拿到 Agent 注册表。0.2.0 曾去掉该注入导致所有自动继续被跳过（`agent-gone`），0.2.1 已修复。
- **会话标题**：订阅持久化的 `session/title`，通知里的「会话：」优先显示 Host 标题策略生成的标题，其次才是人类 prompt 摘要与 cwd 目录名。
- **刻意不声明 `Config` schema**：官方 schema 依赖 `@deepseek-ai/schemastery`，声明它会破坏「任意路径零依赖挂载」；配置由 patch + 运行时归一化（含边界与未知键告警）保证兼容。
- **不追加自定义会话事件类型**：只读既有 `turn/start`、`step/start`、`llm/retry`、`session/title`、`turn/end`，不写新事件，满足 DSH「会话日志是唯一事实来源」的约束。

### 安全护栏

- `maxAttempts` 默认 3，硬上限 50。
- `cooldownMs` 默认 5s，避免“失败—继续—失败”紧循环；`providerRetryAfterMs` 可作为更长的等待。
- **只有 `followup()` 真正成功后才会消耗一次尝试次数**；被跳过（agent 已消失、inbox 有用户输入、下一轮待处理、被新 turn 取代）不会扣预算，通知文案也只说「已排队」。
- 以下情况跳过继续：插件禁用、失败码不在可继续集合、严格模式下非重试耗尽、次数用尽、Agent 已不在注册表、inbox 已有**用户输入**、inbox 已有下一轮条目、provider 要求等待过久、缺少轮次上下文（`no-turn-context`）。跳过原因会写入调试日志。
- 用户发来**新的人类消息**或任务成功完成时，自动继续预算重置。
- 每个会话状态在 `session/disposed` 或插件卸载时清理；定时器带 generation 校验，避免过期回调。
- 子代理会话默认静默（`notifySubagents: false`），且**永不自动继续**。
- 未知的 `turn/end` reason kind（如 `forked`）不会当作“任务完成”发通知。

## 通知通道

| 平台 | 实现 | 备注 |
| --- | --- | --- |
| Windows | `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File lib/win-toast.ps1`，优先 WinRT Toast，失败降级托盘气泡 | 标题/正文通过环境变量 `DSH_NOTIFY_TITLE`/`DSH_NOTIFY_BODY` 传入，避免命令行转义问题；XML 1.0 不允许的 C0 控制字符会先被剥离，避免 `LoadXml` 抛错。**通知身份为 DSH**：挂载时在 `HKCU\Software\Classes\AppUserModelId\DSH.TaskNotifier` 注册 `DisplayName` + `IconUri`（图标取 `assets/tray.ico`），Toast 头部显示 DSH 图标/名称；banner 图片用 `assets/icon.png`（WinRT `appLogoOverride` 不支持 `.ico`）。注册失败或旧代码未传 AUMID 时，脚本会自动探测该注册项，探测不到才退回 Windows PowerShell 身份。专注助手/通知设置可能静音。 |
| macOS | `osascript -e 'display notification …'` | 需要允许脚本发送通知 |
| Linux | `notify-send title body` | 需要桌面通知守护进程 |
| log / none | 只写本地日志 / 完全静默 | 用于调试或 CI |

通知是**尽力而为**：失败不会影响任务执行，只写 `notification.failed`/`notification.log` 与 DSH 日志。

## 调试日志

默认：`<插件目录>/state/task-notifier.log`（JSONL，UTF-8，256KB 轮转）。关键事件：

- `plugin.mounted` / `plugin.unmounted`：挂载信息、最终配置、`warnings`（非法配置）、Windows 注册结果
- `notification.dispatch` / `notification.sent` / `notification.failed` / `notification.log`
- `auto-continue.pending` / `.sent` / `.skipped` / `.cooldown` / `.error`
- `agent.status`：每次 Agent 状态切换（`running`/`idle`），用于排查续跑轮次的状态时序
- `observer.error`：事件处理异常（不会中断主流程）

PowerShell 直接读 UTF-8：`Get-Content <log> -Encoding UTF8`。

## 测试

```powershell
cd "$env:USERPROFILE\.dsh\plugins\dsh-task-notifier"
node --test test/config.test.mjs test/format.test.mjs test/observer.test.mjs test/notify.test.mjs test/win-appid.test.mjs
```

当前 79 个用例全部通过（配置归一化与边界、未知键告警、标题截断、通知文案、会话标题标签、网络/模型失败可继续判定、自动继续状态机与预算/超时/延迟入队、通道选择与降级标记、AppleScript 转义、命令执行、AUMID 注册与 OEM 编码解码、file-log 轮转）。

### 端到端验证（本机已执行）

1. **成功路径**：`test/e2e/e2e-ok.patch.yml`（OpenAI 兼容 provider，密钥走 `PROVIDER_API_KEY` 环境变量 + `channel: windows`）→ headless 返回 `exit=0`；日志出现 `notification.dispatch`（开始/完成）与 `notification.sent ... TOAST_OK`。
2. **重试耗尽 + 自动继续**：`test/e2e/e2e-continue.patch.yml`（不可达 baseURL + `maxRetries: 2`）→ 第 1/2 轮失败后分别发送 `继续`，第 3 轮达到 `maxAttempts: 2` 后停止；持久化会话中可见两轮 `user/message source={"kind":"task-notifier","plugin":"task-notifier"} text="继续"`，headless 最终以 `TRANSPORT` 退出（`exit=1`，符合预期）。
3. **Windows 图标品牌化**：注册 `DSH.TaskNotifier` 后直接调用 `win-toast.ps1` 输出 `TOAST_OK`，通知头部显示 DSH 图标与 “DSH” 名称；不传 `DSH_NOTIFY_AUMID` 时脚本自动探测注册项，同样生效。

`test/e2e/dump-session.cjs` 可解压查看会话：`node test/e2e/dump-session.cjs <session.v4.jsonl.zstd>`。

## 发布与市场索引

DSH 没有官方插件仓库：「发现」页只读取**用户自己添加的索引源**（默认关闭，需在 Plugins → Experimental plugins 打开 **Custom plugin indexes**）。本仓库在 `docs/` 下发布一份 format 1 索引：

- 索引地址（启用 GitHub Pages 后）：<https://lizhijie429.github.io/dsh-task-notifier/index.json>
- 生成/更新：`npm run market:index`（固定当前 HEAD 的 commit 与提交时间，并复制图标到 `docs/icons/`）
- 启用托管：仓库 Settings → Pages → Source 选 *Deploy from a branch* → Branch `main`、目录 `/docs`
- 用户订阅：Plugins 页 → Experimental plugins 打开 **Custom plugin indexes** → 进 Discover → Index sources 添加上面的地址 → 搜索 `dsh-task-notifier` 安装
- 索引登记的是 **Git source**，安装参数为 `git+https://github.com/lizhijie429/dsh-task-notifier.git#<commit>`；发布新版本后重新运行 `npm run market:index` 并提交 `docs/`
- 索引已用官方校验器 `@deepseek-ai/dsh-plugin-market-index` 校验通过（`parseMarketIndex` + `marketInstallTarget`）
- 也可以把插件提交到社区目录（PlugBox、awesome-dsh-plugin），但 DSH 官方不收录第三方索引
- 版本策略：行为变更递增 minor/patch（当前 `0.2.1`）；发布 npm 包后另一条安装路径为 `dsh plugin add "@lizhijie429/dsh-task-notifier"`

## 已知限制

- **Windows Toast** 依赖 PowerShell 5.1 与系统通知设置；企业镜像禁用通知时只会有日志。
- **Windows 10（build < 22000）** 对未打包应用的 AUMID 要求存在对应的开始菜单快捷方式；若发现通知仍显示 “Windows PowerShell”，可在开始菜单创建指向本插件 `assets\tray.ico` 的快捷方式，或接受回退身份（通知本身不受影响）。Windows 11 使用 HKCU 注册项即可生效（本机已验证）。
- 通知是异步 fire-and-forget，不保证在进程退出前送达（headless 极短任务可能只看到 `notification.dispatch`）。
- 默认不把模型输出预览写进通知（`includePreview: false`）；开启后内容会出现在锁屏/通知中心，敏感场景请保持关闭。
- 若 `turn/end` 之后 inbox 已有下一轮条目，自动继续会被跳过（`next-turn-pending`）——会话本身会继续跑，不需要额外提示；若 provider 要求等待超过 120s（`providerRetryAfterMs`），同样跳过，避免无效续跑。
- `channel: windows` 只在 Windows 生效；其他平台请用 `auto` 或 `log`。
- 自动继续覆盖网络与模型请求类失败（`TRANSPORT`、`TIMEOUT`、`RATE_LIMIT`、`SERVER`、`PI_AI_ERROR` 等）；`AUTH`、`UNKNOWN`、用户取消等不会继续。若把 `requireRetryExhausted` 设为 `true`，则只继续“重试预算耗尽”的失败。
- 如果用户在失败后立刻手动输入，插件检测到待处理的**用户输入**会跳过继续，可能表现为“没有自动继续”（属于预期保护）；后台任务通知、时间快照等系统消息不会阻止继续。
- `desktop` profile 依赖 Electron 桌面端运行插件；`dsh plugin` CLI 不适用于该 profile。
- 未声明 `Config` schema（保持零依赖），Settings 页没有本插件的图形化配置表单；请直接编辑 profile 的 `cordis.patch.yml`。
- 修改插件代码后，运行中的桌面端不会自动重载已加载的 ESM 模块；重启一次 DeepSeek Harness 后新代码生效（图标品牌化已通过 `win-toast.ps1` 自探测兼容旧挂载，无需重启即可看到 DSH 图标）。
