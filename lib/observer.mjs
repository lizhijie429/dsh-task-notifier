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
  isRetryExhaustedFailure,
  messageText,
  phaseForReason,
  reasonKind,
} from './format.mjs'
import { HARD_CONTINUE_LIMIT } from './config.mjs'

export const PLUGIN_NAME = 'task-notifier'

/** Longest provider-requested retry delay we are willing to wait out. */
const PROVIDER_RETRY_CAP_MS = 120_000

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
 * @property {{number:number, startedAt:number, steps:number, prompt:string, lastAssistantText:string}|null} turn
 * @property {Array<any>} retries - durable `llm/retry` payloads of the current turn.
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
    state = {
      sessionId: id,
      fallbackLabel: header.cwd ? basename(String(header.cwd)) : `session ${id.slice(-8)}`,
      subagent,
      label: '',
      title: '',
      turn: null,
      retries: [],
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
    state.label = ''
    state.turn = {
      number: Number.isFinite(turnNumber) ? turnNumber : 0,
      startedAt: this.now(),
      steps: 0,
      prompt: '',
      lastAssistantText: '',
    }
    state.retries = []
    if (this.config.notifyOnStart) {
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
      if (state.turn) state.turn.prompt = text
      // A fresh human prompt starts a fresh task budget.
      state.autoContinueCount = 0
      state.generation += 1
      this.clearPending(state)
      return
    }
    if (state.turn && text.trim() !== '') state.turn.prompt ||= text
  }

  /**
   * @param {SessionState} state
   * @param {any} data
   */
  onStepStart(state, data) {
    if (!state.turn) return
    const step = Number(data?.step)
    if (Number.isFinite(step)) state.turn.steps = Math.max(state.turn.steps, step)
    if (this.config.notifyOnStep) {
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
        abortCause: kind === 'aborted' ? abortCauseText(data?.reason?.reason) : undefined,
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
    if (!state.turn) return { skipped: 'no-turn-context' }
    // Every continuation target is a transient network/model-request failure.
    // Codes outside this set (AUTH, UNKNOWN, ...) never continue: retrying a
    // credential or policy error only burns attempts.
    const code = failureCode(failure)?.toUpperCase()
    if (code === undefined || !policy.retryableCodes.includes(code)) return { skipped: 'not-retryable' }
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
    })
    this.fileLog('notification.dispatch', {
      sessionId: state.sessionId,
      phase: event.phase,
      title: notification.title,
      body: notification.body,
    })
    Promise.resolve()
      .then(() => this.notifier.dispatch(notification))
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
   * @param {SessionState} state
   */
  disposeState(state) {
    state.disposed = true
    this.clearPending(state)
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
 * @returns {string|undefined}
 */
export function abortCauseText(cause) {
  if (!cause || typeof cause !== 'object') return undefined
  switch (cause.kind) {
    case 'user':
      return '用户取消'
    case 'parent':
      return '父级会话取消'
    case 'hook':
      return cause.reason ? `钩子取消：${cause.reason}` : '钩子取消'
    case 'disposed':
      return '会话被释放'
    default:
      return typeof cause.kind === 'string' ? cause.kind : undefined
  }
}
