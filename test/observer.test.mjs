import assert from 'node:assert/strict'
import { test } from 'node:test'
import { normalizeConfig } from '../lib/config.mjs'
import { TaskObserver, createPluginMessage, inboxBusy } from '../lib/observer.mjs'

const PLUGIN_DIR = '/plugins/dsh-task-notifier'

function makeConfig(overrides = {}) {
  return normalizeConfig(overrides, PLUGIN_DIR).config
}

function makeSession(id = 'session-1', header = { cwd: '/work/project' }) {
  return { id, header }
}

function makeAgent(options = {}) {
  const calls = []
  const agent = {
    id: options.id ?? 'session-1',
    status: options.status ?? 'running',
    inbox: {
      nextTurn: options.inboxPending
        ? [{ id: 'pending' }]
        : options.inboxNextTurnNotices
          ? [{ id: 'queued', role: 'user', source: { kind: 'tool-jobs' } }]
          : [],
      nextStep: options.inboxNotices
        ? [{ id: 'notice', role: 'user', source: { kind: 'tool-jobs' }, content: [{ type: 'text', text: 'job finished' }] }]
        : [],
    },
    whenIdle: async () => {},
    followup(message) {
      calls.push(message)
    },
  }
  return { agent, calls }
}

function makeObserver(observerOptions = {}) {
  const notifications = []
  const notificationMetas = []
  const fileLogs = []
  const timers = []
  const clock = { now: 1_000_000 }
  const config = observerOptions.config ?? makeConfig()
  const notifier = {
    async dispatch(notification, meta) {
      notifications.push(notification)
      notificationMetas.push(meta)
      return { ok: true }
    },
  }
  const agent = observerOptions.agent
  const observer = new TaskObserver({
    config,
    log: () => {},
    fileLog: (event, data) => fileLogs.push({ event, data }),
    notifier,
    agents: { get: () => agent },
    now: () => clock.now,
    setTimeoutFn: (fn, delay) => {
      const timer = { fn, delay }
      timers.push(timer)
      return timer
    },
    clearTimeoutFn: (timer) => {
      const index = timers.indexOf(timer)
      if (index >= 0) timers.splice(index, 1)
    },
  })
  return { observer, notifications, notificationMetas, fileLogs, timers, clock, agent }
}

function flushMicrotasks() {
  return new Promise((resolve) => setImmediate(resolve))
}

function turnStart(turn) {
  return { type: 'turn/start', data: { turn } }
}

function humanMessage(text) {
  return {
    type: 'user/message',
    data: { content: [{ type: 'text', text }], source: { kind: 'user' } },
  }
}

function retryEvent(turn, retry, maxRetries) {
  return {
    type: 'llm/retry',
    data: { turn, step: 1, mode: 'normal', retry, maxRetries, delayMs: 10, failure: { code: 'SERVER' } },
  }
}

function turnEnd(turn, reason) {
  return { type: 'turn/end', data: { turn, reason } }
}

function assistantMessage(text) {
  return {
    type: 'assistant/message',
    data: { turn: 1, step: 1, message: { content: [{ type: 'text', text }] } },
  }
}

async function goIdle(harness) {
  harness.observer.onAgentStatus({ agent: harness.agent, status: 'idle' })
  await flushMicrotasks()
}

async function driveFailure(
  harness,
  {
    turn,
    retries = [5],
    maxRetries = retries.at(-1),
    code = 'SERVER',
    message = 'upstream 502',
    human = turn === 1,
    failure = {},
  } = {},
) {
  const { observer, notifications, timers } = harness
  const session = harness.session
  observer.onSessionEvent(session, turnStart(turn))
  if (human) observer.onSessionEvent(session, humanMessage('帮我修一下登录接口'))
  for (const retry of retries) observer.onSessionEvent(session, retryEvent(turn, retry, maxRetries))
  if (turn === 1) observer.onSessionEvent(session, assistantMessage('正在检查代码…'))
  observer.onSessionEvent(session, turnEnd(turn, { kind: 'error', error: { code, message, ...failure } }))
  await flushMicrotasks()
  return { notifications, timers }
}

test('completed turn sends a success notification with preview', async () => {
  const { agent } = makeAgent()
  const harness = makeObserver({ agent, config: makeConfig({ includePreview: true }) })
  harness.session = makeSession()
  harness.observer.onSessionEvent(harness.session, turnStart(1))
  harness.observer.onSessionEvent(harness.session, humanMessage('修复登录接口'))
  harness.observer.onSessionEvent(harness.session, assistantMessage('已完成修复。'))
  harness.observer.onSessionEvent(harness.session, turnEnd(1, { kind: 'completed' }))
  await flushMicrotasks()

  assert.equal(harness.notifications.length, 1)
  assert.match(harness.notifications[0].title, /任务完成/)
  assert.match(harness.notifications[0].body, /修复登录接口/)
  assert.match(harness.notifications[0].body, /已完成修复/)
})

test('the model preview stays hidden by default', async () => {
  const { agent } = makeAgent()
  const harness = makeObserver({ agent })
  harness.session = makeSession()
  harness.observer.onSessionEvent(harness.session, turnStart(1))
  harness.observer.onSessionEvent(harness.session, humanMessage('修复登录接口'))
  harness.observer.onSessionEvent(harness.session, assistantMessage('SECRET model output'))
  harness.observer.onSessionEvent(harness.session, turnEnd(1, { kind: 'completed' }))
  await flushMicrotasks()
  assert.doesNotMatch(harness.notifications[0].body, /SECRET/)
})

