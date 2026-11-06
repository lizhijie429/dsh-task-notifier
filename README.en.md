# DSH Task Notifier (dsh-task-notifier)

> English | [中文](README.md)

## Introduction

`dsh-task-notifier` is a DeepSeek Harness (DSH) Host plugin. It subscribes to **durable session events** and sends operating-system notifications when a task finishes, fails, or waits for your approval or an answer; when a network/model-request failure interrupts a task, it can also submit an automatic “继续” prompt so long tasks do not need constant attention.

**Core capabilities**

- **Task status notifications**: completed, failed, cancelled, blocked, output limit reached, interrupted;
- **Action-needed alerts**: pending DSH approvals, `ask_user_question`, and plan-mode `exit_plan_mode` reviews;
- **No missed work**: unanswered approvals/questions repeat every `reminderMs` (default 1 minute, at most 5 reminders) with an alert sound and stop once handled;
- **Click to return to DSH**: Windows toasts open `dsh://open` and expose an “Open DSH” action;
- **Auto-continue**: after transient network/model-request failures, submit “继续” on the agent idle edge (budget, cooldown, provider retry delay are configurable);
- **Readability**: short session labels in titles, Chinese/English copy, phase-specific icons;
- **Privacy and safety**: `privacyMode` hides lock-screen details; notification helpers receive only a minimal environment; the debug log keeps the full copy for troubleshooting;
- **Zero dependencies, multi-platform**: Node built-ins only; Windows / macOS / Linux / log-only channels.

**How it works**

- Reads only existing session events: `turn/start`, `step/start`, `llm/retry`, `session/title`, `turn/end`, `approval/*`, `tool/call`, `tool/result`, `tool/ptc-dispatch*`;
- Appends no custom session events, never rewrites the session log, and changes nothing outside OS notifications;
- Automatic messages use the plugin's own producer kind (`task-notifier`), compatible with persisted format v4.

**Compatibility and verification**

- Requires DSH `>=0.2.1-0 <0.3.0` (verified on `0.2.2-rc.1`); the Node.js requirement matches DSH (24.9+ since 0.2.2);
- 149 unit tests (148 pass + the POSIX file-permission case is skipped on Windows); CI covers Ubuntu / Windows / macOS;
- **Graphical settings page**: DSH Settings → Task Notifier, or the plugin row's **Configure** button. Changes write to the DSH settings layer and apply live (except mount-scoped options such as channel/icon/log path).
- Listed in the custom plugin index: <https://lizhijie429.github.io/dsh-task-notifier/index.json>.

## Installation

### Option 1: mount directly in the `desktop` profile (recommended for the desktop app)

The `desktop` profile is owned by the Electron app, so `dsh plugin` and similar CLI commands reject it. Edit the user patch layer `$env:USERPROFILE\.dsh\profiles\desktop\cordis.patch.yml` and append (replace `<plugin dir>` with the real absolute path):

```yaml
- insert:
    - id: task-notifier
      name: '<plugin dir>\index.mjs'
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

- `name` must be an **absolute path** (or a `file://` URL); a package name works when the package is already a profile dependency;
- The `desktop` profile supports live patch reload; if the plugin does not mount, restart DeepSeek Harness once;
- Verify: `state/task-notifier.log` in the plugin directory shows `plugin.mounted` with `agentsAvailable: true`;
- **Graphical configuration**: once mounted, open **DSH Settings → Task Notifier**, or use the plugin row's **Configure** button. The page reads and edits the same configuration, saves to the DSH settings layer (over the profile patch), and needs no YAML editing.

### Option 2: install as a plugin package in a regular profile (web / headless / custom)

```powershell
# When published on npm
dsh plugin --profile web add "@lizhijie429/dsh-task-notifier"

# Directly from GitHub (no build step)
dsh plugin --profile web add "github:lizhijie429/dsh-task-notifier"

# From a local checkout
dsh plugin --profile web add "file:$env:USERPROFILE\.dsh\plugins\dsh-task-notifier"
```

