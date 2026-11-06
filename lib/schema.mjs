/**
 * Cordis `Config` schema for the task notifier.
 *
 * The DSH loader validates the profile `config:` block against this schema
 * before `apply()` runs. The settings service only projects **volatile** fields
 * into the browser form, so every editable field is marked `.volatile()`; a
 * settings save commits the new value into the running plugin without a
 * remount (the host listens for `loader/volatile-update`).
 *
 * Schemastery is vendored under `vendor/schemastery` because an externally
 * mounted plugin cannot resolve the host's `@deepseek-ai/*` packages.
 *
 * The schema is intentionally permissive where the runtime accepts several
 * shapes (`clickUrl` accepts a URL string or `false`, `logFile` accepts a path
 * or `false`); `lib/config.mjs` remains the authority on normalization and on
 * bounds that depend on runtime context.
 *
 * @module dsh-task-notifier/schema
 */

import Schema from '../vendor/schemastery/index.mjs'

const RETRYABLE_CODES = [
  'EMPTY_RESPONSE',
  'RATE_LIMIT',
  'SERVER',
  'TIMEOUT',
  'TRANSPORT',
  'PI_AI_ERROR',
  'AI_ERROR',
  'PROVIDER',
  'MODEL',
  'OVERLOADED',
  'NETWORK',
  'CONNECTION',
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'SOCKET',
]

const autoContinue = Schema.object({
  enabled: Schema.boolean()
    .default(true)
    .description('网络/模型失败后自动继续 / auto-continue after network/model failures')
    .volatile(),
  message: Schema.string().default('继续').description('自动发送的消息 / prompt text').volatile(),
  maxAttempts: Schema.natural()
    .min(1)
    .max(50)
    .default(3)
    .description('每个任务最多自动继续次数 / attempts per turn')
    .volatile(),
  cooldownMs: Schema.natural()
    .max(600_000)
    .default(5_000)
    .description('两次继续的最小间隔（毫秒）/ cooldown in ms')
    .volatile(),
  requireRetryExhausted: Schema.boolean()
    .default(false)
    .description('仅继续重试预算耗尽的失败 / only continue exhausted retry budgets')
    .volatile(),
  respectProviderRetryAfter: Schema.boolean()
    .default(true)
    .description('遵循 provider 要求的重试等待 / honor providerRetryAfterMs')
    .volatile(),
  retryableCodes: Schema.array(Schema.string())
    .default(RETRYABLE_CODES)
    .description('可继续的失败码 / failure codes eligible for continuation')
    .volatile(),
})

/** Config schema shown by the DSH settings page and enforced by the loader. */
export const Config = Schema.object({
  notifyOnStart: Schema.boolean().default(false).description('任务开始时通知 / notify on task start').volatile(),
  notifyOnComplete: Schema.boolean()
    .default(true)
    .description('任务完成/达到输出上限时通知 / notify on completion')
    .volatile(),
  notifyOnError: Schema.boolean().default(true).description('任务失败/阻塞/中断时通知 / notify on error').volatile(),
  notifyOnAbort: Schema.boolean().default(false).description('任务取消时通知 / notify on cancellation').volatile(),
  notifyOnStep: Schema.boolean().default(false).description('每步通知（调试用）/ notify every step (debug)').volatile(),
  notifySubagents: Schema.boolean().default(false).description('通知子代理会话 / notify sub-agent sessions').volatile(),
  notifyOnApproval: Schema.boolean().default(true).description('审批等待提醒 / pending-approval alerts').volatile(),
  approvalGraceMs: Schema.natural().max(60_000).default(1_000).description('审批宽限期（毫秒）/ approval grace ms').volatile(),
  notifyOnQuestion: Schema.boolean()
    .default(true)
    .description('提问/计划审批提醒 / question and plan-review alerts')
    .volatile(),
  questionGraceMs: Schema.natural().max(60_000).default(1_000).description('提问宽限期（毫秒）/ question grace ms').volatile(),
  locale: Schema.union(['auto', 'zh', 'en']).default('zh').description('通知文案语言 / notification copy language').volatile(),
  reminderMs: Schema.natural()
    .max(3_600_000)
    .default(60_000)
    .description('未处理提醒间隔（毫秒，0 关闭）/ reminder interval ms')
    .volatile(),
  reminderMax: Schema.natural().max(10).default(5).description('每个待处理事项最多提醒次数 / max reminders').volatile(),
  actionSound: Schema.boolean().default(true).description('审批/提问提示音 / action alert sound').volatile(),
  clickUrl: Schema.any().default('dsh://open').description('Toast 点击目标（false 关闭）/ click target, false disables').volatile(),
  titleSessionLabel: Schema.boolean()
    .default(true)
    .description('标题附加短会话标签 / short session label in title')
    .volatile(),
  privacyMode: Schema.boolean()
    .default(false)
    .description('OS 通知隐藏敏感详情 / hide details from OS notifications')
    .volatile(),
  channel: Schema.union(['auto', 'windows', 'macos', 'linux', 'log', 'none'])
    .default('auto')
    .description('通知通道 / notification channel')
    .volatile(),
  titlePrefix: Schema.string().default('DSH').description('通知标题前缀 / title prefix').volatile(),
  windowsAppId: Schema.string().default('DSH.TaskNotifier').description('Windows AppUserModelID').volatile(),
  windowsAppName: Schema.string().default('DSH').description('Windows 通知应用名 / Windows toast app name').volatile(),
  maxBodyChars: Schema.natural()
    .min(60)
    .max(2_000)
    .default(240)
    .description('正文最大字符数 / body character limit')
    .volatile(),
  includePreview: Schema.boolean()
    .default(false)
    .description('通知中附模型输出预览 / include model output preview')
    .volatile(),
  // No default: the real default is `<plugin dir>/state/task-notifier.log`, which
  // depends on where the plugin is mounted; an empty schema default would make
  // normalization warn and could point the log at the Host process cwd.
  logFile: Schema.any()
    .description('调试日志路径（留空用插件目录下的默认值）/ debug log path; empty uses plugin default')
    .volatile(),
  autoContinue,
})

export default Config