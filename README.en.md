# dsh-task-notifier

A DSH (DeepSeek Harness) plugin that watches task execution (one task = one `turn`), raises a **OS-level notification** when the task finishes or fails, and — when the failure is caused by an exhausted model-request retry budget — automatically sends `继续` ("continue") to the session so the agent keeps working.

- npm package: `@lizhijie429/dsh-task-notifier`; source: <https://github.com/lizhijie429/dsh-task-notifier>.
- Zero runtime dependencies, plain ESM, single directory. Mount it by absolute path — no build or install step.
- Notification channels: Windows Toast (PowerShell 5.1 / WinRT), macOS `osascript`, Linux `notify-send`, or plain logging.
- **Windows toasts are branded as DSH** (registers the `DSH.TaskNotifier` AUMID), no longer "Windows PowerShell".
- Task state is derived only from **durable session events** (`turn/start`, `llm/retry`, `turn/end`) — no guessing from live status.
- Approval alerts: a durable `approval/asked` that is still pending after the grace window raises an OS notification; automatic decisions stay silent.

## Directory layout

```text
dsh-task-notifier/
├── index.mjs              # Cordis plugin entry: logging, config, observer, event wiring
├── package.json           # dsh.bundle.patch points at the bundle patch (bundle installs)
├── cordis.patch.yml       # bundle patch: inserts the default task-notifier row
├── lib/
│   ├── config.mjs         # defaults, validation, normalization (fallback + warning)
│   ├── format.mjs         # event classification, failure codes, notification copy, retry-exhaustion check
│   ├── notify.mjs         # channel selection, command execution, AppleScript builder
│   ├── win-appid.mjs      # Windows notification identity (AUMID) registration + icon lookup
│   ├── win-toast.ps1      # Windows Toast (WinRT) with tray-balloon fallback
│   ├── file-log.mjs       # JSONL debug log (batched writes + 256 KB rotation)
│   └── observer.mjs       # per-session turn state machine + auto-continue
├── assets/
│   ├── tray.ico           # notification identity icon (shell icon)
│   └── icon.png           # appLogoOverride image inside the toast
└── test/
    ├── config.test.mjs
    ├── format.test.mjs
    ├── notify.test.mjs
    ├── observer.test.mjs
    └── e2e/               # local end-to-end patches and scripts (not part of unit tests)
```

## Installation

### Option 1: mount into the `desktop` profile (recommended for the current desktop app)

The `desktop` profile is owned by the Electron app, so `dsh plugin` / `--dump-config` reject it. Edit the user patch layer `$env:USERPROFILE\.dsh\profiles\desktop\cordis.patch.yml` directly (replace `<user>` with your Windows user name) and append:

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

- `name` must be an **absolute path** (or a file URL). A package name also works, but the package must be a dependency of the profile.
- After saving: the `desktop` profile's `patchReload` defaults to `live`, so the running app usually hot-loads the plugin. If not, restart DeepSeek Harness.
- Verify: `state/task-notifier.log` contains `plugin.mounted`.

