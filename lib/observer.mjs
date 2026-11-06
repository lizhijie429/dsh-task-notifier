/**
 * Live turn observer: turns durable session events into desktop notifications
 * and, for exhausted model-request retries, a continuation prompt.
 *
 * Two rules shape the design:
 *
 * - Notifications are derived from durable `session/event` facts, so they are
 *   emitted after the turn is committed and never depend on live status timing.
 * - The continuation prompt is admitted from the `agent/status` idle edge, not
 *   from the `turn/end` listener: `Session.append()` rejects reentrant appends,
 *   so calling `agent.followup()` while the turn/end event is still being
 *   published would throw. The idle edge is also the edge the built-in
 *   goal-round driver uses to start follow-up work, and admitting the prompt
 *   there keeps `agent.whenIdle()` unresolved until the continuation turn runs.
 *
 * The observer is transport-free: it receives Cordis events, reads the live
 * Agent registry, and delegates OS notification + prompt admission to injected
 * collaborators so the turn state machine stays unit-testable.
 *
 * @module dsh-task-notifier/observer
 */

import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import {
  buildNotification,
  clip,
  failureCode,
  failureMessage,
  isNetworkFailureMessage,
  isRetryExhaustedFailure,
  messageText,
  phaseForReason,
  reasonKind,
} from './format.mjs'
import { HARD_CONTINUE_LIMIT } from './config.mjs'
import { messagesFor } from './i18n.mjs'

export const PLUGIN_NAME = 'task-notifier'

/** Longest provider-requested retry delay we are willing to wait out. */
const PROVIDER_RETRY_CAP_MS = 120_000

/** Tool calls that wait on the user: DSH's question tool and plan review. */
const QUESTION_TOOL_NAMES = new Set(['ask_user_question', 'exit_plan_mode'])

/** The plan-review tool among {@link QUESTION_TOOL_NAMES}. */
const PLAN_REVIEW_TOOL = 'exit_plan_mode'

/** Cap reminder toasts per pending approval/question (after the first alert). */
const MAX_REMINDERS = 3

/**
 * @typedef {object} PendingContinuation
 * @property {number} attempt
 * @property {number} max
 * @property {number} generation
 * @property {number} [notBefore] - absolute time before which the prompt must not be sent.
 */

/**
 * @typedef {object} SessionState
 * @property {string} sessionId
 * @property {string} fallbackLabel
 * @property {boolean} subagent
 * @property {string} label
 * @property {{number:number, startedAt:number, steps:number, lastAssistantText:string}|null} turn
 * @property {Array<any>} retries - durable `llm/retry` payloads of the current turn.
 * @property {Map<string, {timer:any, toolName:string, reason:string, askedAt:number, notified:boolean}>} approvals - pending approval alerts.
 * @property {Map<string, {timer:any, kind:string, summary:string, count:number, askedAt:number, notified:boolean}>} questions - open user-question/plan-review calls.
 * @property {number} autoContinueCount
 * @property {number} lastContinueAt
 * @property {PendingContinuation|null} pending
 * @property {any} cooldownTimer
 * @property {number} generation
 * @property {boolean} disposed
 */

export class TaskObserver {
  /**
   * @param {object} options
   * @param {any} options.config - normalized plugin config.
   * @param {(level:string, message:string) => void} [options.log]
   * @param {(event:string, data?:unknown) => void} [options.fileLog]
   * @param {{dispatch:(notification:{title:string, body:string}) => Promise<any>}} options.notifier
   * @param {{get:(id:string) => any}} [options.agents]
   * @param {() => number} [options.now]
   * @param {typeof setTimeout} [options.setTimeoutFn]
   * @param {typeof clearTimeout} [options.clearTimeoutFn]
   */
  constructor(options) {
    this.config = options.config
    this.log = options.log ?? (() => {})
    this.fileLog = options.fileLog ?? (() => {})
    this.notifier = options.notifier
    this.agents = options.agents
    this.now = options.now ?? Date.now
    this.setTimeoutFn = options.setTimeoutFn ?? setTimeout
    this.clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout
    /** @type {Map<string, SessionState>} */
    this.states = new Map()
    /** @type {Set<any>} */
    this.timers = new Set()
  }

