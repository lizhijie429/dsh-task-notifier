# DSH 任务通知（dsh-task-notifier）

> [English](README.en.md) | 中文

## 插件介绍

`dsh-task-notifier` 是 DeepSeek Harness（DSH）的 Host 插件：它订阅**持久化的会话事件**，在任务结束、需要你审批或提问时发送操作系统通知，并在网络/模型请求失败导致任务中断时自动发送「继续」，让长任务不必一直盯着屏幕。

**核心能力**

- **任务状态通知**：完成、失败、取消、阻塞、达到输出上限、意外中断；
- **需要你操作时提醒**：DSH 审批面板等待授权、`ask_user_question` 提问、计划模式 `exit_plan_mode` 待审批；
- **提醒不丢失**：审批/提问未被处理时按 `reminderMs` 重复提醒（默认 1 分钟，最多 5 次），并带提示音；处理后立即停止；
- **点击回到 DSH**：Windows Toast 点击执行 `dsh://open` 并显示「打开 DSH」动作；
- **自动继续**：网络/模型请求失败后，在 Agent 空闲边自动发送「继续」（预算、冷却、provider 重试延迟均可配置）；
- **可读性**：标题带短会话标签，支持中英文文案与各状态图标；
- **隐私与安全**：`privacyMode` 隐藏锁屏详情；通知子进程只带最小环境变量；日志保留完整正文用于排障；
- **零依赖、多平台**：只用 Node 内置模块，支持 Windows / macOS / Linux / 纯日志通道。

**实现方式**

- 只读既有会话事件：`turn/start`、`step/start`、`llm/retry`、`session/title`、`turn/end`、`approval/*`、`tool/call`、`tool/result`、`tool/ptc-dispatch*`；
- 不追加自定义会话事件，不写会话日志，不修改系统通知之外的状态；
- 自动消息使用插件自有的 producer kind（`task-notifier`），兼容持久化格式 v4。

**兼容性与验证**

- 要求 DSH `>=0.2.1-0 <0.3.0`（已在 `0.2.2-rc.1` 实机验证）；Node.js 要求与 DSH 一致（0.2.2 起为 24.9+）；
- 149 个单元测试（148 通过 + 1 个 POSIX 文件权限用例在 Windows 跳过），CI 覆盖 Ubuntu / Windows / macOS；
- **图形化设置页**：DSH 设置 → 任务通知，或插件页该行的**配置**按钮；改动写入 DSH 设置层并实时生效（通道/图标/日志路径等挂载期选项除外）。
- 已收录到自定义插件索引：<https://lizhijie429.github.io/dsh-task-notifier/index.json>。

## 安装方式

### 方式一：直接挂载到 `desktop` profile（当前桌面端推荐）

`desktop` profile 由 Electron 桌面端占用，`dsh plugin` 等 CLI 会拒绝它，因此直接编辑用户补丁层 `$env:USERPROFILE\.dsh\profiles\desktop\cordis.patch.yml`，追加一行（把 `<插件目录>` 换成实际绝对路径）：

```yaml
- insert:
    - id: task-notifier
      name: '<插件目录>\index.mjs'
      config:
        channel: auto
        notifyOnStart: false
        notifyOnComplete: true
        notifyOnError: true
        notifyOnAbort: false
        notifyOnStep: false
        notifySubagents: false
        notifyOnApproval: true
        approvalGraceMs: 1000
        notifyOnQuestion: true
        questionGraceMs: 1000
        locale: zh
        reminderMs: 60000
        reminderMax: 5
        actionSound: true
        clickUrl: dsh://open
        titleSessionLabel: true
        privacyMode: false
        titlePrefix: DSH
        maxBodyChars: 240
        includePreview: false
        autoContinue:
          enabled: true
          message: 继续
          maxAttempts: 3
          cooldownMs: 5000
          requireRetryExhausted: false
```

- `name` 必须是**绝对路径**（也支持 `file://` URL）；使用包名时需确保该包已在 profile 依赖中；
- 保存后 `desktop` profile 默认支持 live 热加载；若未挂载，重启一次 DeepSeek Harness；
- 验证：插件目录下 `state/task-notifier.log` 出现 `plugin.mounted`，且 `agentsAvailable: true`；
- **图形化配置**：挂载后打开 **DSH 设置 → 任务通知**，或插件页中该插件的**配置**按钮。页面会读取并编辑同一份配置，保存到 DSH 设置层（优先于 profile patch），无需手改 YAML。