test('retry-exhausted failure admits the continuation prompt on the idle edge', async () => {
  const { agent, calls } = makeAgent()
  const harness = makeObserver({ agent })
  harness.session = makeSession()
  const { notifications } = await driveFailure(harness, { turn: 1, retries: [1, 2, 3] })

  assert.equal(notifications.length, 1)
  assert.match(notifications[0].title, /任务失败/)
  assert.match(notifications[0].body, /SERVER: upstream 502/)
  assert.match(notifications[0].body, /已排队「继续」（1\/3）/)
  assert.equal(calls.length, 0, 'the prompt waits for the idle edge')

  await goIdle(harness)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].role, 'user')
  assert.equal(calls[0].content[0].text, '继续')
  assert.equal(calls[0].source.kind, 'task-notifier')
  assert.equal(calls[0].source.plugin, 'task-notifier')
  assert.match(calls[0].id, /^[0-9a-f-]{36}$/)
})

test('non-retryable failure is reported without continuing', async () => {
  const { agent, calls } = makeAgent()
  const harness = makeObserver({ agent })
  harness.session = makeSession()
  const { notifications } = await driveFailure(harness, { turn: 1, retries: [], code: 'AUTH' })
  assert.match(notifications[0].body, /未自动继续：失败不属于可继续的类型/)
  await goIdle(harness)
  assert.equal(calls.length, 0)
})

test('a transport failure without any retry event still continues', async () => {
  // 2026-11-04: the network dropped before the model answered; the turn ended
  // with TRANSPORT after the built-in retry budget, so the continuation must be
  // admitted even with `requireRetryExhausted` off and no llm/retry evidence.
  const { agent, calls } = makeAgent()
  const harness = makeObserver({ agent })
  harness.session = makeSession()
  const { notifications } = await driveFailure(harness, {
    turn: 1,
    retries: [],
    code: 'TRANSPORT',
    message: 'Connection error.',
  })
  assert.match(notifications[0].body, /已排队「继续」（1\/3）/)
  await goIdle(harness)
  assert.equal(calls.length, 1)
})

test('a provider model-request failure without retries continues', async () => {
  const { agent, calls } = makeAgent()
  const harness = makeObserver({ agent })
  harness.session = makeSession()
  const { notifications } = await driveFailure(harness, {
    turn: 1,
    retries: [],
    code: 'PI_AI_ERROR',
    message: 'rpc error: code = Unknown',
  })
  assert.match(notifications[0].body, /已排队「继续」（1\/3）/)
  await goIdle(harness)
  assert.equal(calls.length, 1)
})

test('an unfinished retry budget is not treated as exhausted', async () => {
  const { agent, calls } = makeAgent()
  const harness = makeObserver({
    agent,
    config: makeConfig({ autoContinue: { requireRetryExhausted: true } }),
  })
  harness.session = makeSession()
  const { notifications } = await driveFailure(harness, { turn: 1, retries: [2], maxRetries: 5 })
  assert.match(notifications[0].body, /非模型请求重试耗尽/)
  await goIdle(harness)
  assert.equal(calls.length, 0)
})

test('continuation stops at maxAttempts and reports the cap', async () => {
  const { agent, calls } = makeAgent()
  const harness = makeObserver({ agent, config: makeConfig({ autoContinue: { cooldownMs: 0, maxAttempts: 2 } }) })
  harness.session = makeSession()

  for (let turn = 1; turn <= 2; turn += 1) {
    await driveFailure(harness, { turn, retries: [5] })
    await goIdle(harness)
  }
  assert.equal(calls.length, 2)

  const third = await driveFailure(harness, { turn: 3, retries: [5] })
  assert.match(third.notifications.at(-1).body, /已达自动继续次数上限/)
  await goIdle(harness)
  assert.equal(calls.length, 2)
})

test('a fresh human prompt resets the continuation budget', async () => {
  const { agent } = makeAgent()
  const harness = makeObserver({ agent, config: makeConfig({ autoContinue: { cooldownMs: 0, maxAttempts: 2 } }) })
  harness.session = makeSession()

  await driveFailure(harness, { turn: 1, retries: [5] })
  await goIdle(harness)
  await driveFailure(harness, { turn: 2, retries: [5] })
  await goIdle(harness)

  // The user starts a new task; its first failure may continue again from 1.
  harness.observer.onSessionEvent(harness.session, turnStart(3))
  harness.observer.onSessionEvent(harness.session, humanMessage('再试一次新任务'))
  harness.observer.onSessionEvent(harness.session, retryEvent(3, 5, 5))
  harness.observer.onSessionEvent(harness.session, turnEnd(3, { kind: 'error', error: { code: 'SERVER' } }))
  await flushMicrotasks()
  assert.match(harness.notifications.at(-1).body, /（1\/2）/)
})

test('pending user input suppresses the continuation prompt', async () => {
  const { agent } = makeAgent({ inboxPending: true })
  const harness = makeObserver({ agent })
  harness.session = makeSession()
  const { notifications } = await driveFailure(harness, { turn: 1, retries: [5] })
  assert.match(notifications[0].body, /会话已有待处理的用户输入/)
  await goIdle(harness)
})

test('background-job notices do not suppress the continuation prompt', async () => {
  const { agent, calls } = makeAgent({ inboxNotices: true })
  const harness = makeObserver({ agent })
  harness.session = makeSession()
  const { notifications } = await driveFailure(harness, { turn: 1, retries: [5] })
  assert.match(notifications[0].body, /（1\/3）/)
  await goIdle(harness)
  assert.equal(calls.length, 1, 'a queued tool-jobs notice must not block the retry-recovery prompt')
  assert.equal(calls[0].content[0].text, '继续')
})

