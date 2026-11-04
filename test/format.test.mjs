import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildNotification,
  clip,
  failureCode,
  formatDuration,
  isNetworkFailureMessage,
  isRetryExhaustedFailure,
  messageText,
  phaseForReason,
  reasonKind,
} from '../lib/format.mjs'

const RETRYABLE = ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT']

test('reasonKind and phaseForReason cover durable turn end reasons', () => {
  assert.equal(reasonKind({ kind: 'completed' }), 'completed')
  assert.equal(reasonKind('error'), 'error')
  assert.equal(reasonKind(undefined), 'completed')
  assert.equal(phaseForReason('completed'), 'complete')
  assert.equal(phaseForReason('error'), 'error')
  assert.equal(phaseForReason('aborted'), 'aborted')
  assert.equal(phaseForReason('max-tokens'), 'max-tokens')
})

test('isRetryExhaustedFailure detects a normal-mode budget that reached maxRetries', () => {
  const failure = { code: 'SERVER', message: 'upstream 502' }
  assert.equal(
    isRetryExhaustedFailure({
      turnEvents: [
        { type: 'llm/retry', data: { mode: 'normal', retry: 1, maxRetries: 3 } },
        { type: 'llm/retry', data: { mode: 'normal', retry: 3, maxRetries: 3 } },
      ],
      failure,
      retryableCodes: RETRYABLE,
    }),
    true,
  )
})

test('isRetryExhaustedFailure rejects an unfinished retry budget', () => {
  assert.equal(
    isRetryExhaustedFailure({
      turnEvents: [{ type: 'llm/retry', data: { mode: 'normal', retry: 2, maxRetries: 5 } }],
      failure: { code: 'RATE_LIMIT' },
      retryableCodes: RETRYABLE,
    }),
    false,
  )
})

test('isRetryExhaustedFailure treats a first-attempt transient failure as exhausted', () => {
  assert.equal(
    isRetryExhaustedFailure({
      turnEvents: [],
      failure: { code: 'TIMEOUT' },
      retryableCodes: RETRYABLE,
    }),
    true,
  )
})

test('isRetryExhaustedFailure ignores non-retryable codes and always mode', () => {
  assert.equal(
    isRetryExhaustedFailure({
      turnEvents: [{ type: 'llm/retry', data: { mode: 'normal', retry: 5, maxRetries: 5 } }],
      failure: { code: 'AUTH' },
      retryableCodes: RETRYABLE,
    }),
    false,
  )
  assert.equal(
    isRetryExhaustedFailure({
      turnEvents: [{ type: 'llm/retry', data: { mode: 'always', retry: 9 } }],
      failure: { code: 'SERVER' },
      retryableCodes: RETRYABLE,
    }),
    false,
  )
})

test('buildNotification renders completion with duration, steps and preview', () => {
  const { title, body } = buildNotification({
    phase: 'complete',
    label: '修复登录接口',
    durationMs: 63_000,
    steps: 5,
    preview: '已修复并补充回归测试。',
    includePreview: true,
    titlePrefix: 'DSH',
    maxBodyChars: 240,
  })
  assert.match(title, /任务完成/)
  assert.match(body, /修复登录接口/)
  assert.match(body, /1m3s/)
  assert.match(body, /5 步/)
  assert.match(body, /已修复并补充回归测试/)
})

test('buildNotification hides the model preview unless includePreview is on', () => {
  const { body } = buildNotification({
    phase: 'complete',
    label: '修复登录接口',
    preview: 'SECRET model output',
  })
  assert.match(body, /修复登录接口/)
  assert.doesNotMatch(body, /SECRET/)
})

test('buildNotification explains the continuation attempt on failure', () => {
  const { title, body } = buildNotification({
    phase: 'error',
    label: '构建项目',
    failure: { code: 'SERVER', message: 'upstream 502' },
    autoContinue: { attempt: 2, max: 3 },
  })
  assert.match(title, /任务失败/)
  assert.match(body, /SERVER: upstream 502/)
  assert.match(body, /已排队「继续」（2\/3）/)
})

