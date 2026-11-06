/**
 * Notification copy for the plugin's runtime messages.
 *
 * The plugin's own metadata is localized through `locale/*.json`, but the
 * OS notification text is produced at runtime and therefore needs its own
 * table. `zh` stays the default so existing profiles keep the exact copy they
 * had before; `en` is complete, and `auto` follows the host environment.
 *
 * @module dsh-task-notifier/i18n
 */

/** Locale values accepted in configuration. */
export const LOCALES = Object.freeze(['auto', 'zh', 'en'])

/** Default locale when nothing else is known. */
export const DEFAULT_LOCALE = 'zh'

const ZH = Object.freeze({
  titles: Object.freeze({
    completed: '任务完成',
    error: '任务失败',
    aborted: '任务已取消',
    blocked: '任务被阻塞',
    'max-tokens': '任务达到输出上限',
    interrupted: '任务意外中断',
    start: '任务开始',
    step: '任务进行中',
    approval: '需要授权',
    question: '需要你操作',
  }),
  separator: '：',
  fallbackLabel: '当前会话',
  session: '会话',
  tool: '工具',
  reason: '原因',
  cancelCause: '取消原因',
  output: '输出',
  result: '结果',
  type: '类型',
  questionKind: '问题',
  planReviewKind: '计划审批',
  count: '数量',
  countValue: (count) => `${count} 个`,
  content: '内容',
  status: '状态',
  stillAnswerable: '超时后仍可回答',
  stillPending: '仍未处理',
  detailsHidden: '详情请在 DSH 中查看',
  inProgress: (step) => `进行中：第 ${step} 步`,
  steps: (count) => `${count} 步`,
  queuedContinue: (attempt, max) => `已排队「继续」（${attempt}/${max}）`,
  notContinued: '未自动继续',
  skip: Object.freeze({
    disabled: '自动继续已关闭',
    'max-attempts': '已达自动继续次数上限',
    cooldown: '自动继续冷却中',
    'inbox-busy': '会话已有待处理的用户输入',
    'next-turn-pending': '会话已有下一轮待处理输入',
    'provider-retry-after': 'provider 要求等待较长时间后重试',
    'no-turn-context': '缺少轮次上下文',
    'not-retryable': '失败不属于可继续的类型',
    'not-retry-exhausted': '非模型请求重试耗尽',
    'agent-gone': '会话已结束',
  }),
  abort: Object.freeze({
    user: '用户取消',
    parent: '父级会话取消',
    hook: '钩子取消',
    hookPrefix: '钩子取消：',
    disposed: '会话被释放',
  }),
  openApp: '打开 DSH',
})

const EN = Object.freeze({
  titles: Object.freeze({
    completed: 'Task completed',
    error: 'Task failed',
    aborted: 'Task cancelled',
    blocked: 'Task blocked',
    'max-tokens': 'Output limit reached',
    interrupted: 'Task interrupted',
    start: 'Task started',
    step: 'Task in progress',
    approval: 'Approval needed',
    question: 'Action needed',
  }),
  separator: ': ',
  fallbackLabel: 'Current session',
  session: 'Session',
  tool: 'Tool',
  reason: 'Reason',
  cancelCause: 'Cancellation',
  output: 'Output',
  result: 'Result',
  type: 'Type',
  questionKind: 'Question',
  planReviewKind: 'Plan review',
  count: 'Count',
  countValue: (count) => `${count}`,
  content: 'Details',
  status: 'Status',
  stillAnswerable: 'still answerable after the timeout',
  stillPending: 'still pending',
  detailsHidden: 'Details are available in DSH',
  inProgress: (step) => `In progress: step ${step}`,
  steps: (count) => `${count} steps`,
  queuedContinue: (attempt, max) => `Queued “continue” (${attempt}/${max})`,
  notContinued: 'Not continued automatically',
  skip: Object.freeze({
    disabled: 'auto-continue is disabled',
    'max-attempts': 'auto-continue attempts are used up',
    cooldown: 'auto-continue is cooling down',
    'inbox-busy': 'the session already has pending user input',
    'next-turn-pending': 'the session already has a queued next turn',
    'provider-retry-after': 'the provider asked to wait longer before retrying',
    'no-turn-context': 'the turn context is missing',
    'not-retryable': 'the failure is not a continuable type',
    'not-retry-exhausted': 'the model-request retries were not exhausted',
    'agent-gone': 'the session has already ended',
  }),
  abort: Object.freeze({
    user: 'cancelled by the user',
    parent: 'cancelled by the parent session',
    hook: 'cancelled by a hook',
    hookPrefix: 'cancelled by a hook: ',
    disposed: 'the session was disposed',
  }),
  openApp: 'Open DSH',
})

const MESSAGES = Object.freeze({ zh: ZH, en: EN })

/**
 * Resolve the effective locale. `auto` looks at common host environment
 * variables first and then at the JavaScript runtime locale, so a DSH host
 * started from a localized desktop session picks the matching copy.
 *
 * @param {unknown} value - configured locale (`auto`, `zh`, `en`).
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {'zh'|'en'}
 */
export function resolveLocale(value, env = process.env) {
  if (value === 'zh' || value === 'en') return value
  if (value !== 'auto') return DEFAULT_LOCALE
  const raw = String(env.DSH_LOCALE ?? env.LC_ALL ?? env.LC_MESSAGES ?? env.LANG ?? '').trim()
  if (/^zh([-_]|$)/i.test(raw)) return 'zh'
  if (/^[a-z]{2,3}([-_]|$)/i.test(raw)) return 'en'
  try {
    const runtime = Intl.DateTimeFormat().resolvedOptions().locale
    if (/^zh/i.test(runtime)) return 'zh'
  } catch {
    // Runtime locale unavailable: keep the default below.
  }
  return 'en'
}

/**
 * @param {unknown} locale - effective locale or a raw configured value.
 * @returns {typeof ZH}
 */
export function messagesFor(locale) {
  if (locale === 'en') return EN
  if (locale === 'zh') return ZH
  return MESSAGES[resolveLocale(locale)] ?? ZH
}

/**
 * Join a label and its value with the locale's separator.
 * @param {typeof ZH} messages
 * @param {string} label
 * @param {string} value
 * @returns {string}
 */
export function labelValue(messages, label, value) {
  return `${label}${messages.separator}${value}`
}
