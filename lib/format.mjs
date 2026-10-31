/**
 * Pure formatting helpers shared by the observer and the notifier.
 *
 * Kept free of runtime services so the turn classification and notification
 * text can be unit-tested without booting a Cordis context.
 *
 * @module dsh-task-notifier/format
 */

/** One-line labels for the durable `turn/end` reasons. */
const REASON_TEXT = Object.freeze({
  completed: { icon: '✅', title: '任务完成' },
  error: { icon: '❌', title: '任务失败' },
  aborted: { icon: '⏹️', title: '任务已取消' },
  blocked: { icon: '⛔', title: '任务被阻塞' },
  'max-tokens': { icon: '⚠️', title: '任务达到输出上限' },
  interrupted: { icon: '⚠️', title: '任务意外中断' },
})

/** Label used when the session itself cannot be named. */
const FALLBACK_LABEL = '当前会话'

/**
 * Read the durable reason kind of one `turn/end` payload.
 * @param {any} reason - `turn/end` data.reason
 * @returns {string}
 */
export function reasonKind(reason) {
  if (typeof reason === 'string') return reason
  if (reason && typeof reason === 'object' && typeof reason.kind === 'string') return reason.kind
  return 'completed'
}

/**
 * Extract the stable code of a flattened LLM failure.
 * @param {unknown} failure
 * @returns {string|undefined}
 */
export function failureCode(failure) {
  if (!failure || typeof failure !== 'object') return undefined
  const code = /** @type {any} */ (failure).code
  return typeof code === 'string' && code.trim() !== '' ? code.trim() : undefined
}

/**
 * Extract a human-readable failure message.
 * @param {unknown} failure
 * @returns {string|undefined}
 */
export function failureMessage(failure) {
  if (!failure || typeof failure !== 'object') return undefined
  const message = /** @type {any} */ (failure).message
  return typeof message === 'string' && message.trim() !== '' ? message.trim() : undefined
}

/**
 * @param {unknown} value
 * @returns {string}
 */
export function errorCodeOf(value) {
  const failure = failureCode(value) ?? failureCode(/** @type {any} */ (value)?.error)
  return failure ?? 'UNKNOWN'
}

/**
 * Human duration from milliseconds.
 * @param {number} ms
 * @returns {string}
 */
export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '0s'
  const totalSeconds = Math.round(ms / 100) / 10
  if (totalSeconds < 60) {
    return `${totalSeconds < 10 ? totalSeconds.toFixed(1) : Math.round(totalSeconds)}s`
  }
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = Math.round(totalSeconds % 60)
  if (minutes < 60) return `${minutes}m${seconds === 0 ? '' : `${seconds}s`}`
  const hours = Math.floor(minutes / 60)
  return `${hours}h${minutes % 60 === 0 ? '' : `${minutes % 60}m`}`
}

/**
 * Collapse whitespace and truncate text to a maximum length.
 * @param {string} text
 * @param {number} limit
 * @returns {string}
 */
export function clip(text, limit) {
  const compact = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (compact.length <= limit) return compact
  return `${compact.slice(0, Math.max(1, limit - 1))}…`
}

/**
 * Read the first text block of a model-visible message payload.
 * @param {{ content?: ReadonlyArray<{ type?: string; text?: string }> }} message
 * @returns {string}
 */
