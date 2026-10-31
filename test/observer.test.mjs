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
      nextTurn: options.inboxPending ? [{ id: 'pending' }] : [],
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
  const fileLogs = []
  const timers = []
  const clock = { now: 1_000_000 }
  const config = observerOptions.config ?? makeConfig()
  const notifier = {
    async dispatch(notification) {
      notifications.push(notification)
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
  return { observer, notifications, fileLogs, timers, clock, agent }
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
  { turn, retries = [5], maxRetries = retries.at(-1), code = 'SERVER', message = 'upstream 502', human = turn === 1 } = {},
) {
  const { observer, notifications, timers } = harness
  const session = harness.session
  observer.onSessionEvent(session, turnStart(turn))
  if (human) observer.onSessionEvent(session, humanMessage('帮我修一下登录接口'))
  for (const retry of retries) observer.onSessionEvent(session, retryEvent(turn, retry, maxRetries))
  if (turn === 1) observer.onSessionEvent(session, assistantMessage('正在检查代码…'))
  observer.onSessionEvent(session, turnEnd(turn, { kind: 'error', error: { code, message } }))
  await flushMicrotasks()
  return { notifications, timers }
}

test('completed turn sends a success notification with preview', async () => {
  const { agent } = makeAgent()
  const harness = makeObserver({ agent })
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

test('retry-exhausted failure admits the continuation prompt on the idle edge', async () => {
  const { agent, calls } = makeAgent()
  const harness = makeObserver({ agent })
  harness.session = makeSession()
  const { notifications } = await driveFailure(harness, { turn: 1, retries: [1, 2, 3] })

  assert.equal(notifications.length, 1)
  assert.match(notifications[0].title, /任务失败/)
  assert.match(notifications[0].body, /SERVER: upstream 502/)
  assert.match(notifications[0].body, /已自动发送「继续」（1\/3）/)
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
  assert.match(notifications[0].body, /未自动继续：非模型请求重试耗尽/)
  await goIdle(harness)
  assert.equal(calls.length, 0)
})

test('an unfinished retry budget is not treated as exhausted', async () => {
  const { agent, calls } = makeAgent()
  const harness = makeObserver({ agent })
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