### 方式二：作为插件包安装到普通 profile（web / headless / 自建）

```powershell
# 已发布到 npm 时
dsh plugin --profile web add "@lizhijie429/dsh-task-notifier"

# 直接安装 GitHub 仓库（无构建步骤）
dsh plugin --profile web add "github:lizhijie429/dsh-task-notifier"

# 从本地目录安装
dsh plugin --profile web add "file:$env:USERPROFILE\.dsh\plugins\dsh-task-notifier"
```

`package.json` 的 `dsh.bundle.patch` 会加载 `cordis.patch.yml` 中的默认配置（id 为 `task-notifier`）；需要覆盖时在 profile 自己的 patch 中按同一 id 写 `config`。

### 方式三：临时验证（不改任何 profile）

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

### 升级与卸载

- 升级：替换插件目录内容（或重新安装同一包）后重启 DeepSeek Harness；ESM 代码不会被热重载；
- 卸载：删除 profile patch 中对应行（bundle 安装则卸载包）并重启；Windows 的 `DSH.TaskNotifier` AUMID 注册项会保留，可按需手动清理。

## 通知场景

### 任务生命周期

一个 `turn` 只发一次终态通知（多步工具调用不会重复提醒）：

| `turn/end` 原因 | 通知标题 | 默认 |
| --- | --- | --- |
| `completed` | ✅ 任务完成（附耗时、步数、可选预览） | ✅ |
| `error` | ❌ 任务失败（附失败码/信息、自动继续结果） | ✅ |
| `blocked` | ⛔ 任务被阻塞 | ✅ |
| `max-tokens` | ⚠️ 任务达到输出上限 | ✅ |
| `interrupted` | ⚠️ 任务意外中断 | ✅ |
| `aborted` | ⏹️ 任务已取消（可带取消原因） | 默认关（`notifyOnAbort`） |
| 未知 kind（如 `forked`） | 不通知 | — |

`notifyOnStart` 可通知任务开始，`notifyOnStep` 可逐步通知（默认关，避免刷屏）。

### 审批等待（需要你授权）

- 订阅持久化 `approval/asked`，在 `approvalGraceMs`（默认 1 秒）后仍未决策才通知，避免 `policy: never` 自动拒绝、自动通过、取消等场景打扰；
- 通知内容：会话、工具名、审批原因（`privacyMode` 可隐藏），标题「🔐 需要授权」；
- `approval/decided` 到达后立即清理；若仍未处理，按 `reminderMs` 重复提醒；
- 通知只是提醒，**不含批准/拒绝按钮**，实际授权需在 DSH 审批面板完成。

### 用户提问与计划审批（需要你操作）

- 识别 `ask_user_question`（原生 `tool/call` 与 PTC `tool/ptc-dispatch-start`）与计划模式 `exit_plan_mode`；
- 宽限期 `questionGraceMs`（默认 1 秒）内被回答则静默；仍挂起才通知，标题「❓ 需要你操作」，正文含类型、问题数、首问/计划标题；
- timed 提问如果在前台等待超时返回 `pending`（问题仍可回答），会补发一次「状态：超时后仍可回答」，每个提问最多提醒一次（不含重复提醒）；
- 回答入口仍在 DSH 会话中，通知不含作答控件。

### 自动继续（失败恢复）

- 触发条件：`turn/end` 为 `error`，失败码属于网络/模型请求类（默认 `retryableCodes`），或 `UNKNOWN` 但失败信息呈网络特征；
- 默认 `requireRetryExhausted: false`：网络/模型失败直接继续；设为 `true` 时仅继续“重试预算耗尽”的失败；
- 在 `agent/status` 的 `idle` 边通过 `agent.followup()` 入队，延后一个微任务发送，避免客户端把续跑轮次误判为未运行；
- 预算 `maxAttempts`（默认 3，硬上限 50）、冷却 `cooldownMs`（默认 5 秒）、`providerRetryAfterMs`（>120 秒则跳过）；
- 以下情况跳过并写调试日志：插件禁用、失败码不可继续、重试未耗尽（严格模式）、次数用尽、Agent 已消失、inbox 有**用户输入**（含 DSH 0.2.2 的 `user-question-reply`）、下一轮已排队、provider 要求等待过久、严格模式缺少轮次上下文。