test('cooldown defers the second continuation until the timer fires', async () => {
  const { agent, calls } = makeAgent()
  const harness = makeObserver({ agent, config: makeConfig({ autoContinue: { cooldownMs: 60_000, maxAttempts: 5 } }) })
  harness.session = makeSession()

  await driveFailure(harness, { turn: 1, retries: [5] })
  await goIdle(harness)
  assert.equal(calls.length, 1, 'first continuation is immediate')

  await driveFailure(harness, { turn: 2, retries: [5] })
  await goIdle(harness)
  assert.equal(calls.length, 1, 'second continuation waits for the cooldown')
  assert.equal(harness.timers.length, 1)

  harness.clock.now += 60_000
  harness.timers[0].fn()
  await flushMicrotasks()
  assert.equal(calls.length, 2)
})

test('sub-agent turns stay silent by default', async () => {
  const { agent, calls } = makeAgent({ id: 'child-1' })
  const harness = makeObserver({ agent })
  harness.session = makeSession('child-1', { origin: 'subagent', delegationDepth: 1, cwd: '/work' })
  const { notifications } = await driveFailure(harness, { turn: 1, retries: [5] })
  assert.equal(notifications.length, 0)
  await goIdle(harness)
  assert.equal(calls.length, 0)
})

test('notifySubagents=true reports sub-agent turns', async () => {
  const { agent } = makeAgent({ id: 'child-1' })
  const harness = makeObserver({
    agent,
    config: makeConfig({ notifySubagents: true, autoContinue: { maxAttempts: 0 } }),
  })
  harness.session = makeSession('child-1', { origin: 'subagent', delegationDepth: 1, cwd: '/work' })
  const { notifications } = await driveFailure(harness, { turn: 1, retries: [5] })
  assert.equal(notifications.length, 1)
})

test('aborted turns notify only when enabled and never continue', async () => {
  const { agent, calls } = makeAgent()
  const harness = makeObserver({ agent, config: makeConfig({ notifyOnAbort: true }) })
  harness.session = makeSession()
  harness.observer.onSessionEvent(harness.session, turnStart(1))
  harness.observer.onSessionEvent(harness.session, humanMessage('长任务'))
  harness.observer.onSessionEvent(harness.session, turnEnd(1, { kind: 'aborted', reason: { kind: 'user' } }))
  await flushMicrotasks()
  assert.equal(harness.notifications.length, 1)
  assert.match(harness.notifications[0].title, /任务已取消/)
  assert.match(harness.notifications[0].body, /用户取消/)
  await goIdle(harness)
  assert.equal(calls.length, 0)
})

test('start notifications are opt-in', async () => {
  const { agent } = makeAgent()
  const harness = makeObserver({ agent, config: makeConfig({ notifyOnStart: true }) })
  harness.session = makeSession()
  harness.observer.onSessionEvent(harness.session, turnStart(1))
  await flushMicrotasks()
  assert.equal(harness.notifications.length, 1)
  assert.match(harness.notifications[0].title, /任务开始/)
})

test('session disposal clears pending continuations', async () => {
  const { agent, calls } = makeAgent()
  const harness = makeObserver({ agent })
  harness.session = makeSession()
  await driveFailure(harness, { turn: 1, retries: [5] })
  harness.observer.onSessionDisposed(harness.session)
  assert.equal(harness.observer.states.size, 0)
  assert.equal(harness.agent.status, 'running')
  await goIdle(harness)
  assert.equal(calls.length, 0)
})

test('inboxBusy and createPluginMessage are defensive', () => {
  assert.equal(inboxBusy({ inbox: { nextTurn: [], nextStep: [] } }), false)
  // Unidentifiable entries stay conservative: they may be legacy human input.
  assert.equal(inboxBusy({ inbox: { nextTurn: [], nextStep: [{ id: 'x' }] } }), true)
  assert.equal(inboxBusy({ inbox: { nextTurn: [{ id: 'x', source: { kind: 'user' } }], nextStep: [] } }), true)
  assert.equal(
    inboxBusy({ inbox: { nextTurn: [{ id: 'x', source: { kind: 'user-question-reply' } }], nextStep: [] } }),
    true,
    'a late answer to a pending question is human input too',
  )
  // System-generated entries must not block continuation.
  assert.equal(inboxBusy({ inbox: { nextTurn: [], nextStep: [{ id: 'x', source: { kind: 'tool-jobs' } }] } }), false)
  assert.equal(inboxBusy({ inbox: { nextTurn: [{ id: 'x', source: { kind: 'time-context' } }], nextStep: [] } }), false)
  assert.equal(inboxBusy({ inbox: { nextTurn: [{ id: 'x', source: { kind: 'task-notifier' } }], nextStep: [] } }), false)
  assert.equal(inboxBusy(undefined), false)
  const first = createPluginMessage('继续')
  const second = createPluginMessage('继续')
  assert.notEqual(first.id, second.id)
  assert.deepEqual(first.content, [{ type: 'text', text: '继续' }])
})