  /**
   * Handle one post-commit durable session event.
   * @param {any} session - live Session.
   * @param {{type:string, data:any}} event - committed SessionEvent.
   */
  onSessionEvent(session, event) {
    if (!session || typeof session.id !== 'string' || !event || typeof event.type !== 'string') return
    const state = this.ensureState(session)
    if (!state || state.disposed) return

    switch (event.type) {
      case 'turn/start':
        this.onTurnStart(state, event.data)
        break
      case 'session/title':
        this.onSessionTitle(state, event.data)
        break
      case 'user/message':
        this.onUserMessage(state, event.data)
        break
      case 'step/start':
        this.onStepStart(state, event.data)
        break
      case 'assistant/message':
        this.onAssistantMessage(state, event.data)
        break
      case 'llm/retry':
        if (event.data && typeof event.data === 'object') state.retries.push(event.data)
        break
      case 'approval/asked':
        this.onApprovalAsked(state, event.data)
        break
      case 'approval/decided':
        this.onApprovalDecided(state, event.data)
        break
      case 'tool/call':
        this.onToolCall(state, event.data)
        break
      case 'tool/result':
        this.onToolResult(state, event.data)
        break
      case 'tool/ptc-dispatch-start':
        this.onPtcDispatchStart(state, event.data)
        break
      case 'tool/ptc-dispatch':
        this.onPtcDispatch(state, event.data)
        break
      case 'turn/end':
        this.onTurnEnd(state, event.data)
        break
      default:
        break
    }
  }

  /**
   * Admit a queued continuation prompt on the agent idle edge.
   * @param {{agent:any, status:string}} payload
   */
  onAgentStatus(payload) {
    const agent = payload?.agent
    const status = payload?.status
    if (!agent || status !== 'idle' || typeof agent.id !== 'string') return
    const state = this.states.get(agent.id)
    if (!state || state.disposed || !state.pending) return
    this.flushPending(agent, state)
  }

  /**
   * Drop everything known about one session.
   * @param {any} session
   */
  onSessionDisposed(session) {
    if (!session || typeof session.id !== 'string') return
    const state = this.states.get(session.id)
    if (!state) return
    this.disposeState(state)
    this.states.delete(session.id)
  }

  /** Clear all scheduled work (plugin unload). */
  dispose() {
    for (const state of this.states.values()) this.disposeState(state)
    this.states.clear()
  }

  /**
   * @param {any} session
   * @returns {SessionState|undefined}
   */
  ensureState(session) {
    const id = session.id
    let state = this.states.get(id)
    if (state) return state
    const header = session.header ?? {}
    const subagent = header.origin === 'subagent' || (Number(header.delegationDepth) || 0) > 0
    // Sub-agent sessions inherit the parent's cwd (dsh-subagent childSessionMeta),
    // so a cwd label would make them indistinguishable from the main session.
    const parentId = typeof header.parentSession === 'string' ? header.parentSession : ''
    const fallbackLabel = subagent
      ? `子代理 ${id.slice(-8)}${parentId === '' ? '' : `（父 ${parentId.slice(-6)}）`}`
      : header.cwd
        ? basename(String(header.cwd))
        : `session ${id.slice(-8)}`
    state = {
      sessionId: id,
      fallbackLabel,
      subagent,
      label: '',
      title: '',
      turn: null,
      retries: [],
      approvals: new Map(),
      questions: new Map(),
      autoContinueCount: 0,
      lastContinueAt: 0,
      pending: null,
      cooldownTimer: undefined,
      generation: 0,
      disposed: false,
    }
    this.states.set(id, state)
    return state
  }

  /**
   * @param {SessionState} state
   * @param {any} data
   */
  onTurnStart(state, data) {
    const turnNumber = Number(data?.turn)
    // A new turn can start without an idle edge (the Driver immediately runs the
    // next queued turn). A continuation still pending here was never admitted,
    // so drop it without consuming an attempt.
    if (state.pending) {
      state.pending = null
      this.fileLog('auto-continue.skipped', { sessionId: state.sessionId, reason: 'superseded' })
    }
    this.clearPending(state)
    state.generation += 1
    // Keep the latest human label: turns driven by the plugin/goal/scheduler
    // must still be identifiable in notifications, and a cwd fallback would
    // lose the task context (observed in real notifications).
    state.turn = {
      number: Number.isFinite(turnNumber) ? turnNumber : 0,
      startedAt: this.now(),
      steps: 0,
      lastAssistantText: '',
    }
    state.retries = []
    if (this.config.notifyOnStart && this.sessionVisible(state)) {
      this.emit(state, { phase: 'start', label: sessionLabel(state) })
    }
  }

  /**
   * Keep the latest durable session title: the Host writes it from the
   * configured title policy, so it is the best user-facing name for the
   * session and survives across turns.
   * @param {SessionState} state
   * @param {{title?:string}} data - `session/title` payload.
   */
  onSessionTitle(state, data) {
    const title = typeof data?.title === 'string' ? clip(data.title.trim(), 80) : ''
    if (title !== '') state.title = title
  }