### 提醒、标题与点击

- `reminderMs` 默认 60000（1 分钟），每个审批/提问最多 `reminderMax`（默认 5）次提醒，处理后停止；`0` 关闭；
- **审批/提问/计划审批属于“需要你操作”的提醒，不区分 DSH 是否在前台**：插件不做前台抑制，首次通知在宽限期（默认 1 秒，用于过滤自动决策）后立即发出，并且：
  - Windows Toast 附带系统提示音（`actionSound: true`，可用 `false` 关闭）；
  - macOS 通知附带 `Glass` 提示音；
  - Linux `notify-send` 使用 `-u critical` 紧急级别；
- 多任务并行时建议保留默认的 1 分钟 × 5 次提醒；若系统开启了勿扰/专注助手，横幅仍可能被系统静音，但声音与重复提醒会持续提示；
- Windows Toast 点击执行 `clickUrl`（默认 `dsh://open`，聚焦 DSH）并显示「打开 DSH」按钮；macOS/Linux 点击行为由系统决定。
- 标题默认附加 ≤12 字符的短会话标签（如 `DSH · ✅ 任务完成 · 设计器任务`），`titleSessionLabel: false` 可关闭；

### 子代理会话

- `notifySubagents: false`（默认）时子代理的 start/step/完成/失败/审批/提问通知全部静默；
- 开启后标签为 `子代理 <id>（父 <id>）`，完成通知同样带耗时/步数；子代理**永不自动继续**。

### 隐私模式

`privacyMode: true` 时 OS 通知隐藏审批原因、提问内容、失败详情等敏感信息，正文只提示「详情请在 DSH 中查看」；调试日志**仍保留完整副本**。

## 配置参考

所有字段均可写在 profile patch 的 `config:` 块中；未写的字段回退默认值（补丁会整体替换该行的 `config`，不是深合并）。

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `notifyOnStart` | `false` | `turn/start` 时通知 |
| `notifyOnComplete` | `true` | `completed` / `max-tokens` 通知 |
| `notifyOnError` | `true` | `error` / `blocked` / `interrupted` 通知 |
| `notifyOnAbort` | `false` | 用户取消（`aborted`）通知 |
| `notifyOnStep` | `false` | 每步 `step/start` 通知（调试用） |
| `notifySubagents` | `false` | 是否通知子代理会话 |
| `notifyOnApproval` | `true` | 审批等待提醒 |
| `approvalGraceMs` | `1000` | 审批宽限期（0–60000ms） |
| `notifyOnQuestion` | `true` | 提问/计划审批提醒 |
| `questionGraceMs` | `1000` | 提问宽限期（0–60000ms） |
| `locale` | `zh` | 文案语言：`zh` / `en` / `auto`（跟随 `DSH_LOCALE`/`LC_ALL`/`LANG`） |
| `reminderMs` | `60000` | 未处理审批/提问的重复提醒间隔（0–3600000ms，0 关闭） |
| `reminderMax` | `5` | 每个未处理审批/提问最多提醒次数（0–10，0 只发首次通知） |
| `actionSound` | `true` | 审批/提问/计划审批通知是否播放提示音（Windows Toast 声音、macOS Glass 声音；Linux 始终 critical） |
| `clickUrl` | `dsh://open` | Windows Toast 点击/动作目标；仅允许 `dsh:`/`http:`/`https:`，`false` 关闭 |
| `titleSessionLabel` | `true` | 标题末尾追加 ≤12 字符短会话标签 |
| `privacyMode` | `false` | OS 通知隐藏敏感详情；日志仍完整 |
| `channel` | `auto` | `auto` / `windows` / `macos` / `linux` / `log` / `none` |
| `titlePrefix` | `DSH` | 标题前缀（≤60 字符） |
| `windowsAppId` | `DSH.TaskNotifier` | Windows Toast 的 AppUserModelID |
| `windowsAppName` | `DSH` | Windows Toast 显示的应用名 |
| `maxBodyChars` | `240` | 正文裁剪长度（60–2000） |
| `includePreview` | `false` | 是否附模型输出预览（锁屏隐私） |
| `logFile` | `<插件目录>/state/task-notifier.log` | JSONL 调试日志；相对路径按插件目录解析；256KB 轮转为 `.1` |
| `autoContinue.enabled` | `true` | 是否允许自动继续 |
| `autoContinue.message` | `继续` | 自动发送的消息内容 |
| `autoContinue.maxAttempts` | `3` | 每个任务最多自动继续次数（硬上限 50） |
| `autoContinue.cooldownMs` | `5000` | 两次自动继续的最小间隔（0–600000ms） |
| `autoContinue.requireRetryExhausted` | `false` | `false`：网络/模型失败直接继续；`true`：仅重试预算耗尽时继续 |
| `autoContinue.respectProviderRetryAfter` | `true` | 遵循 `providerRetryAfterMs`（>120s 跳过） |
| `autoContinue.retryableCodes` | `EMPTY_RESPONSE,RATE_LIMIT,SERVER,TIMEOUT,TRANSPORT,PI_AI_ERROR,AI_ERROR,PROVIDER,MODEL,OVERLOADED,NETWORK,CONNECTION,ECONNRESET,ECONNREFUSED,ETIMEDOUT,ENOTFOUND,EAI_AGAIN,SOCKET` | 可继续的失败码 |