test('a superseded pending continuation is dropped without consuming the budget', async () => {
  const { agent, calls } = makeAgent()
  const harness = makeObserver({ agent })
  harness.session = makeSession()
  await driveFailure(harness, { turn: 1, retries: [5] })

  harness.observer.onSessionEvent(harness.session, turnStart(2))
  const state = harness.observer.states.get(harness.session.id)
  assert.equal(state.autoContinueCount, 0)
  assert.ok(
    harness.fileLogs.some((entry) => entry.event === 'auto-continue.skipped' && entry.data.reason === 'superseded'),
  )

  const { notifications } = await driveFailure(harness, { turn: 2, retries: [5] })
  assert.match(notifications.at(-1).body, /（1\/3）/)
  await goIdle(harness)
  assert.equal(calls.length, 1)
})

test('a skipped flush does not consume the continuation budget', async () => {
  const { agent, calls } = makeAgent()
  const harness = makeObserver({ agent })
  harness.session = makeSession()
  await driveFailure(harness, { turn: 1, retries: [5] })

  const state = harness.observer.states.get(harness.session.id)
  const savedAgents = harness.observer.agents
  harness.observer.agents = { get: () => undefined }
  harness.observer.onAgentStatus({ agent, status: 'idle' })
  await flushMicrotasks()
  assert.equal(calls.length, 0)
  assert.equal(state.autoContinueCount, 0)
  assert.ok(harness.fileLogs.some((entry) => entry.event === 'auto-continue.skipped'))
  harness.observer.agents = savedAgents

  const { notifications } = await driveFailure(harness, { turn: 2, retries: [5] })
  assert.match(notifications.at(-1).body, /（1\/3）/)
  await goIdle(harness)
  assert.equal(calls.length, 1)
})

test('queued next-turn entries skip the continuation without trying', async () => {
  const { agent, calls } = makeAgent({ inboxNextTurnNotices: true })
  const harness = makeObserver({ agent })
  harness.session = makeSession()
  const { notifications } = await driveFailure(harness, { turn: 1, retries: [5] })
  assert.match(notifications[0].body, /未自动继续：会话已有下一轮待处理输入/)
  await goIdle(harness)
  assert.equal(calls.length, 0)
})

test('providerRetryAfterMs delays the continuation', async () => {
  const { agent, calls } = makeAgent()
  const harness = makeObserver({ agent, config: makeConfig({ autoContinue: { cooldownMs: 0 } }) })
  harness.session = makeSession()
  const { notifications } = await driveFailure(harness, {
    turn: 1,
    retries: [5],
    code: 'RATE_LIMIT',
    failure: { providerRetryAfterMs: 30_000 },
  })
  assert.match(notifications[0].body, /已排队「继续」（1\/3）/)
  await goIdle(harness)
  assert.equal(calls.length, 0)
  assert.equal(harness.timers.length, 1)
  harness.clock.now += 30_000
  harness.timers[0].fn()
  await flushMicrotasks()
  assert.equal(calls.length, 1)
})

test('a provider retry delay beyond the cap skips the continuation', async () => {
  const { agent, calls } = makeAgent()
  const harness = makeObserver({ agent })
  harness.session = makeSession()
  const { notifications } = await driveFailure(harness, {
    turn: 1,
    retries: [5],
    code: 'RATE_LIMIT',
    failure: { providerRetryAfterMs: 600_000 },
  })
  assert.match(notifications[0].body, /未自动继续：provider 要求等待较长时间后重试/)
  await goIdle(harness)
  assert.equal(calls.length, 0)
  assert.equal(harness.timers.length, 0)
})

test('subagent turns never auto-continue even when notifications are enabled', async () => {
  const { agent, calls } = makeAgent()
  const harness = makeObserver({ agent, config: makeConfig({ notifySubagents: true }) })
  harness.session = makeSession('session-1', { cwd: '/work/project', origin: 'subagent' })
  const { notifications } = await driveFailure(harness, { turn: 1, retries: [5] })
  assert.equal(notifications.length, 1)
  await goIdle(harness)
  assert.equal(calls.length, 0)
})

test('retries from another turn do not influence the decision', async () => {
  const { agent, calls } = makeAgent()
  const harness = makeObserver({
    agent,
    config: makeConfig({ autoContinue: { requireRetryExhausted: true } }),
  })
  harness.session = makeSession()
  harness.observer.onSessionEvent(harness.session, turnStart(1))
  harness.observer.onSessionEvent(harness.session, retryEvent(1, 5, 5))
  harness.observer.onSessionEvent(harness.session, turnEnd(1, { kind: 'completed' }))

  harness.observer.onSessionEvent(harness.session, turnStart(2))
  harness.observer.onSessionEvent(harness.session, humanMessage('继续修'))
  harness.observer.onSessionEvent(harness.session, retryEvent(2, 1, 5))
  harness.observer.onSessionEvent(harness.session, turnEnd(2, { kind: 'error', error: { code: 'SERVER', message: 'x' } }))
  await flushMicrotasks()

  assert.match(harness.notifications.at(-1).body, /未自动继续：非模型请求重试耗尽/)
  await goIdle(harness)
  assert.equal(calls.length, 0)
})

test('unknown turn/end kinds are silent', async () => {
  const { agent, calls } = makeAgent()
  const harness = makeObserver({ agent })
  harness.session = makeSession()
  harness.observer.onSessionEvent(harness.session, turnStart(1))
  harness.observer.onSessionEvent(harness.session, humanMessage('fork'))
  harness.observer.onSessionEvent(harness.session, turnEnd(1, { kind: 'forked' }))
  await flushMicrotasks()
  assert.equal(harness.notifications.length, 0)
  assert.equal(calls.length, 0)
})