  /**
   * @param {SessionState} state
   * @param {any} message
   */
  onUserMessage(state, message) {
    const text = messageText(message)
    const sourceKind = message?.source?.kind
    if (sourceKind === 'user') {
      state.label = clip(text, 60)
      // A fresh human prompt starts a fresh task budget.
      state.autoContinueCount = 0
      state.generation += 1
      this.clearPending(state)
    }
  }

  /**
   * @param {SessionState} state
   * @param {any} data
   */
  onStepStart(state, data) {
    if (!state.turn) return
    const step = Number(data?.step)
    if (Number.isFinite(step)) state.turn.steps = Math.max(state.turn.steps, step)
    if (this.config.notifyOnStep && this.sessionVisible(state)) {
      this.emit(state, {
        phase: 'step',
        label: sessionLabel(state),
        steps: state.turn.steps,
      })
    }
  }

  /**
   * @param {SessionState} state
   * @param {any} data
   */
  onAssistantMessage(state, data) {
    if (!state.turn) return
    const text = messageText(data?.message)
    if (text.trim() !== '') state.turn.lastAssistantText = text
  }

  /**
   * @param {SessionState} state
   * @param {any} data - `turn/end` payload.
   */
  onTurnEnd(state, data) {
    const kind = reasonKind(data?.reason)
    const failure = kind === 'error' ? data?.reason?.error : undefined
    const turn = state.turn
    const durationMs = turn ? Math.max(0, this.now() - turn.startedAt) : undefined
    const steps = turn?.steps ?? 0
    const label = sessionLabel(state)

    if (kind === 'completed') {
      // The task succeeded: the next failure starts a fresh continuation budget.
      state.autoContinueCount = 0
    }
    if (state.subagent && !this.config.notifySubagents) {
      state.turn = null
      return
    }

    const autoContinue =
      kind === 'error' && !state.subagent ? this.decideContinuation(state, failure, data?.turn) : undefined
    const phase = phaseForReason(kind)
    if (this.shouldNotify(phase)) {
      this.emit(state, {
        phase,
        label,
        durationMs,
        steps,
        turn: turn?.number,
        failure,
        preview: turn?.lastAssistantText,
        includePreview: this.config.includePreview,
        autoContinue,
        abortCause: kind === 'aborted' ? abortCauseText(data?.reason?.reason, this.config.locale) : undefined,
      })
    }
    state.turn = null
  }

  /**
   * Decide whether the failed turn earns a continuation prompt.
   *
   * The prompt itself is queued on the idle edge (see `onAgentStatus`).
   *
   * @param {SessionState} state
   * @param {unknown} failure
   * @returns {{attempt:number,max:number}|{skipped:string}}
   */
  decideContinuation(state, failure, turnNumber) {
    const policy = this.config.autoContinue
    if (!policy.enabled) return { skipped: 'disabled' }
    // A plugin mounted after this turn started (hot reload / patch reload) never
    // saw turn/start. The durable failure is still actionable; only strict mode
    // needs the turn's retry chain and therefore the context.
    if (!state.turn && policy.requireRetryExhausted) return { skipped: 'no-turn-context' }
    // Every continuation target is a transient network/model-request failure.
    // Codes outside this set (AUTH, UNKNOWN-with-generic-message, ...) never
    // continue: retrying a credential or policy error only burns attempts.
    const code = failureCode(failure)?.toUpperCase()
    const knownCode = code !== undefined && policy.retryableCodes.includes(code)
    // DSH wraps non-LlmError throws with `code:'UNKNOWN'`; a network-shaped
    // message is the only signal left, so allow one bounded attempt.
    const networkShaped =
      !knownCode && (code === undefined || code === 'UNKNOWN') && isNetworkFailureMessage(failure)
    if (!knownCode && !networkShaped) return { skipped: 'not-retryable' }
    if (policy.requireRetryExhausted) {
      const exhausted = isRetryExhaustedFailure({
        turnEvents: retriesForTurn(state.retries, turnNumber).map((retry) => ({ type: 'llm/retry', data: retry })),
        failure,
        retryableCodes: policy.retryableCodes,
      })
      if (!exhausted) return { skipped: 'not-retry-exhausted' }
    }
    const max = Math.min(policy.maxAttempts, HARD_CONTINUE_LIMIT)
    if (state.autoContinueCount >= max) return { skipped: 'max-attempts' }
    if (state.pending) return { skipped: 'cooldown' }
    const agent = this.resolveAgent(state.sessionId)
    if (!agent) return { skipped: 'agent-gone' }
    if (inboxBusy(agent)) return { skipped: 'inbox-busy' }
    // A queued next-turn entry makes the Driver start that turn without an idle
    // edge, which would supersede our pending prompt. Skip so the attempt
    // budget is not wasted on a prompt that can never be admitted.
    if (nextTurnPending(agent)) return { skipped: 'next-turn-pending' }

    // The attempt is reserved here but only counted once `followup` succeeds.
    const attempt = state.autoContinueCount + 1
    const retryAfterMs = policy.respectProviderRetryAfter ? providerRetryAfterMs(failure) : 0
    if (retryAfterMs > PROVIDER_RETRY_CAP_MS) return { skipped: 'provider-retry-after' }
    state.pending = {
      attempt,
      max,
      generation: state.generation,
      ...(retryAfterMs > 0 ? { notBefore: this.now() + retryAfterMs } : {}),
    }
    this.fileLog('auto-continue.pending', {
      sessionId: state.sessionId,
      attempt,
      max,
      ...(retryAfterMs > 0 ? { retryAfterMs } : {}),
    })
    return { attempt, max }
  }

