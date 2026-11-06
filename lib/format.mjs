/**
 * Pure formatting helpers shared by the observer and the notifier.
 *
 * Kept free of runtime services so the turn classification and notification
 * text can be unit-tested without booting a Cordis context.
 *
 * @module dsh-task-notifier/format
 */

import { labelValue, messagesFor } from './i18n.mjs'

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
 * Network/transport wording in a failure message. DSH wraps non-LlmError
 * throws with `code: 'UNKNOWN'` (agent-loop), so the message is the only
 * signal left for adapter-level connection failures; a bounded continuation
 * attempt is still worth it there.
 */
const NETWORK_FAILURE_PATTERN =
  /(?:connection|network|socket|timed?\s*out|fetch failed|ECONN(?:RESET|REFUSED|ABORTED)|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|TLS|dns|offline|reset by peer)/i

/**
 * Whether a failure looks like a network/transport problem.
 * @param {unknown} failure
 * @returns {boolean}
 */
export function isNetworkFailureMessage(failure) {
  const message = failureMessage(failure)
  return message !== undefined && NETWORK_FAILURE_PATTERN.test(message)
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
  let end = Math.max(1, limit - 1)
  const code = compact.charCodeAt(end)
  // Never split a surrogate pair: the replacement character would leak into
  // the notification text and the child process.
  if (code >= 0xdc00 && code <= 0xdfff && end > 1) end -= 1
  return `${compact.slice(0, end)}…`
}

/**
 * Join every text block of a model-visible message payload.
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
 * @param {'start'|'step'|'complete'|'error'|'aborted'|'blocked'|'max-tokens'|'interrupted'|'approval'|'question'} event.phase
 * @param {string} event.label
 * @param {string} [event.titlePrefix]
 * @param {number} [event.durationMs]
 * @param {number} [event.steps]
 * @param {number} [event.turn]
 * @param {any} [event.failure]
 * @param {string} [event.preview]
 * @param {{attempt:number,max:number}|{skipped:string}|undefined} [event.autoContinue]
 * @param {string} [event.abortCause]
 * @param {{toolName?:string, reason?:string, reminder?:boolean}} [event.approval] - pending approval details.
 * @param {{kind?:string, summary?:string, count?:number, pending?:boolean, reminder?:boolean}} [event.question] - pending user-question details.
 * @param {string} [event.locale] - effective notification locale (`zh`/`en`).
 * @param {number} [event.maxBodyChars]
 * @returns {{title:string, body:string}}
 */