test('the continuation is admitted after the idle dispatch returns', async () => {
  const { agent, calls } = makeAgent()
  const harness = makeObserver({ agent })
  harness.session = makeSession()
  await driveFailure(harness, { turn: 1, retries: [5] })

  harness.observer.onAgentStatus({ agent, status: 'idle' })
  assert.equal(calls.length, 0, 'still inside the idle dispatch')
  await flushMicrotasks()
  assert.equal(calls.length, 1)
})

test('durable session titles label notifications', async () => {
  const { agent } = makeAgent()
  const harness = makeObserver({ agent })
  harness.session = makeSession()
  harness.observer.onSessionEvent(harness.session, {
    type: 'session/title',
    data: { title: 'Git push privacy audit' },
  })
  harness.observer.onSessionEvent(harness.session, turnStart(1))
  harness.observer.onSessionEvent(harness.session, humanMessage('修复登录接口'))
  harness.observer.onSessionEvent(harness.session, turnEnd(1, { kind: 'completed' }))
  await flushMicrotasks()
  assert.match(harness.notifications[0].body, /Git push privacy audit/)
})

test('a plugin mounted mid-turn still continues a network failure', async () => {
  const { agent, calls } = makeAgent()
  const harness = makeObserver({ agent })
  harness.session = makeSession()
  // The plugin mounted after turn/start: only the terminal event is observed.
  harness.observer.onSessionEvent(
    harness.session,
    turnEnd(3, { kind: 'error', error: { code: 'TRANSPORT', message: 'Connection error.' } }),
  )
  await flushMicrotasks()
  assert.match(harness.notifications[0].body, /已排队「继续」（1\/3）/)
  await goIdle(harness)
  assert.equal(calls.length, 1)
})

test('strict retry-exhaustion mode requires the turn context it never saw', async () => {
  const { agent, calls } = makeAgent()
  const harness = makeObserver({ agent, config: makeConfig({ autoContinue: { requireRetryExhausted: true } }) })
  harness.session = makeSession()
  harness.observer.onSessionEvent(
    harness.session,
    turnEnd(3, { kind: 'error', error: { code: 'TRANSPORT', message: 'Connection error.' } }),
  )
  await flushMicrotasks()
  assert.match(harness.notifications[0].body, /未自动继续：缺少轮次上下文/)
  await goIdle(harness)
  assert.equal(calls.length, 0)
})

test('an UNKNOWN failure with a network-shaped message still continues', async () => {
  const { agent, calls } = makeAgent()
  const harness = makeObserver({ agent })
  harness.session = makeSession()
  const { notifications } = await driveFailure(harness, {
    turn: 1,
    retries: [],
    code: 'UNKNOWN',
    message: 'TypeError: fetch failed',
  })
  assert.match(notifications[0].body, /已排队「继续」（1\/3）/)
  await goIdle(harness)
  assert.equal(calls.length, 1)
})

test('an UNKNOWN failure with a non-network message does not continue', async () => {
  const { agent, calls } = makeAgent()
  const harness = makeObserver({ agent })
  harness.session = makeSession()
  const { notifications } = await driveFailure(harness, {
    turn: 1,
    retries: [],
    code: 'UNKNOWN',
    message: 'invalid argument',
  })
  assert.match(notifications[0].body, /未自动继续：失败不属于可继续的类型/)
  await goIdle(harness)
  assert.equal(calls.length, 0)
})

test('sub-agent start and step notifications stay silent until notifySubagents', async () => {
  const childHeader = {
    origin: 'subagent',
    delegationDepth: 1,
    cwd: '/work/project',
    parentSession: 'session-parent-123456',
  }
  const { agent } = makeAgent()
  const hidden = makeObserver({ agent, config: makeConfig({ notifyOnStart: true, notifyOnStep: true }) })
  hidden.session = makeSession('child-1', childHeader)
  hidden.observer.onSessionEvent(hidden.session, turnStart(1))
  hidden.observer.onSessionEvent(hidden.session, { type: 'step/start', data: { turn: 1, step: 1 } })
  await flushMicrotasks()
  assert.equal(hidden.notifications.length, 0)

  const visible = makeObserver({
    agent,
    config: makeConfig({ notifyOnStart: true, notifyOnStep: true, notifySubagents: true }),
  })
  visible.session = makeSession('child-1', childHeader)
  visible.observer.onSessionEvent(visible.session, turnStart(1))
  visible.observer.onSessionEvent(visible.session, { type: 'step/start', data: { turn: 1, step: 1 } })
  await flushMicrotasks()
  assert.equal(visible.notifications.length, 2)
  assert.match(visible.notifications[0].body, /子代理 child-1/)
  assert.match(visible.notifications[0].body, /父 /)
})

test('a continuation turn keeps the last human label', async () => {
  const { agent } = makeAgent()
  const harness = makeObserver({ agent })
  harness.session = makeSession()
  await driveFailure(harness, { turn: 1, retries: [5] })
  assert.match(harness.notifications[0].body, /帮我修一下登录接口/)
  await goIdle(harness)

  // The continuation turn is driven by a producer message, not a human one.
  harness.observer.onSessionEvent(harness.session, turnStart(2))
  harness.observer.onSessionEvent(harness.session, {
    type: 'user/message',
    data: {
      content: [{ type: 'text', text: '继续完成未完成的任务' }],
      source: { kind: 'task-notifier', plugin: 'task-notifier' },
    },
  })
  harness.observer.onSessionEvent(
    harness.session,
    turnEnd(2, { kind: 'error', error: { code: 'SERVER', message: 'upstream 502' } }),
  )
  await flushMicrotasks()
  assert.match(harness.notifications.at(-1).body, /帮我修一下登录接口/)
})