`dsh.bundle.patch` in `package.json` loads the defaults from `cordis.patch.yml` (id `task-notifier`). Override them by writing `config` for the same id in the profile's own patch.

### Option 3: temporary verification (no profile changes)

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
dsh headless --patch "$env:TEMP\task-notifier.patch.yml" "Reply OK only; do not call tools."
```

### Upgrade and uninstall

- Upgrade: replace the plugin directory (or reinstall the package) and restart DeepSeek Harness; loaded ESM modules are not hot-reloaded;
- Uninstall: remove the profile patch row (or uninstall the package) and restart. The Windows `DSH.TaskNotifier` AUMID registration is left behind and can be removed manually.

## Notification scenarios

### Task lifecycle

One notification per `turn` terminal state (multi-step tool calls do not spam):

| `turn/end` reason | Notification title | Default |
| --- | --- | --- |
| `completed` | ✅ Task completed (duration, steps, optional preview) | ✅ |
| `error` | ❌ Task failed (failure code/message, continuation outcome) | ✅ |
| `blocked` | ⛔ Task blocked | ✅ |
| `max-tokens` | ⚠️ Output limit reached | ✅ |
| `interrupted` | ⚠️ Task interrupted | ✅ |
| `aborted` | ⏹️ Task cancelled (optional cause) | Off (`notifyOnAbort`) |
| Unknown kind (e.g. `forked`) | No notification | — |

`notifyOnStart` can announce turn start; `notifyOnStep` can report every step (both off by default to avoid noise).

### Pending approvals (your authorization is required)

- Subscribes to durable `approval/asked` and notifies only if it is still pending after `approvalGraceMs` (default 1 s), so `policy: never` automatic rejection, automatic grants and cancellations stay silent;
- Body: session, tool name, approval reason (hidden by `privacyMode`); title `🔐 Approval needed`;
- `approval/decided` clears the alert immediately; unanswered alerts repeat per `reminderMs`;
- The toast is a reminder only; **approve/deny happens in the DSH approval panel**.

### User questions and plan reviews (action needed)

- Recognizes `ask_user_question` (native `tool/call` and PTC `tool/ptc-dispatch-start`) and plan mode's `exit_plan_mode`;
- Silent when answered within `questionGraceMs` (default 1 s); otherwise notifies with title `❓ Action needed`, the kind, question count and first question/plan heading;
- A timed question that returns `pending` after its foreground wait (still answerable) adds one “still answerable after the timeout” alert; each question alerts at most once (excluding reminders);
- Answering still happens in the DSH session; the notification has no answer controls.

### Auto-continue (failure recovery)

- Trigger: `turn/end` with `error` whose code is a network/model-request code (default `retryableCodes`), or `UNKNOWN` with a network-shaped message;
- Default `requireRetryExhausted: false` continues transient failures immediately; `true` only continues exhausted retry budgets;
- The prompt is admitted on the `agent/status` `idle` edge via `agent.followup()`, deferred by one microtask so clients do not see the continuation turn as “not running”;
- Budget `maxAttempts` (default 3, hard cap 50), cooldown `cooldownMs` (default 5 s), `providerRetryAfterMs` (>120 s skips);
- Skipped (and logged) when: disabled, code not continuable, strict mode not exhausted, attempts used up, agent gone, inbox already holds **human input** (including DSH 0.2.2's `user-question-reply`), a next turn is queued, the provider asks to wait too long, or strict mode has no turn context.

### Reminders, titles and clicks

- `reminderMs` defaults to 60000 (1 minute); each approval/question gets at most `reminderMax` (default 5) reminders and stops when resolved; `0` disables;
- **Approvals, questions and plan reviews are “action needed” alerts and are not suppressed when DSH is in the foreground.** The plugin never checks focus: the first notification goes out immediately after the grace window (default 1 s, used only to filter automatic decisions), and:
  - Windows toasts play the standard notification sound (`actionSound: true`, set `false` to mute);
  - macOS notifications use the `Glass` sound;
  - Linux `notify-send` uses `-u critical` urgency;
- With parallel tasks keep the default 1-minute × 5 reminders; if the OS has Focus Assist / Do Not Disturb enabled, the system may still mute banners, but the sound and repetition keep prompting;
- A Windows toast click opens `clickUrl` (default `dsh://open`, focuses DSH) and shows an "Open DSH" button; macOS/Linux click behavior belongs to the OS.
- Titles append a ≤12-character short session label (e.g. `DSH · ✅ Task completed · Designer job`); disable with `titleSessionLabel: false`;