test('buildNotification explains new skip reasons', () => {
  for (const [reason, text] of [
    ['next-turn-pending', '会话已有下一轮待处理输入'],
    ['provider-retry-after', 'provider 要求等待较长时间后重试'],
    ['no-turn-context', '缺少轮次上下文'],
  ]) {
    const { body } = buildNotification({
      phase: 'error',
      label: '构建项目',
      failure: { code: 'RATE_LIMIT' },
      autoContinue: { skipped: reason },
    })
    assert.match(body, new RegExp(`未自动继续：${text}`))
  }
})

test('buildNotification explains why a continuation was skipped', () => {
  const { body } = buildNotification({
    phase: 'error',
    label: '构建项目',
    failure: { code: 'AUTH' },
    autoContinue: { skipped: 'not-retry-exhausted' },
  })
  assert.match(body, /未自动继续：非模型请求重试耗尽/)
})

test('buildNotification clips the body to maxBodyChars', () => {
  const { body } = buildNotification({
    phase: 'complete',
    label: 'x'.repeat(100),
    preview: 'y'.repeat(500),
    includePreview: true,
    maxBodyChars: 60,
  })
  assert.ok(body.length <= 60, `body length ${body.length}`)
  assert.ok(body.endsWith('…'))
})

test('messageText joins only text blocks', () => {
  assert.equal(
    messageText({
      content: [
        { type: 'text', text: 'hello' },
        { type: 'image', data: 'ignored' },
        { type: 'text', text: 'world' },
      ],
    }),
    'hello\nworld',
  )
  assert.equal(messageText(undefined), '')
})

test('clip and formatDuration are defensive', () => {
  assert.equal(clip('  a \n b  ', 10), 'a b')
  assert.equal(clip('abcdef', 4), 'abc…')
  assert.equal(formatDuration(1_500), '1.5s')
  assert.equal(formatDuration(12_000), '12s')
  assert.equal(formatDuration(3_723_000), '1h2m')
  assert.equal(formatDuration(Number.NaN), '0s')
})

test('failureCode ignores blank codes', () => {
  assert.equal(failureCode({ code: ' SERVER ' }), 'SERVER')
  assert.equal(failureCode({ code: '   ' }), undefined)
  assert.equal(failureCode(undefined), undefined)
})

test('isNetworkFailureMessage recognizes transport wording only', () => {
  assert.equal(isNetworkFailureMessage({ message: 'fetch failed' }), true)
  assert.equal(isNetworkFailureMessage({ message: 'read ECONNRESET by peer' }), true)
  assert.equal(isNetworkFailureMessage({ message: 'request timed out' }), true)
  assert.equal(isNetworkFailureMessage({ message: 'invalid argument' }), false)
  assert.equal(isNetworkFailureMessage({ message: '' }), false)
  assert.equal(isNetworkFailureMessage(undefined), false)
})

test('a verbose failure reason keeps the continuation outcome visible', () => {
  const { body } = buildNotification({
    phase: 'error',
    label: '设计器应该是先设计布局，然后再布局容器中填充内容，类如我先画出三行（第一行：欢迎语，第二行：两列，第三行两列）每一行的…',
    durationMs: 876_000,
    steps: 20,
    failure: {
      code: 'PI_AI_ERROR',
      message: 'rpc error: code = Unknown desc = Unexpected NameError: name quoted_for_log is not defined, request_id=3b5d8f58-0211-44c1-af07-12b386bc66a2',
    },
    autoContinue: { attempt: 1, max: 3 },
    maxBodyChars: 240,
  })
  assert.ok(body.length <= 240, `body length ${body.length}`)
  assert.match(body, /已排队「继续」（1\/3）/)
  assert.match(body, /原因：/)
})

test('buildNotification renders a pending approval prompt', () => {
  const { title, body } = buildNotification({
    phase: 'approval',
    label: '设计器任务',
    approval: {
      toolName: 'pwsh',
      reason: 'escalate sandbox to danger-full-access: 需要写入工作区外目录',
    },
    titlePrefix: 'DSH',
    maxBodyChars: 240,
  })
  assert.match(title, /需要授权/)
  assert.match(body, /会话：设计器任务/)
  assert.match(body, /工具：pwsh/)
  assert.match(body, /原因：escalate sandbox/)
})