  /**
   * Admit the pending continuation prompt now, or after the configured cooldown.
   * @param {any} agent
   * @param {SessionState} state
   */
  flushPending(agent, state) {
    const pending = state.pending
    if (!pending || state.disposed) return
    if (pending.generation !== state.generation) {
      state.pending = null
      this.fileLog('auto-continue.skipped', { sessionId: state.sessionId, reason: 'superseded' })
      return
    }
    const live = this.resolveAgent(state.sessionId)
    if (!live || live !== agent) {
      state.pending = null
      this.fileLog('auto-continue.skipped', { sessionId: state.sessionId, reason: 'agent-gone' })
      return
    }
    if (inboxBusy(agent)) {
      state.pending = null
      this.fileLog('auto-continue.skipped', { sessionId: state.sessionId, reason: 'inbox-busy' })
      return
    }
    if (nextTurnPending(agent)) {
      state.pending = null
      this.fileLog('auto-continue.skipped', { sessionId: state.sessionId, reason: 'next-turn-pending' })
      return
    }

    const cooldownWait =
      state.lastContinueAt > 0 ? this.config.autoContinue.cooldownMs - (this.now() - state.lastContinueAt) : 0
    const notBeforeWait = pending.notBefore ? pending.notBefore - this.now() : 0
    const wait = Math.max(cooldownWait, notBeforeWait)
    if (wait > 0) {
      if (state.cooldownTimer === undefined) {
        const timer = this.setTimeoutFn(() => {
          this.timers.delete(timer)
          state.cooldownTimer = undefined
          this.flushPending(agent, state)
        }, wait)
        this.timers.add(timer)
        state.cooldownTimer = timer
        this.fileLog('auto-continue.cooldown', { sessionId: state.sessionId, waitMs: wait })
      }
      return
    }

    state.pending = null
    const generation = state.generation
    // Defer the admit by one microtask: the Host emits `agent/status idle` and
    // the continuation turn can start inside the same synchronous listener
    // pass, so a client that processes the status frames in order can end up
    // seeing `running=false` after the turn already began (the composer then
    // keeps showing Send instead of Stop). Letting the idle dispatch finish
    // first keeps the running transition last.
    queueMicrotask(() => {
      if (state.disposed || state.generation !== generation) {
        this.fileLog('auto-continue.skipped', { sessionId: state.sessionId, reason: 'superseded' })
        return
      }
      try {
        agent.followup(createPluginMessage(this.config.autoContinue.message))
        // Count the attempt only after the prompt was actually admitted.
        state.autoContinueCount = pending.attempt
        state.lastContinueAt = this.now()
        this.fileLog('auto-continue.sent', {
          sessionId: state.sessionId,
          attempt: pending.attempt,
          max: pending.max,
          message: this.config.autoContinue.message,
        })
        this.log(
          'info',
          `sent continuation prompt after exhausted model retries (${pending.attempt}/${pending.max})`,
        )
      } catch (error) {
        this.fileLog('auto-continue.error', {
          sessionId: state.sessionId,
          reason: String(error?.message ?? error),
        })
        this.log('warn', `continuation prompt failed: ${String(error?.message ?? error)}`)
      }
    })
  }

  /**
   * @param {SessionState} state
   * @param {object} event - notification fields (see `buildNotification`).
   */
  emit(state, event) {
    const notification = buildNotification({
      ...event,
      titlePrefix: this.config.titlePrefix,
      maxBodyChars: this.config.maxBodyChars,
      locale: this.config.locale,
      titleSessionLabel: this.config.titleSessionLabel,
    })
    this.fileLog('notification.dispatch', {
      sessionId: state.sessionId,
      phase: event.phase,
      title: notification.title,
      body: notification.body,
    })
    Promise.resolve()
      .then(() => this.notifier.dispatch(notification, { phase: event.phase }))
      .then((result) => {
        if (result && result.ok === false) {
          this.log('warn', `notification unavailable (${String(result.detail ?? 'unknown')})`)
        }
      })
      .catch((error) => {
        this.log('warn', `notification dispatch failed: ${String(error?.message ?? error)}`)
      })
  }