function approvalAsked(id = 'approval-1') {
  return {
    type: 'approval/asked',
    data: {
      id,
      toolName: 'pwsh',
      callId: 'call-1',
      reason: 'escalate sandbox to danger-full-access: 需要写入工作区外目录',
    },
  }
}

function approvalDecided(id = 'approval-1', outcome = 'allowed-once') {
  return { type: 'approval/decided', data: { id, outcome } }
}

test('a pending approval notifies after the grace window', async () => {
  const { agent } = makeAgent()
  const harness = makeObserver({ agent })
  harness.session = makeSession()
  harness.observer.onSessionEvent(harness.session, approvalAsked())
  await flushMicrotasks()
  assert.equal(harness.notifications.length, 0, 'no notification inside the grace window')
  assert.equal(harness.timers.length, 1)
  harness.timers[0].fn()
  await flushMicrotasks()
  assert.equal(harness.notifications.length, 1)
  assert.match(harness.notifications[0].title, /需要授权/)
  assert.match(harness.notifications[0].body, /工具：pwsh/)
  assert.match(harness.notifications[0].body, /原因：escalate sandbox/)
})

test('an approval answered inside the grace window stays silent', async () => {
  const { agent } = makeAgent()
  const harness = makeObserver({ agent })
  harness.session = makeSession()
  harness.observer.onSessionEvent(harness.session, approvalAsked())
  harness.observer.onSessionEvent(harness.session, approvalDecided())
  await flushMicrotasks()
  assert.equal(harness.timers.length, 0, 'the timer is cleared by the decision')
  assert.equal(harness.notifications.length, 0)
})

test('an approval decided after the notification clears quietly', async () => {
  const { agent } = makeAgent()
  const harness = makeObserver({ agent })
  harness.session = makeSession()
  harness.observer.onSessionEvent(harness.session, approvalAsked())
  harness.timers[0].fn()
  await flushMicrotasks()
  assert.equal(harness.notifications.length, 1)
  assert.doesNotThrow(() => harness.observer.onSessionEvent(harness.session, approvalDecided()))
  await flushMicrotasks()
  assert.equal(harness.notifications.length, 1)
})

test('approval notifications honour the switch and sub-agent visibility', async () => {
  const { agent } = makeAgent()
  const disabled = makeObserver({ agent, config: makeConfig({ notifyOnApproval: false }) })
  disabled.session = makeSession()
  disabled.observer.onSessionEvent(disabled.session, approvalAsked())
  assert.equal(disabled.timers.length, 0)

  const subagent = makeObserver({ agent })
  subagent.session = makeSession('child-1', {
    origin: 'subagent',
    delegationDepth: 1,
    parentSession: 'session-parent-123456',
  })
  subagent.observer.onSessionEvent(subagent.session, approvalAsked())
  assert.equal(subagent.timers.length, 0, 'sub-agents stay silent unless notifySubagents is on')

  const visible = makeObserver({ agent, config: makeConfig({ notifySubagents: true }) })
  visible.session = makeSession('child-1', {
    origin: 'subagent',
    delegationDepth: 1,
    parentSession: 'session-parent-123456',
  })
  visible.observer.onSessionEvent(visible.session, approvalAsked())
  assert.equal(visible.timers.length, 1)
})

test('session disposal clears a pending approval timer', async () => {
  const { agent } = makeAgent()
  const harness = makeObserver({ agent })
  harness.session = makeSession()
  harness.observer.onSessionEvent(harness.session, approvalAsked())
  assert.equal(harness.timers.length, 1)
  harness.observer.onSessionDisposed(harness.session)
  assert.equal(harness.timers.length, 0)
  await flushMicrotasks()
  assert.equal(harness.notifications.length, 0)
})

test('an approval request is reported even without a captured turn', async () => {
  const { agent } = makeAgent()
  const harness = makeObserver({ agent })
  harness.session = makeSession()
  // Plugin mounted after this turn started: no turn/start was observed.
  harness.observer.onSessionEvent(harness.session, approvalAsked())
  harness.timers[0].fn()
  await flushMicrotasks()
  assert.equal(harness.notifications.length, 1)
  assert.match(harness.notifications[0].title, /需要授权/)
})

test('a sub-agent completion is reported with its parent label when enabled', async () => {
  const { agent } = makeAgent()
  const harness = makeObserver({ agent, config: makeConfig({ notifySubagents: true }) })
  harness.session = makeSession('child-1', {
    origin: 'subagent',
    delegationDepth: 1,
    cwd: '/work/project',
    parentSession: 'session-parent-123456',
  })
  harness.observer.onSessionEvent(harness.session, turnStart(1))
  harness.observer.onSessionEvent(harness.session, { type: 'step/start', data: { turn: 1, step: 1 } })
  harness.observer.onSessionEvent(harness.session, {
    type: 'assistant/message',
    data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'done' }] } },
  })
  harness.observer.onSessionEvent(harness.session, turnEnd(1, { kind: 'completed' }))
  await flushMicrotasks()
  const notification = harness.notifications.at(-1)
  assert.match(notification.title, /任务完成/)
  assert.match(notification.body, /子代理 child-1/)
  assert.match(notification.body, /父 /)
  assert.match(notification.body, /1 步/)
})