export function messageText(message) {
  if (!message || !Array.isArray(message.content)) return ''
  const parts = []
  for (const block of message.content) {
    if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n')
}

/**
 * Build the title/body pair for one notification.
 *
 * @param {object} event
 * @param {'start'|'step'|'complete'|'error'|'aborted'|'blocked'|'max-tokens'|'interrupted'} event.phase
 * @param {string} event.label
 * @param {string} [event.titlePrefix]
 * @param {number} [event.durationMs]
 * @param {number} [event.steps]
 * @param {number} [event.turn]
 * @param {any} [event.failure]
 * @param {string} [event.preview]
 * @param {{attempt:number,max:number}|{skipped:string}|undefined} [event.autoContinue]
 * @param {string} [event.abortCause]
 * @param {number} [event.maxBodyChars]
 * @returns {{title:string, body:string}}
 */
export function buildNotification(event) {
  const prefix = event.titlePrefix ?? 'DSH'
  const reason = phaseReason(event.phase)
  const title = `${prefix} · ${reason.icon} ${reason.title}`
  const parts = []

  const label = clip(event.label || FALLBACK_LABEL, 60)
  parts.push(`会话：${label}`)

  if (event.phase === 'start') {
    // Nothing further is known when the turn starts.
  } else if (event.phase === 'step') {
    parts.push(`进行中：第 ${event.steps ?? 0} 步`)
  } else {
    const facts = []
    if (Number.isFinite(event.durationMs)) facts.push(formatDuration(event.durationMs ?? 0))
    if (Number.isFinite(event.steps) && (event.steps ?? 0) > 0) facts.push(`${event.steps} 步`)
    if (facts.length > 0) parts.push(facts.join(' · '))
  }

  if (event.phase === 'error') {
    const code = failureCode(event.failure)
    const message = failureMessage(event.failure)
    const detail = [code, message].filter(Boolean).join(': ')
    if (detail) parts.push(`原因：${clip(detail, 160)}`)
    if (event.autoContinue) {
      if ('attempt' in event.autoContinue) {
        parts.push(`已自动发送「继续」（${event.autoContinue.attempt}/${event.autoContinue.max}）`)
      } else {
        parts.push(`未自动继续：${autoContinueSkipText(event.autoContinue.skipped)}`)
      }
    }
  } else if (event.phase === 'aborted') {
    if (event.abortCause) parts.push(`取消原因：${clip(event.abortCause, 80)}`)
  } else if (event.phase === 'max-tokens') {
    if (event.preview) parts.push(`输出：${clip(event.preview, 120)}`)
  } else if (event.phase === 'complete') {
    if (event.preview) parts.push(`结果：${clip(event.preview, 160)}`)
  }

  const limit = event.maxBodyChars ?? 240
  const body = clip(parts.join('\n'), limit)
  return { title, body }
}

/**
 * @param {string} iconOrPhase
 * @returns {{icon:string,title:string}}
 */
function phaseReason(phase) {
  switch (phase) {
    case 'start':
      return { icon: '▶️', title: '任务开始' }
    case 'step':
      return { icon: '⏳', title: '任务进行中' }
    case 'error':
      return REASON_TEXT.error
    case 'aborted':
      return REASON_TEXT.aborted
    case 'blocked':
      return REASON_TEXT.blocked
    case 'max-tokens':
      return REASON_TEXT['max-tokens']
    case 'interrupted':
      return REASON_TEXT.interrupted
    default:
      return REASON_TEXT.completed
  }
}

/**
 * Map a durable `turn/end` reason to the notification phase vocabulary.
 * @param {string} kind
 * @returns {'complete'|'error'|'aborted'|'blocked'|'max-tokens'|'interrupted'}
 */
export function phaseForReason(kind) {
  switch (kind) {
    case 'error':
      return 'error'
    case 'aborted':
      return 'aborted'
    case 'blocked':
      return 'blocked'
    case 'max-tokens':
      return 'max-tokens'
    case 'interrupted':
      return 'interrupted'
    default:
      return 'complete'
  }
}

/**
 * @param {string} reason
 * @returns {string}
 */
function autoContinueSkipText(reason) {
  switch (reason) {
    case 'disabled':
      return '自动继续已关闭'
    case 'max-attempts':
      return '已达自动继续次数上限'
    case 'cooldown':
      return '自动继续冷却中'
    case 'inbox-busy':
      return '会话已有待处理输入'
    case 'not-idle':
      return '会话未空闲'
    case 'not-retry-exhausted':
      return '非模型请求重试耗尽'
    case 'agent-gone':
      return '会话已结束'
    default:
      return reason
  }
}

/**
 * Decide whether a turn failure is an exhausted model-request retry chain.
 *
 * The agent loop ends a turn with `reason.kind === 'error'` only after every
 * registered recovery policy declined to retry. The durable `llm/retry`
 * events recorded inside that turn carry the policy budget, so a terminal
 * failure is "retry budget exhausted" when the last scheduled normal-mode
 * retry already reached its `maxRetries`.
 *
 * @param {object} input
 * @param {Array<{type:string,data:any}>} input.turnEvents - durable events of the failed turn.
 * @param {unknown} input.failure - flattened terminal failure.
 * @param {readonly string[]} input.retryableCodes
 * @returns {boolean}
 */
export function isRetryExhaustedFailure({ turnEvents, failure, retryableCodes }) {
  const code = failureCode(failure)
  if (code === undefined || !retryableCodes.includes(code.toUpperCase())) return false

  const retries = []
  for (const event of turnEvents ?? []) {
    if (event && event.type === 'llm/retry' && event.data && typeof event.data === 'object') retries.push(event.data)
  }
  if (retries.length === 0) return true

  const last = retries[retries.length - 1]
  if (last.mode === 'always') return false
  const retry = Number(last.retry)
  const maxRetries = Number(last.maxRetries)
  if (!Number.isFinite(retry) || !Number.isFinite(maxRetries)) return false
  return retry >= maxRetries
}

/**
 * Collect the events belonging to one turn.
 * @param {Array<{type:string,data:any}>} events - buffered session events.
 * @param {number} turn
 * @returns {Array<{type:string,data:any}>}
 */
export function eventsForTurn(events, turn) {
  return (events ?? []).filter((event) => {
    const data = event && event.data
    return data && typeof data === 'object' && data.turn === turn
  })
}