  /**
   * @param {string} sessionId
   * @returns {any}
   */
  resolveAgent(sessionId) {
    try {
      return this.agents?.get?.(sessionId)
    } catch {
      return undefined
    }
  }

  /**
   * Drop a pending continuation and its cooldown timer.
   * @param {SessionState} state
   */
  clearPending(state) {
    state.pending = null
    if (state.cooldownTimer !== undefined) {
      try {
        this.clearTimeoutFn(state.cooldownTimer)
      } catch {
        // Ignore teardown races.
      }
      this.timers.delete(state.cooldownTimer)
      state.cooldownTimer = undefined
    }
  }

  /**
   * Hold an approval alert for a short grace window. DSH always appends
   * `approval/asked` before the answerers run, including the automatic paths
   * (policy `never`, a non-interactive answerer, cancellation). Those append
   * `approval/decided` immediately, so only an ask that is still pending after
   * the grace window is worth an OS notification.
   * @param {SessionState} state
   * @param {{id?:string, toolName?:string, reason?:string}} data - `approval/asked` payload.
   */
  onApprovalAsked(state, data) {
    if (!this.config.notifyOnApproval) return
    if (!this.sessionVisible(state)) return
    const id = typeof data?.id === 'string' ? data.id : ''
    if (id === '' || state.approvals.has(id)) return
    const toolName = typeof data?.toolName === 'string' ? data.toolName : ''
    const reason = typeof data?.reason === 'string' ? data.reason : ''
    const askedAt = this.now()
    const graceMs = Number.isFinite(this.config.approvalGraceMs) ? this.config.approvalGraceMs : 1000
    const entry = { timer: undefined, toolName, reason, askedAt, notified: false, reminders: 0 }
    this.scheduleApprovalTimer(state, id, entry, graceMs)
    state.approvals.set(id, entry)
    this.fileLog('approval.asked', {
      sessionId: state.sessionId,
      approvalId: id,
      toolName,
      graceMs,
    })
  }

  /**
   * @param {SessionState} state
   * @param {string} id
   * @param {any} entry
   * @param {number} delayMs
   */
  scheduleApprovalTimer(state, id, entry, delayMs) {
    const timer = this.setTimeoutFn(() => {
      this.timers.delete(timer)
      this.fireApproval(state, id, entry)
    }, delayMs)
    entry.timer = timer
    this.timers.add(timer)
  }

  /**
   * Emit one approval alert and schedule the next reminder while it is still
   * pending. Reminders stop after {@link MAX_REMINDERS} or when disabled.
   * @param {SessionState} state
   * @param {string} id
   * @param {any} entry
   */
  fireApproval(state, id, entry) {
    if (state.approvals.get(id) !== entry) return
    if (state.disposed) {
      state.approvals.delete(id)
      return
    }
    entry.timer = undefined
    entry.notified = true
    const reminder = entry.reminders > 0
    this.emit(state, {
      phase: 'approval',
      label: sessionLabel(state),
      approval: { toolName: entry.toolName, reason: entry.reason, reminder },
    })
    this.fileLog(reminder ? 'approval.reminder' : 'approval.notified', {
      sessionId: state.sessionId,
      approvalId: id,
      toolName: entry.toolName,
      reminder: entry.reminders,
    })
    const interval = Number.isFinite(this.config.reminderMs) ? this.config.reminderMs : 0
    if (interval > 0 && entry.reminders < MAX_REMINDERS) {
      entry.reminders += 1
      this.scheduleApprovalTimer(state, id, entry, interval)
    }
  }

  /**
   * Clear an approval alert when the decision lands before (or after) the
   * grace window; an answered approval must never leave a stale timer behind.
   * @param {SessionState} state
   * @param {{id?:string, outcome?:string}} data - `approval/decided` payload.
   */
  onApprovalDecided(state, data) {
    const id = typeof data?.id === 'string' ? data.id : ''
    const entry = id === '' ? undefined : state.approvals.get(id)
    if (entry === undefined) return
    if (entry.timer !== undefined) {
      try {
        this.clearTimeoutFn(entry.timer)
      } catch {
        // Ignore teardown races.
      }
      this.timers.delete(entry.timer)
    }
    state.approvals.delete(id)
    this.fileLog('approval.decided', {
      sessionId: state.sessionId,
      approvalId: id,
      outcome: typeof data?.outcome === 'string' ? data.outcome : undefined,
      waitedMs: this.now() - entry.askedAt,
    })
  }