### Sub-agent sessions

- With `notifySubagents: false` (default) all sub-agent start/step/complete/error/approval/question alerts are silent;
- When enabled, labels are `sub-agent <id> (parent <id>)`, completions keep duration/steps, and sub-agents **never auto-continue**.

### Privacy mode

With `privacyMode: true`, OS notifications hide approval reasons, question text and failure details, and only say “Details are available in DSH”; the debug log **still keeps the full copy**.

## Configuration

Every field can be set in the profile patch `config:` block. Unset fields fall back to defaults; a patch row **replaces** its whole `config` block (it is not a deep merge).

| Field | Default | Description |
| --- | --- | --- |
| `notifyOnStart` | `false` | Notify on `turn/start` |
| `notifyOnComplete` | `true` | Notify for `completed` / `max-tokens` |
| `notifyOnError` | `true` | Notify for `error` / `blocked` / `interrupted` |
| `notifyOnAbort` | `false` | Notify on user cancellation (`aborted`) |
| `notifyOnStep` | `false` | Notify every `step/start` (debugging) |
| `notifySubagents` | `false` | Notify sub-agent sessions |
| `notifyOnApproval` | `true` | Pending-approval alerts |
| `approvalGraceMs` | `1000` | Approval grace window (0–60000 ms) |
| `notifyOnQuestion` | `true` | Question/plan-review alerts |
| `questionGraceMs` | `1000` | Question grace window (0–60000 ms) |
| `locale` | `zh` | Copy language: `zh` / `en` / `auto` (follows `DSH_LOCALE`/`LC_ALL`/`LANG`) |
| `reminderMs` | `60000` | Reminder interval for unanswered approvals/questions (0–3600000 ms, 0 disables) |
| `reminderMax` | `5` | Maximum reminders per unanswered approval/question (0–10; 0 keeps only the first alert) |
| `actionSound` | `true` | Play an alert sound for approval/question/plan-review notifications (Windows toast audio, macOS Glass sound; Linux always uses critical urgency) |
| `clickUrl` | `dsh://open` | Windows toast click/action target; only `dsh:`/`http:`/`https:`, `false` disables |
| `titleSessionLabel` | `true` | Append a ≤12-character short session label to the title |
| `privacyMode` | `false` | Hide sensitive details from OS notifications; the log stays complete |
| `channel` | `auto` | `auto` / `windows` / `macos` / `linux` / `log` / `none` |
| `titlePrefix` | `DSH` | Title prefix (≤60 characters) |
| `windowsAppId` | `DSH.TaskNotifier` | Windows toast AppUserModelID |
| `windowsAppName` | `DSH` | Windows toast app name |
| `maxBodyChars` | `240` | Body truncation limit (60–2000) |
| `includePreview` | `false` | Include the model-output preview (lock-screen privacy) |
| `logFile` | `<plugin dir>/state/task-notifier.log` | JSONL debug log; relative paths resolve against the plugin dir; rotates at 256 KB to `.1` |
| `autoContinue.enabled` | `true` | Enable automatic continuation |
| `autoContinue.message` | `继续` | Prompt text submitted automatically |
| `autoContinue.maxAttempts` | `3` | Automatic continuations per task (hard cap 50) |
| `autoContinue.cooldownMs` | `5000` | Minimum spacing between continuations (0–600000 ms) |
| `autoContinue.requireRetryExhausted` | `false` | `false`: continue network/model failures directly; `true`: only exhausted retry budgets |
| `autoContinue.respectProviderRetryAfter` | `true` | Honor `providerRetryAfterMs` (>120 s skips) |
| `autoContinue.retryableCodes` | `EMPTY_RESPONSE,RATE_LIMIT,SERVER,TIMEOUT,TRANSPORT,PI_AI_ERROR,AI_ERROR,PROVIDER,MODEL,OVERLOADED,NETWORK,CONNECTION,ECONNRESET,ECONNREFUSED,ETIMEDOUT,ENOTFOUND,EAI_AGAIN,SOCKET` | Failure codes eligible for continuation |