function questionCall(callId = 'call-q1', questions = [{ id: 'q', header: '确认', question: '临时目录放在哪里？' }]) {
  return {
    type: 'tool/call',
    data: { callId, name: 'ask_user_question', arguments: JSON.stringify({ questions }) },
  }
}

function planCall(callId = 'call-p1', plan = '# 重构通知模块\n\n步骤……') {
  return {
    type: 'tool/call',
    data: { callId, name: 'exit_plan_mode', arguments: JSON.stringify({ plan }) },
  }
}

function toolResultOf(callId, text = '{"answers":[]}', isError = false) {
  return {
    type: 'tool/result',
    data: {
      turn: 1,
      step: 1,
      message: {
        toolCallId: callId,
        isError,
        source: { kind: 'tool', callId },
        content: [{ type: 'text', text }],
      },
    },
  }
}

test('a pending user question notifies after the grace window', async () => {
  const { agent } = makeAgent()
  const harness = makeObserver({ agent })
  harness.session = makeSession()
  harness.observer.onSessionEvent(harness.session, questionCall())
  await flushMicrotasks()
  assert.equal(harness.notifications.length, 0, 'no notification inside the grace window')
  assert.equal(harness.timers.length, 1)
  harness.timers[0].fn()
  await flushMicrotasks()
  assert.equal(harness.notifications.length, 1)
  assert.match(harness.notifications[0].title, /需要你操作/)
  assert.match(harness.notifications[0].body, /类型：问题/)
  assert.match(harness.notifications[0].body, /内容：临时目录放在哪里？/)
})

test('a plan review notifies with its plan heading', async () => {
  const { agent } = makeAgent()
  const harness = makeObserver({ agent })
  harness.session = makeSession()
  harness.observer.onSessionEvent(harness.session, planCall())
  harness.timers[0].fn()
  await flushMicrotasks()
  assert.equal(harness.notifications.length, 1)
  assert.match(harness.notifications[0].body, /类型：计划审批/)
  assert.match(harness.notifications[0].body, /内容：重构通知模块/)
})

test('a question answered inside the grace window stays silent', async () => {
  const { agent } = makeAgent()
  const harness = makeObserver({ agent })
  harness.session = makeSession()
  harness.observer.onSessionEvent(harness.session, questionCall())
  harness.observer.onSessionEvent(harness.session, toolResultOf('call-q1'))
  await flushMicrotasks()
  assert.equal(harness.timers.length, 0, 'the timer is cleared by the tool result')
  assert.equal(harness.notifications.length, 0)
})

test('a question result after the notification closes quietly', async () => {
  const { agent } = makeAgent()
  const harness = makeObserver({ agent })
  harness.session = makeSession()
  harness.observer.onSessionEvent(harness.session, questionCall())
  harness.timers[0].fn()
  await flushMicrotasks()
  assert.equal(harness.notifications.length, 1)
  assert.doesNotThrow(() => harness.observer.onSessionEvent(harness.session, toolResultOf('call-q1')))
  await flushMicrotasks()
  assert.equal(harness.notifications.length, 1)
})

test('question notifications honour the switch and sub-agent visibility', async () => {
  const { agent } = makeAgent()
  const disabled = makeObserver({ agent, config: makeConfig({ notifyOnQuestion: false }) })
  disabled.session = makeSession()
  disabled.observer.onSessionEvent(disabled.session, questionCall())
  assert.equal(disabled.timers.length, 0)

  const subagent = makeObserver({ agent })
  subagent.session = makeSession('child-1', {
    origin: 'subagent',
    delegationDepth: 1,
    parentSession: 'session-parent-123456',
  })
  subagent.observer.onSessionEvent(subagent.session, questionCall())
  assert.equal(subagent.timers.length, 0)

  const visible = makeObserver({ agent, config: makeConfig({ notifySubagents: true }) })
  visible.session = makeSession('child-1', {
    origin: 'subagent',
    delegationDepth: 1,
    parentSession: 'session-parent-123456',
  })
  visible.observer.onSessionEvent(visible.session, questionCall())
  assert.equal(visible.timers.length, 1)
})

test('session disposal clears a pending question timer', async () => {
  const { agent } = makeAgent()
  const harness = makeObserver({ agent })
  harness.session = makeSession()
  harness.observer.onSessionEvent(harness.session, questionCall())
  assert.equal(harness.timers.length, 1)
  harness.observer.onSessionDisposed(harness.session)
  assert.equal(harness.timers.length, 0)
  await flushMicrotasks()
  assert.equal(harness.notifications.length, 0)
})

function ptcQuestionStart(subCallId = 'sub-q1', questions = [{ id: 'q', question: '计划内的依赖可以升级吗？' }]) {
  return {
    type: 'tool/ptc-dispatch-start',
    data: {
      rootCallId: 'call-run',
      parentCallId: 'call-run',
      subCallId,
      name: 'ask_user_question',
      arguments: { questions },
    },
  }
}

function ptcQuestionResult(subCallId = 'sub-q1', text = '{"answers":[]}', isError = false) {
  return {
    type: 'tool/ptc-dispatch',
    data: {
      rootCallId: 'call-run',
      parentCallId: 'call-run',
      subCallId,
      name: 'ask_user_question',
      isError,
      content: [{ type: 'text', text }],
    },
  }
}