  /**
   * Notify when DSH is waiting on the user through a native tool call. DSH
   * 0.2.2 adds `ask_user_question` (blocking or timed) and plan mode's
   * `exit_plan_mode` review; both record a durable `tool/call` and stay open
   * until the matching `tool/result`. A grace window avoids alerting when the
   * user answers immediately.
   * @param {SessionState} state
   * @param {{callId?:string, name?:string, arguments?:string}} data - `tool/call` payload.
   */
  onToolCall(state, data) {
    const name = typeof data?.name === 'string' ? data.name : ''
    if (!QUESTION_TOOL_NAMES.has(name)) return
    this.startQuestion(state, typeof data?.callId === 'string' ? data.callId : '', name, data?.arguments)
  }

  /**
   * Close a pending question when its native tool result lands (answered,
   * skipped, aborted, or timed out to `pending`).
   * @param {SessionState} state
   * @param {any} data - `tool/result` payload.
   */
  onToolResult(state, data) {
    const callId = toolCallIdOf(data)
    if (callId === '') return
    this.finishQuestion(state, callId, {
      pending: isPendingContent(data?.message?.content),
      isError: data?.message?.isError === true,
    })
  }

  /**
   * A PTC sub-call (`run_code` → `ask_user_question` / `exit_plan_mode`) records
   * `tool/ptc-dispatch-start` before executing, so the same alert logic applies
   * to questions asked from generated code.
   * @param {SessionState} state
   * @param {{subCallId?:string, name?:string, arguments?:unknown}} data
   */
  onPtcDispatchStart(state, data) {
    const name = typeof data?.name === 'string' ? data.name : ''
    if (!QUESTION_TOOL_NAMES.has(name)) return
    this.startQuestion(
      state,
      typeof data?.subCallId === 'string' ? data.subCallId : '',
      name,
      data?.arguments,
    )
  }

  /**
   * @param {SessionState} state
   * @param {{subCallId?:string, isError?:boolean, content?:unknown}} data - `tool/ptc-dispatch` payload.
   */
  onPtcDispatch(state, data) {
    const callId = typeof data?.subCallId === 'string' ? data.subCallId : ''
    if (callId === '') return
    this.finishQuestion(state, callId, {
      pending: isPendingContent(data?.content),
      isError: data?.isError === true,
    })
  }

  /**
   * Schedule one question alert. The entry remembers whether a toast already
   * went out so a later `pending` result cannot double-notify.
   * @param {SessionState} state
   * @param {string} callId
   * @param {string} name
   * @param {unknown} argumentsValue - raw JSON text (native) or parsed object (PTC).
   */
  startQuestion(state, callId, name, argumentsValue) {
    if (!this.config.notifyOnQuestion) return
    if (!this.sessionVisible(state)) return
    if (callId === '' || state.questions.has(callId)) return
    const detail = questionDetailOf(name, argumentsValue)
    const askedAt = this.now()
    const graceMs = Number.isFinite(this.config.questionGraceMs) ? this.config.questionGraceMs : 1000
    const entry = {
      timer: undefined,
      kind: detail.kind,
      summary: detail.summary,
      count: detail.count,
      askedAt,
      notified: false,
      reminders: 0,
    }
    this.scheduleQuestionTimer(state, callId, entry, graceMs)
    state.questions.set(callId, entry)
    this.fileLog('question.asked', {
      sessionId: state.sessionId,
      callId,
      kind: entry.kind,
      graceMs,
    })
  }

  /**
   * @param {SessionState} state
   * @param {string} callId
   * @param {any} entry
   * @param {number} delayMs
   */
  scheduleQuestionTimer(state, callId, entry, delayMs) {
    const timer = this.setTimeoutFn(() => {
      this.timers.delete(timer)
      this.fireQuestion(state, callId, entry)
    }, delayMs)
    entry.timer = timer
    this.timers.add(timer)
  }

  /**
   * Emit one question alert and keep reminding while it stays unanswered.
   * @param {SessionState} state
   * @param {string} callId
   * @param {any} entry
   */
  fireQuestion(state, callId, entry) {
    if (state.questions.get(callId) !== entry) return
    if (state.disposed) {
      state.questions.delete(callId)
      return
    }
    entry.timer = undefined
    entry.notified = true
    const reminder = entry.reminders > 0
    this.emit(state, {
      phase: 'question',
      label: sessionLabel(state),
      question: {
        kind: entry.kind,
        summary: entry.summary,
        count: entry.count,
        reminder,
      },
    })
    this.fileLog(reminder ? 'question.reminder' : 'question.notified', {
      sessionId: state.sessionId,
      callId,
      kind: entry.kind,
      reminder: entry.reminders,
    })
    const interval = Number.isFinite(this.config.reminderMs) ? this.config.reminderMs : 0
    if (interval > 0 && entry.reminders < MAX_REMINDERS) {
      entry.reminders += 1
      this.scheduleQuestionTimer(state, callId, entry, interval)
    }
  }