export function buildNotification(event) {
  const messages = messagesFor(event.locale)
  const prefix = event.titlePrefix ?? 'DSH'
  const reason = phaseReason(event.phase, messages)
  const title = `${prefix} · ${reason.icon} ${reason.title}`
  const parts = []

  const label = clip(event.label || messages.fallbackLabel, 60)
  parts.push(labelValue(messages, messages.session, label))

  if (event.phase === 'start') {
    // Nothing further is known when the turn starts.
  } else if (event.phase === 'step') {
    parts.push(messages.inProgress(event.steps ?? 0))
  } else {
    const facts = []
    if (Number.isFinite(event.durationMs)) facts.push(formatDuration(event.durationMs ?? 0))
    if (Number.isFinite(event.steps) && (event.steps ?? 0) > 0) facts.push(messages.steps(event.steps))
    if (facts.length > 0) parts.push(facts.join(' · '))
  }

  if (event.phase === 'error') {
    // Keep the continuation outcome ahead of the free-form reason: a verbose
    // provider error would otherwise push it past maxBodyChars.
    if (event.autoContinue) {
      if ('attempt' in event.autoContinue) {
        parts.push(messages.queuedContinue(event.autoContinue.attempt, event.autoContinue.max))
      } else {
        parts.push(
          labelValue(
            messages,
            messages.notContinued,
            autoContinueSkipText(event.autoContinue.skipped, messages),
          ),
        )
      }
    }
    const code = failureCode(event.failure)
    const message = failureMessage(event.failure)
    const detail = [code, message].filter(Boolean).join(': ')
    if (detail) parts.push(labelValue(messages, messages.reason, clip(detail, 120)))
  } else if (event.phase === 'aborted') {
    if (event.abortCause) parts.push(labelValue(messages, messages.cancelCause, clip(event.abortCause, 80)))
  } else if (event.phase === 'approval') {
    // The user must act in the DSH approval panel; keep the tool and reason
    // short enough that both survive maxBodyChars.
    const toolName = clip(String(event.approval?.toolName ?? '').trim(), 40)
    if (toolName) parts.push(labelValue(messages, messages.tool, toolName))
    const detail = clip(String(event.approval?.reason ?? '').trim(), 140)
    if (detail) parts.push(labelValue(messages, messages.reason, detail))
    if (event.approval?.reminder === true) {
      parts.push(labelValue(messages, messages.status, messages.stillPending))
    }
  } else if (event.phase === 'question') {
    const kind = event.question?.kind === 'plan-review' ? messages.planReviewKind : messages.questionKind
    parts.push(labelValue(messages, messages.type, kind))
    const count = Number(event.question?.count)
    if (Number.isFinite(count) && count > 1) parts.push(labelValue(messages, messages.count, messages.countValue(count)))
    const summary = clip(String(event.question?.summary ?? '').trim(), 120)
    if (summary) parts.push(labelValue(messages, messages.content, summary))
    if (event.question?.pending === true) {
      parts.push(labelValue(messages, messages.status, messages.stillAnswerable))
    }
    if (event.question?.reminder === true) {
      parts.push(labelValue(messages, messages.status, messages.stillPending))
    }
  } else if (event.phase === 'max-tokens') {
    if (event.includePreview && event.preview) parts.push(labelValue(messages, messages.output, clip(event.preview, 120)))
  } else if (event.phase === 'complete') {
    if (event.includePreview && event.preview) parts.push(labelValue(messages, messages.result, clip(event.preview, 160)))
  }

  const limit = event.maxBodyChars ?? 240
  const body = clip(parts.join('\n'), limit)
  return { title, body }
}

/**
 * @param {string} phase
 * @param {ReturnType<typeof messagesFor>} messages
 * @returns {{icon:string,title:string}}
 */
function phaseReason(phase, messages) {
  switch (phase) {
    case 'start':
      return { icon: '▶️', title: messages.titles.start }
    case 'step':
      return { icon: '⏳', title: messages.titles.step }
    case 'error':
      return { icon: '❌', title: messages.titles.error }
    case 'aborted':
      return { icon: '⏹️', title: messages.titles.aborted }
    case 'blocked':
      return { icon: '⛔', title: messages.titles.blocked }
    case 'max-tokens':
      return { icon: '⚠️', title: messages.titles['max-tokens'] }
    case 'interrupted':
      return { icon: '⚠️', title: messages.titles.interrupted }
    case 'approval':
      return { icon: '🔐', title: messages.titles.approval }
    case 'question':
      return { icon: '❓', title: messages.titles.question }
    default:
      return { icon: '✅', title: messages.titles.completed }
  }
}

/**
 * Map a durable `turn/end` reason to the notification phase vocabulary.
 * @param {string} kind
 * @returns {'complete'|'error'|'aborted'|'blocked'|'max-tokens'|'interrupted'}
 */
export function phaseForReason(kind) {
  switch (kind) {
    case 'completed':
      return 'complete'
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
      // Unknown durable kinds (e.g. `forked`) are not successes: notify nothing.
      return 'unknown'
  }
}

/**
 * @param {string} reason
 * @param {ReturnType<typeof messagesFor>} messages
 * @returns {string}
 */
function autoContinueSkipText(reason, messages) {
  return messages.skip[reason] ?? reason
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