**配置校验**：非法值逐项回退默认值并告警；未知键（手写 patch 拼写错误）同样告警；告警写入 Host 日志与调试日志的 `config.warning`，并汇总到 `plugin.mounted` 的 `warnings` 字段。

**调试日志**（排障依据）：默认 `<插件目录>/state/task-notifier.log`，JSONL、UTF-8、256KB 轮转；POSIX 权限 `0600`（Windows 继承用户目录 ACL）。日志**保留完整通知标题与正文**，请勿直接公开分享。关键事件包括 `plugin.mounted`、`notification.dispatch/sent/failed`、`auto-continue.*`、`approval.*`、`question.*`、`channel.fallback`、`agent.status`、`observer.error`。

> **图形化设置**：插件声明了 `Config` schema（vendored schemastery/cosmokit，MIT，避免外部路径挂载解析 Host 包），所有字段都是 `.volatile()`，因此 DSH 设置页可以读取并实时写入。页面入口：**设置 → 任务通知**（Settings 侧栏），或插件页该行的**配置**按钮。保存写入 DSH 设置层，优先级高于 profile 的 `cordis.patch.yml`；页面里的「放弃修改」只丢弃草稿，要恢复 patch 值需要在设置层重置或清空对应值。`.volatile()` 之外没有“普通配置”，因此不需要重启即可应用大部分选项。

## 通知通道

| 平台 | 实现 | 说明 |
| --- | --- | --- |
| Windows | `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File lib/win-toast.ps1`，优先 WinRT Toast，失败降级托盘气泡 | 标题/正文通过环境变量传入，避免命令行转义；XML 1.0 非法控制字符会先剥离。通知身份为 DSH：挂载时在 `HKCU\Software\Classes\AppUserModelId\DSH.TaskNotifier` 注册 `DisplayName` + `IconUri`，Toast 头部显示 DSH 图标/名称；banner 使用 `assets/icon.png`。点击执行 `clickUrl`（默认 `dsh://open`）并显示「打开 DSH」。注册失败或旧挂载未传 AUMID 时自动探测该注册项，探测不到才退回 PowerShell 身份。 |
| macOS | `osascript -e 'display notification …'` | 需要在系统设置中允许脚本发送通知；不支持自定义动作/图标 |
| Linux | `notify-send -a <titlePrefix> -i assets/icon.png -- title body` | 需要桌面通知守护进程；`--` 防止以 `-` 开头的标题被当作选项 |
| log / none | 只写本地日志 / 完全静默 | 用于调试、CI 或无桌面环境 |

**通道探测与回退**：`channel: auto`（以及显式 `windows`/`macos`/`linux`）会在挂载时检查对应系统命令是否存在；不可用时自动回退 `log`，写 `channel.fallback` 并在 Host 日志告警，避免每次通知都静默失败。`plugin.mounted` 会记录 `channelRequested` / `channel` / `channelFallback`。

**投递策略**：通知是尽力而为、异步 fire-and-forget，失败不影响任务执行。队列上限 20，满时按优先级丢弃：`step`/`start` → `complete` → 其他终态，**审批/提问提醒最后才丢**。进度类 Toast 超时 6 秒，终态 12 秒；Windows 超时会用 `taskkill /T /F` 终止整棵子进程树。