  /**
   * Clear a question alert and, when the foreground wait ended as `pending`
   * before the grace timer could fire (very short timed waits), still alert
   * once: the question stays answerable after the timeout.
   * @param {SessionState} state
   * @param {string} callId
   * @param {{pending:boolean, isError:boolean}} outcome
   */
  finishQuestion(state, callId, outcome) {
    const entry = state.questions.get(callId)
    if (entry === undefined) return
    if (entry.timer !== undefined) {
      try {
        this.clearTimeoutFn(entry.timer)
      } catch {
        // Ignore teardown races.
      }
      this.timers.delete(entry.timer)
    }
    state.questions.delete(callId)
    if (outcome.pending && !entry.notified && !state.disposed && this.config.notifyOnQuestion) {
      this.emit(state, {
        phase: 'question',
        label: sessionLabel(state),
        question: {
          kind: entry.kind,
          summary: entry.summary,
          count: entry.count,
          pending: true,
        },
      })
      this.fileLog('question.pending-notified', {
        sessionId: state.sessionId,
        callId,
        kind: entry.kind,
      })
    }
    this.fileLog('question.resolved', {
      sessionId: state.sessionId,
      callId,
      isError: outcome.isError,
      pending: outcome.pending,
      waitedMs: this.now() - entry.askedAt,
    })
  }

  /**
   * @param {SessionState} state
   */
  disposeState(state) {
    state.disposed = true
    this.clearPending(state)
    for (const entry of state.approvals.values()) {
      if (entry.timer === undefined) continue
      try {
        this.clearTimeoutFn(entry.timer)
      } catch {
        // Ignore teardown races.
      }
      this.timers.delete(entry.timer)
    }
    state.approvals.clear()
    for (const entry of state.questions.values()) {
      if (entry.timer === undefined) continue
      try {
        this.clearTimeoutFn(entry.timer)
      } catch {
        // Ignore teardown races.
      }
      this.timers.delete(entry.timer)
    }
    state.questions.clear()
  }

  /**
   * Whether lifecycle notifications for this session are wanted. A sub-agent
   * session inherits the parent cwd, so notifying it would look like a
   * duplicate of the main session; `notifySubagents` opts in.
   * @param {SessionState} state
   * @returns {boolean}
   */
  sessionVisible(state) {
    return !state.subagent || this.config.notifySubagents
  }

  /**
   * @param {string} phase
   * @returns {boolean}
   */
  shouldNotify(phase) {
    switch (phase) {
      case 'error':
      case 'blocked':
      case 'interrupted':
        return this.config.notifyOnError
      case 'aborted':
        return this.config.notifyOnAbort
      case 'start':
        return this.config.notifyOnStart
      case 'step':
        return this.config.notifyOnStep
      case 'approval':
        return this.config.notifyOnApproval
      case 'question':
        return this.config.notifyOnQuestion
      case 'max-tokens':
      case 'complete':
        return this.config.notifyOnComplete
      case 'unknown':
        // An unrecognized durable reason kind is not a success; stay silent.
        return false
      default:
        return this.config.notifyOnComplete
    }
  }
}

/**
 * Whether the agent already holds pending **human** input.
 *
 * The inbox also carries system-generated entries: background-job results
 * (`tool-jobs`), time-context snapshots, and other plugins' messages. Those
 * must not suppress the retry-recovery prompt — a failed task that ends while
 * an unrelated job notice is queued should still continue. Only a message the
 * user wrote wins over the continuation. Entries without an identifiable
 * source stay conservative (treated as human input).
 *
 * @param {any} agent
 * @returns {boolean}
 */
export function inboxBusy(agent) {
  return queueHasHumanInput(agent?.inbox?.nextTurn) || queueHasHumanInput(agent?.inbox?.nextStep)
}

/**
 * @param {any} entries - one inbox queue (`nextTurn` / `nextStep`).
 * @returns {boolean}
 */
function queueHasHumanInput(entries) {
  if (!Array.isArray(entries)) return false
  return entries.some((message) => {
    const kind = message?.source?.kind
    return kind === undefined || kind === 'user'
  })
}

/**
 * Whether the inbox holds a next-turn entry. The Driver starts that turn
 * immediately after `turn/end`, without an idle edge.
 * @param {any} agent
 * @returns {boolean}
 */
function nextTurnPending(agent) {
  const nextTurn = agent?.inbox?.nextTurn
  return Array.isArray(nextTurn) && nextTurn.length > 0
}