You can also override `config` for the same `id` in your own profile (a patch **replaces** that row's `config` as a whole; omitted fields fall back to plugin defaults).

### Option 2: install as a bundle into a regular profile (web / headless / custom)

After the npm publish (see "Publishing" at the end):

```powershell
dsh plugin --profile web add "@lizhijie429/dsh-task-notifier"
```

Install straight from GitHub (no npm publish needed; the plugin has no build step):

```powershell
dsh plugin --profile web add "github:lizhijie429/dsh-task-notifier"
```

Install from a local checkout:

```powershell
cd "$env:USERPROFILE\.dsh\plugins\dsh-task-notifier"
dsh plugin --profile web add "file:$PWD"
```

`dsh.bundle.patch` in `package.json` makes the profile load the defaults from `cordis.patch.yml` (id `task-notifier`); `engines.dsh` requires DSH `>=0.2.1`.

### Option 3: ad-hoc verification (touches no profile)

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

## Configuration

| Field | Default | Description |
| --- | --- | --- |
| `notifyOnStart` | `false` | Notify on `turn/start` (noisy; off by default) |
| `notifyOnComplete` | `true` | Notify when `turn/end` has `reason.kind` = `completed` / `max-tokens` |
| `notifyOnError` | `true` | Notify on `error` / `blocked` / `interrupted` |
| `notifyOnAbort` | `false` | Notify when the user aborts (`aborted`) |
| `notifyOnStep` | `false` | Notify on every `step/start` (debugging) |
| `notifySubagents` | `false` | Notify subagent sessions too (main session only by default) |
| `notifyOnApproval` | `true` | Notify when the DSH approval panel is waiting for your decision |
| `approvalGraceMs` | `1000` | Approval grace window: approvals auto-answered within it (policy `never`, automatic grants, cancellation) stay silent |
| `channel` | `auto` | `auto` / `windows` / `macos` / `linux` / `log` / `none` |
| `titlePrefix` | `DSH` | Notification title prefix (≤60 chars; longer values are truncated with a warning) |
| `windowsAppId` | `DSH.TaskNotifier` | AppUserModelID for Windows toasts (app name/icon in the toast) |
| `windowsAppName` | `DSH` | App display name for Windows toasts |
| `maxBodyChars` | `240` | Body truncation length (60–2000) |
| `includePreview` | `false` | Include the model-output preview in notifications (off by default: lock-screen privacy) |
| `logFile` | `<plugin dir>/state/task-notifier.log` | JSONL debug log; relative paths resolve against the plugin dir; rotates at 256 KB to `.1` |
| `autoContinue.enabled` | `true` | Allow automatic continuation |
| `autoContinue.message` | `继续` | User message sent automatically |
| `autoContinue.maxAttempts` | `3` | Max continuations per task (hard cap 50) |
| `autoContinue.cooldownMs` | `5000` | Min gap between two continuations; `0` = immediate |
| `autoContinue.requireRetryExhausted` | `false` | `false` by default: network/model-request failures (`TRANSPORT`, `TIMEOUT`, `RATE_LIMIT`, `SERVER`, the provider's `PI_AI_ERROR`, …) always continue; `true` restricts continuation to exhausted retry budgets |
| `autoContinue.respectProviderRetryAfter` | `true` | Honor `providerRetryAfterMs` as a minimum wait (>120 s skips the continuation) |
| `autoContinue.retryableCodes` | `EMPTY_RESPONSE,RATE_LIMIT,SERVER,TIMEOUT,TRANSPORT,PI_AI_ERROR,AI_ERROR,PROVIDER,MODEL,OVERLOADED,NETWORK,CONNECTION,ECONNRESET,ECONNREFUSED,ETIMEDOUT,ENOTFOUND,EAI_AGAIN,SOCKET` | Failure codes treated as continuable (network / model-request class) |

Invalid configuration never throws: each field falls back to its default, the warnings go to the Host log and to the debug log as `config.warning` events, and `plugin.mounted` carries them in a `warnings` field. Unknown keys (typos in a hand-written patch) are reported too instead of being silently ignored.

## Decision logic

1. **Task = one `turn`**: multi-step tool calls are still one turn; exactly one notification is emitted on `turn/end`.
2. **State classification** (`reason.kind`):
   - `completed` → ✅ task finished (duration, steps, last assistant text preview)
   - `error` → ❌ task failed (failure code/message)
   - `aborted` → ⏹️ task cancelled (optional; cancellation cause)
   - `blocked` → ⛔ task blocked
   - `max-tokens` → ⚠️ task hit the output limit
3. **Whether a failure earns a continuation** (`lib/observer.mjs#decideContinuation`):
   - the failure must be an `error` whose code is in `retryableCodes`; anything else is skipped with "the failure is not a continuable type" (`AUTH`, `UNKNOWN`, … never continue);
   - `requireRetryExhausted` defaults to `false`: network and model-request failures continue right away (e.g. `TRANSPORT: Connection error.` and the provider's `PI_AI_ERROR`) — this is what the desktop profile relies on;
   - `UNKNOWN` fallback: DSH wraps non-`LlmError` throws as `UNKNOWN`; when the message is network-shaped (`connection/network/socket/timeout/fetch failed/ECONN*/EAI_AGAIN/TLS`, …) the plugin still continues once;
   - **mounting mid-turn**: after a hot reload the plugin never saw `turn/start`; non-strict mode continues from the durable failure code, while strict mode (`requireRetryExhausted: true`) needs the retry chain and skips with "missing turn context";
   - with `requireRetryExhausted: true` the stricter rule applies: the turn must contain `llm/retry` events and the last one must satisfy `retry >= maxRetries` (normal-mode budget exhausted); with no `llm/retry` events the first request failed outright (`maxRetries: 0` or a transient failure), which also counts as exhausted;
   - `always` mode never "exhausts", so it never triggers auto-continue in strict mode;
   - a failure carrying `providerRetryAfterMs` delays the continuation by that amount; delays over 120 s skip it (`autoContinue.respectProviderRetryAfter`).
4. **Where continuation is admitted**: on the `agent/status` `idle` edge, via `agent.followup()` — not inside the `turn/end` listener.
   - Reason: `Session.append()` forbids re-entrant appends while `turn/end` is being published; `followup` writes inbox events, so calling it directly throws.
   - The `idle` edge is also what the built-in goal-round driver uses. Enqueuing there keeps `agent.whenIdle()` unresolved until the continuation turn runs, so headless runs also finish the continuation turn.
   - The prompt is admitted one microtask after the `agent/status` listener returns: the Host must emit this turn's idle transition before the continuation turn's running transition (the reverse order makes clients treat the continuation turn as not running, so the composer keeps showing Send instead of Stop).
   - If the inbox already holds a **next-turn** entry (goal/schedule/subagent-settled), the driver starts that turn immediately without an idle edge; the plugin then skips with `next-turn-pending` instead of burning an attempt on a prompt that could never be admitted.
5. **Message source**: automatic messages use `source = { kind: 'task-notifier', plugin: 'task-notifier' }`. Persisted format v4 explicitly rejects `kind: 'plugin'` (`format v4 message requires a producer-owned source kind`), so the plugin uses its own producer kind.
6. **Notification labels**: `turn/start` no longer clears the label, so continuation turns keep the latest human prompt instead of falling back to the workspace folder name; a durable `session/title` still wins when present.
7. **Sub-agents**: with `notifySubagents: false` (default) a sub-agent session's start/step/complete/error notifications are all suppressed; when enabled their label is `sub-agent <id> (parent <id>)`, distinguishable from the main session, and sub-agents never auto-continue.
8. **Approval alerts**: subscribes to durable `approval/asked`; when `approval/decided` arrives inside the grace window (`approvalGraceMs`, default 1 s — policy `never` auto-reject, automatic grants, cancellation) the alert stays silent, and only a genuinely pending approval raises an OS notification (title `🔐 approval needed`, body with tool name and reason). The toast is a reminder only; approving still happens in the DSH approval panel.

### Integration with current DSH

- **Display metadata**: `locale/en.json` and `locale/zh.json` provide `meta.title`/`meta.description`, and `exports["./icon"]` exposes `assets/icon.png`; Plugin Manager / Settings show the name, description and icon without activating the plugin.
- **Required `agents` service**: Cordis only exposes a service to plugins that declare it in `inject`; the plugin declares `inject: ['agents']` to read the Agent registry. 0.2.0 had dropped that injection, so every continuation was skipped as `agent-gone`; 0.2.1 restores it.
- **Session titles**: subscribes to durable `session/title`; the notification's session label prefers the Host-generated title, then the human prompt summary, then the cwd folder name.
- **No `Config` schema by design**: the official schema depends on `@deepseek-ai/schemastery`, which would break zero-dependency mounting from an arbitrary path; configuration stays patch-driven with runtime normalization (bounds + unknown-key warnings).
- **No custom session event types**: reads only the existing `turn/start`, `step/start`, `llm/retry`, `session/title`, `turn/end` events and never appends new ones, honoring DSH's "the session log is the only source of truth".

### Safety rails

- `maxAttempts` defaults to 3, hard cap 50.
- `cooldownMs` defaults to 5 s, preventing a tight "fail → continue → fail" loop; `providerRetryAfterMs` can extend the wait.
- **An attempt is consumed only after `followup()` actually succeeds.** Skips (agent gone, pending human input, queued next turn, superseded by a new turn) leave the budget untouched, and the notification says "queued" rather than "sent".
- Continuation is skipped when: the plugin is disabled, the code is not continuable, strict mode has no exhausted retries, attempts are used up, the agent left the registry, the inbox already holds **user input** or a next-turn entry, the provider asks to wait too long, or strict mode has no turn context. Skip reasons are written to the debug log.
- The "queued `继续` / not continued" outcome is **always kept** in the error body (placed before the reason, so a verbose provider error cannot truncate it).
- Notification queue cap 20: when full, the oldest `step`/`start` entry is dropped first; terminal notifications are never dropped before progress ones. Progress toasts time out after 6 s, terminal ones after 12 s.
- Debug-log writes are batched: lines are buffered, then flushed on the next tick, at 200 lines, or on plugin unload (`log.flush()`), with rotation checked per write chunk — no synchronous I/O per session event.
- A timed-out Windows toast kills the whole child tree with `taskkill /T /F` (no PowerShell/conhost leftovers); the Linux `notify-send` application name comes from `titlePrefix` (default `DSH`).
- One instance per process: when a profile patch inserts the same id twice, the later mount is skipped with a warning so notifications and continuations cannot be doubled.
- A **new human message** or a successful `completed` turn resets the continuation budget.
- Per-session state is cleaned up on `session/disposed` or plugin unload; timers carry a generation check to ignore stale callbacks.
- Subagent sessions are silent by default (`notifySubagents: false`) and never auto-continue.
- Unknown `turn/end` reason kinds (e.g. `forked`) are not reported as success.

## Notification channels

| Platform | Implementation | Notes |
| --- | --- | --- |
| Windows | `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File lib/win-toast.ps1`, WinRT Toast first, tray balloon fallback | Title/body travel via the `DSH_NOTIFY_TITLE` / `DSH_NOTIFY_BODY` environment variables, avoiding command-line escaping; C0 control characters (illegal in XML 1.0) are stripped first so `LoadXml` cannot throw. **The notification identity is DSH**: on mount the plugin registers `DisplayName` + `IconUri` (icon = `assets/tray.ico`) under `HKCU\Software\Classes\AppUserModelId\DSH.TaskNotifier`, so the toast header shows the DSH icon/name; the banner image uses `assets/icon.png` because WinRT `appLogoOverride` does not accept `.ico`. If registration fails or an older mount passes no AUMID, the script probes that registry key and only then falls back to the Windows PowerShell identity. Focus Assist/notification settings may mute it. |
| macOS | `osascript -e 'display notification …'` | Scripts must be allowed to send notifications |
| Linux | `notify-send -a <titlePrefix> title body` | Requires a desktop notification daemon |
| log / none | Log only / fully silent | For debugging or CI |

Notifications are **best-effort**: a failure never affects task execution; it is only recorded as `notification.failed`/`notification.log` and in the DSH log.

## Debug log

Default: `<plugin dir>/state/task-notifier.log` (JSONL, UTF-8, 256 KB rotation; lines are buffered and flushed in batches, forced on plugin unload). Key events:

- `plugin.mounted` / `plugin.unmounted`: mount info, final config, `warnings` (invalid config), Windows registration result
- `notification.dispatch` / `notification.sent` / `notification.failed` / `notification.log`
- `auto-continue.pending` / `.sent` / `.skipped` / `.cooldown` / `.error`
- `approval.asked` / `approval.notified` / `approval.decided`: approval alert grace, notification and decision
- `agent.status`: every Agent status transition (`running`/`idle`), for diagnosing continuation-turn status ordering
- `observer.error`: event-handling exceptions (never break the main flow)

Read UTF-8 directly in PowerShell: `Get-Content <log> -Encoding UTF8`.

## Tests

```powershell
cd "$env:USERPROFILE\.dsh\plugins\dsh-task-notifier"
node --test test/config.test.mjs test/format.test.mjs test/observer.test.mjs test/notify.test.mjs test/win-appid.test.mjs
```

All 100 cases currently pass (config normalization and bounds, unknown-key warnings, title truncation, notification copy with a guaranteed continuation outcome, session-title labels, network/model-request continuability, the UNKNOWN network fallback, mid-turn mount continuation, sub-agent suppression and labels, approval alert grace/silence/cleanup, the auto-continue state machine with budget/timeout/deferred-admit paths, the notification queue cap and drop policy, duplicate-mount protection, channel selection and degradation markers, AppleScript escaping, command execution with tree-kill on timeout, AUMID registration and OEM-code-page decoding, batched debug-log writes and rotation).

### End-to-end verification (performed on this machine)

1. **Success path**: `test/e2e/e2e-ok.patch.yml` (OpenAI-compatible provider, key via the `PROVIDER_API_KEY` environment variable, `channel: windows`) → headless returns `exit=0`; the log shows `notification.dispatch` (start/complete) and `notification.sent ... TOAST_OK`.
2. **Retry exhaustion + auto-continue**: `test/e2e/e2e-continue.patch.yml` (unreachable baseURL + `maxRetries: 2`) → after failures in turns 1/2 the plugin sends `继续` each time, then stops when turn 3 reaches `maxAttempts: 2`; the persisted session contains two `user/message source={"kind":"task-notifier","plugin":"task-notifier"} text="继续"` entries and headless finally exits with `TRANSPORT` (`exit=1`, as expected).
3. **Windows icon branding**: after registering `DSH.TaskNotifier`, invoking `win-toast.ps1` directly prints `TOAST_OK` and the toast header shows the DSH icon and the "DSH" name; without `DSH_NOTIFY_AUMID` the script self-detects the registry key and still works.

`test/e2e/dump-session.cjs` decompresses a session for inspection: `node test/e2e/dump-session.cjs <session.v4.jsonl.zstd>`.

## Market index

DSH has no official plugin registry: the **Discover** page only reads index sources the user adds (off by default; enable **Custom plugin indexes** under Plugins → Experimental plugins). This repository publishes a format-1 index under `docs/`:

- Index URL (after GitHub Pages is enabled): <https://lizhijie429.github.io/dsh-task-notifier/index.json>
- Regenerate: `npm run market:index` (pins the HEAD commit and commit time, copies the icon into `docs/icons/`)
- Hosting: repo Settings → Pages → *Deploy from a branch* → `main` / `/docs`
- Subscribe: Plugins page → Experimental plugins → enable **Custom plugin indexes** → Discover → Index sources → add the URL → search `dsh-task-notifier` and install
- The index lists a **Git source**; the install spec is `git+https://github.com/lizhijie429/dsh-task-notifier.git#<commit>`. Re-run `npm run market:index` after each release and commit `docs/`
- Validated with the official `@deepseek-ai/dsh-plugin-market-index` validator (`parseMarketIndex` + `marketInstallTarget`)
- Community listings (PlugBox, awesome-dsh-plugin) are optional; DSH itself does not collect third-party indexes
- Release policy: bump the version for behavior changes (currently `0.2.4`); after an npm publish the other install path is `dsh plugin add "@lizhijie429/dsh-task-notifier"`

## Known limitations

- **Windows Toast** depends on PowerShell 5.1 and system notification settings; on enterprise images that disable notifications only the log is written.
- **Windows 10 (build < 22000)** requires a Start-menu shortcut for an unpackaged app's AUMID. If toasts still show "Windows PowerShell", create a Start-menu shortcut pointing at this plugin's `assets\tray.ico`, or accept the fallback identity (the notification itself still works). Windows 11 works with the HKCU registration alone (verified on this machine).
- Notifications are asynchronous fire-and-forget; delivery is not guaranteed before the process exits (very short headless tasks may only show `notification.dispatch`).
- The model-output preview is omitted by default (`includePreview: false`); enabling it puts that text on the lock screen/notification center, so keep it off for sensitive work.
- Auto-continue is skipped when the inbox already holds a next-turn entry (`next-turn-pending`; the session continues on its own) or when the provider asks to wait more than 120 s (`providerRetryAfterMs`), to avoid pointless retries.
- `channel: windows` only works on Windows; use `auto` or `log` elsewhere.
- Auto-continue covers network and model-request failures (`TRANSPORT`, `TIMEOUT`, `RATE_LIMIT`, `SERVER`, `PI_AI_ERROR`, … plus `UNKNOWN` with a network-shaped message); `AUTH`, non-network `UNKNOWN` and user aborts never continue. With `requireRetryExhausted: true` only exhausted-retry failures continue, and the turn's `turn/start` must have been observed.
- With `notifySubagents: false` sub-agent completions/failures are not reported separately; enable it for sub-agent progress (labels carry the parent id).
- Approval alerts are OS notifications only (no approve/deny buttons); the decision still happens in the DSH approval panel. Approvals auto-answered inside the grace window (policy `never`, automatic grants, cancellation) are not announced, and an approval requested before the plugin mounted is not retroactively announced.
- Notifications are best-effort: when the queue is full older progress toasts are dropped, and terminal toasts can still be delayed while several sessions fail at once.
- If the user types right after a failure, the plugin detects pending **user input** and skips the continuation (intentional protection; this can look like "no auto-continue"). Background-job notices, time-context snapshots and other system messages do **not** block it.
- The `desktop` profile relies on the Electron app to run plugins; the `dsh plugin` CLI does not apply to it.
- No `Config` schema is declared (to stay dependency-free), so Settings has no graphical form for this plugin; edit the profile's `cordis.patch.yml` instead.
- The running desktop app does not hot-reload an already loaded ESM module; restart DeepSeek Harness once for code changes to take effect (the icon branding already works with older mounts via the `win-toast.ps1` self-detection).