**子进程最小环境变量**：PowerShell / osascript / notify-send / reg.exe / taskkill 只继承 PATH、SystemRoot/TEMP、HOME、DISPLAY/DBUS、LANG/LC_* 等必要变量，不会拿到 Host 的 provider 凭据或 token。

## 已知限制

- **Windows Toast 依赖**：需要 PowerShell 5.1 与系统通知设置；企业镜像禁用通知、专注助手/勿扰模式开启时只会有日志。Windows 10（build < 22000）对未打包应用的 AUMID 可能要求开始菜单快捷方式，否则显示回退身份（通知本身仍可用）。
- **异步投递**：fire-and-forget，不保证进程退出前送达；headless 极短任务可能只看到 `notification.dispatch`。
- **通知队列有界**：极端风暴下会丢弃低优先级通知；多会话同时故障时终态通知仍可能排队延迟。
- **未覆盖的通知场景**：后台任务 `job/settled`（DSH 应用内已有通知）、turn 之外的维护错误 `agent/error`、自定义插件直接调用 `userQuestions` 且不产生工具调用事件的提问，均不会触发本插件通知。
- **内容可见性**：默认通知正文含会话标题、审批工具/原因、提问摘要、失败信息，可能出现在锁屏/通知中心；敏感环境请设 `privacyMode: true`。日志按排障需要**保留完整正文**（POSIX `0600`，Windows 用户 ACL），分享前请自行脱敏。
- **无决策按钮/会话深链**：通知不含批准/拒绝/回答按钮；点击动作仅 Windows 生效，且只能聚焦 DSH（`dsh://open`），不能定位到具体会话；macOS/Linux 点击行为由系统决定。
- **提醒次数有限**：默认每 1 分钟提醒一次、最多 5 次（`reminderMax` 可调）；处理完成后停止；插件在 `approval/asked` 或 `tool/call` 之后才挂载时不会补发该次提醒。
- **前台提醒依赖系统通知设置**：插件本身不做前台抑制，审批/提问/计划审批在宽限期后始终发送；但 Windows 专注助手/勿扰、macOS 专注模式、Linux 桌面通知守护进程仍可能静音横幅或声音。`actionSound` 可关闭提示音；如需更强的系统级提醒，需在操作系统通知设置中允许 DSH 通知。
- **子代理**：默认静默；开启 `notifySubagents` 后才会通知，且子代理永不自动继续。
- **自动继续范围**：只针对网络/模型请求类失败；`AUTH`、无网络特征的 `UNKNOWN`、用户取消等不会继续。严格模式依赖本轮 `llm/retry` 链；热加载后缺少轮次上下文时严格模式会跳过。自动预算保存在内存中，进程重启后重置。
- **语言与标题**：文案仅 `zh`/`en`；`locale: auto` 只读取 Host 环境变量，不读取单个 Web 客户端的语言设置。标题短标签最多 12 字符，超出以 `…` 截断。
- **通道探测边界**：只确认系统命令存在，无法校验系统通知权限、桌面通知守护进程是否真的在运行。
- **图形化设置页的实时范围**：设置保存后大部分选项立即生效；通知通道探测、Windows AUMID 注册、日志文件句柄在挂载时确定，修改 `channel`/`windowsAppId`/`windowsAppName`/`logFile` 后需重载插件（重启 DSH 或重新保存触发重载）。设置写入 DSH 设置层，优先级高于 profile patch；如需回到 patch 值，请在设置页重置或清除该字段。
- **命令行 overlay 优先级更高**：用 `dsh --patch <file>` 临时注入的配置属于更高优先级层，设置页对这类行的写入会被 Host 拒绝（页面显示「保存冲突或 Host 拒绝了修改」）；这是 DSH 的保护行为，正常 profile patch 安装不受影响。
- **AUMID 清理**：卸载插件不会自动删除 `HKCU\Software\Classes\AppUserModelId\DSH.TaskNotifier`，需要时可手动删除。
- **代码更新需重启**：运行中的桌面端不会热重载已加载的 ESM 模块；升级插件后重启一次 DeepSeek Harness。
- **版本范围**：要求 DSH `>=0.2.1-0 <0.3.0`；DSH 0.3 及以上需要先升级插件版本。