/**
 * Best available label for a session: durable title, then the latest human
 * prompt, then the cwd-derived fallback.
 * @param {SessionState} state
 * @returns {string}
 */
function sessionLabel(state) {
  return state.title || state.label || state.fallbackLabel
}

/**
 * Keep only the `llm/retry` payloads that belong to one turn.
 * @param {Array<any>} retries
 * @param {unknown} turnNumber
 * @returns {Array<any>}
 */
function retriesForTurn(retries, turnNumber) {
  const turn = Number(turnNumber)
  if (!Number.isFinite(turn)) return retries.slice()
  return retries.filter((retry) => !retry || retry.turn === undefined || retry.turn === turn)
}

/**
 * Read the provider-requested retry delay of a terminal LLM failure.
 * @param {unknown} failure
 * @returns {number}
 */
function providerRetryAfterMs(failure) {
  const value = Number(/** @type {any} */ (failure)?.providerRetryAfterMs)
  return Number.isFinite(value) && value > 0 ? value : 0
}

/**
 * Read the call id out of a durable `tool/result` payload. DSH records it on
 * the tool message as `toolCallId` and as `message.source.callId`; accept both.
 * @param {any} data
 * @returns {string}
 */
function toolCallIdOf(data) {
  const direct = data?.message?.toolCallId
  if (typeof direct === 'string' && direct !== '') return direct
  const source = data?.message?.source?.callId
  return typeof source === 'string' ? source : ''
}

/**
 * Whether a recorded tool result content block carries the timed question's
 * `{"pending": true, ...}` payload.
 * @param {unknown} content
 * @returns {boolean}
 */
function isPendingContent(content) {
  if (!Array.isArray(content)) return false
  const text = content.find((block) => block && block.type === 'text')
  if (!text || typeof text.text !== 'string') return false
  try {
    const parsed = JSON.parse(text.text)
    return typeof parsed === 'object' && parsed !== null && parsed.pending === true
  } catch {
    return false
  }
}

/**
 * Derive the notification summary for one user-facing tool call.
 * @param {string} name - tool name from the durable call event.
 * @param {unknown} argumentsValue - raw JSON text (native `tool/call`) or the
 *   parsed arguments object (`tool/ptc-dispatch-start`).
 * @returns {{kind:'question'|'plan-review', summary:string, count:number}}
 */
function questionDetailOf(name, argumentsValue) {
  const kind = name === PLAN_REVIEW_TOOL ? 'plan-review' : 'question'
  const fallback = { kind, summary: '', count: 0 }
  let parsed = argumentsValue
  if (typeof parsed === 'string') {
    if (parsed === '') return fallback
    try {
      parsed = JSON.parse(parsed)
    } catch {
      return fallback
    }
  }
  if (parsed === null || typeof parsed !== 'object') return fallback
  if (kind === 'plan-review') {
    const plan = typeof parsed.plan === 'string' ? parsed.plan : ''
    const heading = /^#\s+(.+)$/m.exec(plan)?.[1] ?? ''
    return { kind, summary: clip(heading.trim(), 120), count: 0 }
  }
  const questions = Array.isArray(parsed.questions) ? parsed.questions : []
  const first = questions[0]
  const raw = first && typeof first === 'object' ? first.question ?? first.header : ''
  return {
    kind,
    summary: clip(String(raw ?? '').trim(), 120),
    count: questions.length,
  }
}

/**
 * Build the model-facing continuation prompt. Shape matches
 * `createUserMessage` from dsh-llm without importing the harness package, so
 * the plugin stays loadable from an arbitrary directory.
 *
 * The source kind is producer-owned (`task-notifier`, not the retired
 * `plugin` wrapper): the durable session format used by `session-log-deepseek`
 * rejects `kind: 'plugin'` messages at replay time.
 * @param {string} text
 * @returns {{id:string, role:'user', content:Array<{type:'text', text:string}>, source:{kind:string, plugin:string}}}
 */
export function createPluginMessage(text) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: PLUGIN_NAME, plugin: PLUGIN_NAME },
  }
}

/**
 * Render a durable cancellation cause for a notification body.
 * @param {any} cause
 * @param {string} [locale] - effective notification locale.
 * @returns {string|undefined}
 */
export function abortCauseText(cause, locale) {
  if (!cause || typeof cause !== 'object') return undefined
  const messages = messagesFor(locale)
  switch (cause.kind) {
    case 'user':
      return messages.abort.user
    case 'parent':
      return messages.abort.parent
    case 'hook':
      return cause.reason ? `${messages.abort.hookPrefix}${cause.reason}` : messages.abort.hook
    case 'disposed':
      return messages.abort.disposed
    default:
      return typeof cause.kind === 'string' ? cause.kind : undefined
  }
}