**Validation**: invalid values fall back to defaults with a warning; unknown keys (typos in a hand-written patch) are reported too. Warnings go to the Host log and to the debug log as `config.warning`, and are summarized in `plugin.mounted`'s `warnings`.

**Debug log** (the troubleshooting record): default `<plugin dir>/state/task-notifier.log`, JSONL, UTF-8, 256 KB rotation; POSIX mode `0600` (Windows inherits the user-profile ACL). It **keeps the complete notification titles and bodies**; redact before sharing. Key events: `plugin.mounted`, `notification.dispatch/sent/failed`, `auto-continue.*`, `approval.*`, `question.*`, `channel.fallback`, `agent.status`, `observer.error`.

> **Graphical settings**: the plugin declares a `Config` schema (vendored schemastery/cosmokit, MIT, so an externally mounted plugin can resolve it), and every field is `.volatile()`, so the DSH settings page can read and write it live. Entry points: **Settings → Task Notifier** in the Settings sidebar, or the plugin row's **Configure** button. Saving writes the DSH settings layer, which takes precedence over the profile `cordis.patch.yml`; **Discard changes** only drops the draft, and restoring patch values needs a reset/clear in the settings layer. There are no non-volatile fields, so most options apply without a restart.

## Notification channels

| Platform | Implementation | Notes |
| --- | --- | --- |
| Windows | `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File lib/win-toast.ps1`, WinRT Toast first, tray-balloon fallback | Title/body travel through environment variables, avoiding command-line escaping; XML-1.0-illegal control characters are stripped first. The identity is DSH: on mount the plugin registers `DisplayName` + `IconUri` under `HKCU\Software\Classes\AppUserModelId\DSH.TaskNotifier`, so the toast header shows the DSH icon/name; the banner uses `assets/icon.png`. A click opens `clickUrl` (default `dsh://open`) and shows “Open DSH”. If registration fails or an older mount passes no AUMID, the script probes that registry key and only then falls back to the PowerShell identity. |
| macOS | `osascript -e 'display notification …'` | Scripts must be allowed to send notifications in System Settings; custom actions/icons are not supported |
| Linux | `notify-send -a <titlePrefix> -i assets/icon.png -- title body` | Requires a desktop notification daemon; `--` keeps summaries starting with `-` from being parsed as options |
| log / none | Log only / fully silent | For debugging, CI or headless environments |

**Channel probing and fallback**: `channel: auto` (and explicit `windows`/`macos`/`linux`) checks at mount whether the OS helper exists; when missing it falls back to `log`, writes `channel.fallback` and warns in the Host log instead of failing every notification silently. `plugin.mounted` records `channelRequested` / `channel` / `channelFallback`.

**Delivery policy**: notifications are best-effort and asynchronous; failures never affect task execution. The queue is capped at 20 and drops by priority: `step`/`start` → `complete` → other terminals, with **approval/question alerts dropped last**. Progress toasts time out after 6 s and terminal ones after 12 s; a timed-out Windows toast is killed with `taskkill /T /F` (whole process tree).