test('a PTC-generated user question notifies after the grace window', async () => {
  const { agent } = makeAgent()
  const harness = makeObserver({ agent })
  harness.session = makeSession()
  harness.observer.onSessionEvent(harness.session, ptcQuestionStart())
  assert.equal(harness.notifications.length, 0)
  assert.equal(harness.timers.length, 1)
  harness.timers[0].fn()
  await flushMicrotasks()
  assert.equal(harness.notifications.length, 1)
  assert.match(harness.notifications[0].body, /内容：计划内的依赖可以升级吗？/)
})

test('a PTC question answered inside the grace window stays silent', async () => {
  const { agent } = makeAgent()
  const harness = makeObserver({ agent })
  harness.session = makeSession()
  harness.observer.onSessionEvent(harness.session, ptcQuestionStart())
  harness.observer.onSessionEvent(harness.session, ptcQuestionResult())
  await flushMicrotasks()
  assert.equal(harness.timers.length, 0)
  assert.equal(harness.notifications.length, 0)
})

test('a timed question that returns pending before the grace window still notifies once', async () => {
  const { agent } = makeAgent()
  const harness = makeObserver({ agent })
  harness.session = makeSession()
  harness.observer.onSessionEvent(harness.session, questionCall())
  harness.observer.onSessionEvent(harness.session, toolResultOf('call-q1', '{"pending":true,"callId":"call-q1"}'))
  await flushMicrotasks()
  assert.equal(harness.timers.length, 0)
  assert.equal(harness.notifications.length, 1)
  assert.match(harness.notifications[0].body, /状态：超时后仍可回答/)
})

test('a PTC timed question that returns pending sends one pending alert', async () => {
  const { agent } = makeAgent()
  const harness = makeObserver({ agent })
  harness.session = makeSession()
  harness.observer.onSessionEvent(harness.session, ptcQuestionStart())
  harness.observer.onSessionEvent(harness.session, ptcQuestionResult('sub-q1', '{"pending":true,"callId":"sub-q1"}'))
  await flushMicrotasks()
  assert.equal(harness.notifications.length, 1)
  assert.match(harness.notifications[0].body, /状态：超时后仍可回答/)
})

test('a pending approval repeats a reminder until it is decided', async () => {
  const { agent } = makeAgent()
  const harness = makeObserver({ agent })
  harness.session = makeSession()
  harness.observer.onSessionEvent(harness.session, approvalAsked())
  harness.timers[0].fn()
  await flushMicrotasks()
  assert.equal(harness.notifications.length, 1)
  assert.doesNotMatch(harness.notifications[0].body, /仍未处理/)

  const reminderTimer = harness.timers.at(-1)
  assert.equal(reminderTimer.delay, 300_000)
  reminderTimer.fn()
  await flushMicrotasks()
  assert.equal(harness.notifications.length, 2)
  assert.match(harness.notifications[1].body, /仍未处理/)
  assert.ok(harness.fileLogs.some((entry) => entry.event === 'approval.reminder'))

  const nextTimer = harness.timers.at(-1)
  harness.observer.onSessionEvent(harness.session, approvalDecided())
  assert.ok(!harness.timers.includes(nextTimer), 'the decision clears the next reminder')
})

test('a pending question repeats a reminder until it is answered', async () => {
  const { agent } = makeAgent()
  const harness = makeObserver({ agent })
  harness.session = makeSession()
  harness.observer.onSessionEvent(harness.session, questionCall())
  harness.timers[0].fn()
  await flushMicrotasks()
  assert.equal(harness.notifications.length, 1)

  const reminderTimer = harness.timers.at(-1)
  assert.equal(reminderTimer.delay, 300_000)
  reminderTimer.fn()
  await flushMicrotasks()
  assert.equal(harness.notifications.length, 2)
  assert.match(harness.notifications[1].body, /类型：问题/)
  assert.match(harness.notifications[1].body, /仍未处理/)
  assert.ok(harness.fileLogs.some((entry) => entry.event === 'question.reminder'))

  const nextTimer = harness.timers.at(-1)
  harness.observer.onSessionEvent(harness.session, toolResultOf('call-q1'))
  assert.ok(!harness.timers.includes(nextTimer), 'the answer clears the next reminder')
})

test('reminders can be disabled with reminderMs: 0', async () => {
  const { agent } = makeAgent()
  const harness = makeObserver({ agent, config: makeConfig({ reminderMs: 0 }) })
  harness.session = makeSession()
  harness.observer.onSessionEvent(harness.session, approvalAsked())
  harness.timers[0].fn()
  await flushMicrotasks()
  assert.equal(harness.notifications.length, 1)
  assert.equal(harness.timers.length, 1, 'only the fired timer object remains; none is rescheduled')
})

test('privacyMode redacts the OS notification but logs the full copy', async () => {
  const { agent } = makeAgent()
  const harness = makeObserver({ agent, config: makeConfig({ privacyMode: true }) })
  harness.session = makeSession()
  harness.observer.onSessionEvent(harness.session, approvalAsked())
  harness.timers[0].fn()
  await flushMicrotasks()
  assert.equal(harness.notifications.length, 1)
  assert.doesNotMatch(harness.notifications[0].body, /escalate sandbox/)
  assert.match(harness.notifications[0].body, /详情请在 DSH 中查看/)

  const dispatchLog = harness.fileLogs.find((entry) => entry.event === 'notification.dispatch')
  assert.match(dispatchLog.data.body, /escalate sandbox/, 'the debug log keeps the full copy')
  assert.equal(dispatchLog.data.privacyMode, true)
  assert.equal(dispatchLog.data.redacted, true)
  assert.match(harness.notificationMetas[0].logNotification.body, /escalate sandbox/)
})