**Minimal child environment**: PowerShell / osascript / notify-send / reg.exe / taskkill inherit only PATH, SystemRoot/TEMP, HOME, DISPLAY/DBUS and LANG/LC_* — never the Host's provider credentials or tokens.

## Known limitations

- **Windows toast prerequisites**: requires PowerShell 5.1 and system notification settings; enterprise images with notifications disabled, Focus Assist or Do Not Disturb only leave log entries. Windows 10 (build < 22000) may require a Start-menu shortcut for the unpackaged AUMID; otherwise the fallback identity is used (the notification still appears).
- **Asynchronous delivery**: fire-and-forget; delivery is not guaranteed before process exit. Very short headless tasks may only show `notification.dispatch`.
- **Bounded queue**: extreme bursts drop low-priority notifications; terminal toasts can still be delayed while several sessions fail at once.
- **Not covered**: background-job completions (`job/settled`, DSH already notifies in-app), maintenance `agent/error` outside a turn, and custom plugins that call `userQuestions` directly without producing a tool-call event.
- **Content visibility**: by default the body contains the session title, approval tool/reason, question summary and failure details, which may appear on the lock screen/notification center; set `privacyMode: true` in sensitive environments. For troubleshooting the log **keeps the full copy** (POSIX `0600`, Windows user ACL); redact before sharing.
- **No decision buttons / session deep links**: notifications carry no approve/deny/answer buttons; the click action works on Windows only and focuses DSH (`dsh://open`) without locating the specific session; macOS/Linux click behavior belongs to the OS.
- **Limited reminders**: 1-minute interval and at most 5 reminders by default (`reminderMax` is configurable), stopping on resolution; an approval/question recorded before the plugin mounted is not retroactively announced.
- **Foreground alerts depend on OS notification settings**: the plugin never suppresses notifications based on focus, so approvals/questions/plan reviews always fire after the grace window; however Windows Focus Assist / Do Not Disturb, macOS Focus, or a missing Linux notification daemon can still mute banners or sounds. `actionSound` can mute the sound; for stronger system-level alerts allow DSH notifications in the OS settings.
- **Sub-agents**: silent by default; enable `notifySubagents` to receive them. Sub-agents never auto-continue.
- **Auto-continue scope**: only network/model-request failures; `AUTH`, non-network `UNKNOWN` and user aborts never continue. Strict mode depends on the turn's `llm/retry` chain; after a hot reload without turn context strict mode skips. The budget lives in memory and resets when the process restarts.
- **Language and titles**: copy supports `zh`/`en`; `locale: auto` reads host environment variables only, not a per-client Web language setting. The short title label is capped at 12 characters (truncated with `…`).
- **Channel probing boundaries**: only checks that the OS helper exists; it cannot verify notification permissions or that a desktop notification daemon is actually running.
- **Live settings scope**: most options apply immediately after saving; the notification-channel probe, the Windows AUMID registration and the log-file handle are fixed at mount, so changing `channel`/`windowsAppId`/`windowsAppName`/`logFile` needs a plugin reload (restart DSH, or trigger a reload). Settings writes the DSH settings layer, which outranks the profile patch; use the page's reset/clear to fall back to patch values.
- **CLI overlays outrank settings**: configuration injected with `dsh --patch <file>` sits in a higher-priority layer, so the Host rejects settings-page writes for such rows (“The save conflicted or the Host rejected it”). That is DSH's protection; a normal profile-patch install is unaffected.
- **AUMID cleanup**: uninstalling the plugin does not remove `HKCU\Software\Classes\AppUserModelId\DSH.TaskNotifier`; delete it manually if needed.
- **Restart for code changes**: the running desktop app does not hot-reload loaded ESM modules; restart DeepSeek Harness after upgrading.
- **Version range**: requires DSH `>=0.2.1-0 <0.3.0`; DSH 0.3+ needs a plugin release first.

