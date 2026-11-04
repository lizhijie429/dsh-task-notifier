import assert from 'node:assert/strict'
import { test } from 'node:test'
import { normalizeConfig, defaultConfig } from '../lib/config.mjs'

test('defaults are enabled and use the documented continuation prompt', () => {
  const { config, warnings } = normalizeConfig(undefined, 'C:\\plugins\\dsh-task-notifier')
  assert.deepEqual(warnings, [])
  assert.equal(config.notifyOnComplete, true)
  assert.equal(config.notifyOnError, true)
  assert.equal(config.notifyOnAbort, false)
  assert.equal(config.channel, 'auto')
  assert.equal(config.windowsAppId, 'DSH.TaskNotifier')
  assert.equal(config.windowsAppName, 'DSH')
  assert.equal(config.autoContinue.enabled, true)
  assert.equal(config.autoContinue.message, '继续')
  assert.equal(config.autoContinue.maxAttempts, 3)
  assert.ok(config.logFile.endsWith('task-notifier.log'))
})

test('patch config overrides defaults without losing sibling fields', () => {
  const { config, warnings } = normalizeConfig(
    {
      channel: 'windows',
      notifyOnAbort: true,
      autoContinue: { message: '请继续完成未完成的任务', maxAttempts: 1 },
    },
    '/plugins/dsh-task-notifier',
  )
  assert.deepEqual(warnings, [])
  assert.equal(config.channel, 'windows')
  assert.equal(config.notifyOnAbort, true)
  assert.equal(config.autoContinue.message, '请继续完成未完成的任务')
  assert.equal(config.autoContinue.maxAttempts, 1)
  // Unspecified nested fields keep their defaults.
  assert.equal(config.autoContinue.cooldownMs, 5000)
  assert.equal(config.autoContinue.requireRetryExhausted, false, 'network/model failures continue by default')
  assert.equal(config.notifyOnApproval, true, 'pending approvals are notified by default')
  assert.equal(config.approvalGraceMs, 1000)
})

test('approval notification settings normalize and fall back', () => {
  const custom = normalizeConfig({ notifyOnApproval: false, approvalGraceMs: 5000 }, '/p')
  assert.equal(custom.config.notifyOnApproval, false)
  assert.equal(custom.config.approvalGraceMs, 5000)

  const invalid = normalizeConfig({ notifyOnApproval: 'yes', approvalGraceMs: -1 }, '/p')
  assert.equal(invalid.config.notifyOnApproval, true)
  assert.equal(invalid.config.approvalGraceMs, 1000)
  assert.ok(invalid.warnings.some((warning) => warning.includes('notifyOnApproval')))
  assert.ok(invalid.warnings.some((warning) => warning.includes('approvalGraceMs')))
})

test('invalid values fall back to defaults and report warnings', () => {
  const { config, warnings } = normalizeConfig(
    {
      channel: 'carrier-pigeon',
      notifyOnComplete: 'yes',
      maxBodyChars: 10,
      autoContinue: { maxAttempts: -1, retryableCodes: [] },
      logFile: false,
    },
    '/plugins/dsh-task-notifier',
  )
  assert.equal(config.channel, 'auto')
  assert.equal(config.notifyOnComplete, true)
  assert.equal(config.maxBodyChars, 240, 'below-minimum value is clamped back to the default')
  assert.equal(config.autoContinue.maxAttempts, 3)
  assert.deepEqual(config.autoContinue.retryableCodes, [
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
  ])
  assert.equal(config.logFile, false)
  assert.ok(warnings.length >= 4)
})

test('retryable code lists accept comma-separated strings and normalize case', () => {
  const { config } = normalizeConfig({ autoContinue: { retryableCodes: 'server, timeout' } }, '/p')
  assert.deepEqual(config.autoContinue.retryableCodes, ['SERVER', 'TIMEOUT'])
})

test('normalized config is frozen', () => {
  const { config } = normalizeConfig(undefined, '/p')
  assert.ok(Object.isFrozen(config))
  assert.ok(Object.isFrozen(config.autoContinue))
  assert.ok(Object.isFrozen(config.autoContinue.retryableCodes))
})

test('defaultConfig uses the platform separator of the supplied directory', () => {
  const windows = defaultConfig('C:\\Users\\me\\.dsh\\plugins\\dsh-task-notifier')
  const posix = defaultConfig('/home/me/.dsh/plugins/dsh-task-notifier')
  assert.equal(windows.logFile, 'C:\\Users\\me\\.dsh\\plugins\\dsh-task-notifier\\state\\task-notifier.log')
  assert.equal(posix.logFile, '/home/me/.dsh/plugins/dsh-task-notifier/state/task-notifier.log')
})

test('privacy and provider-retry defaults are safe', () => {
  const { config } = normalizeConfig(undefined, '/p')
  assert.equal(config.includePreview, false)
  assert.equal(config.autoContinue.respectProviderRetryAfter, true)
})

test('maxAttempts accepts the documented hard limit of 50', () => {
  const { config, warnings } = normalizeConfig({ autoContinue: { maxAttempts: 50 } }, '/p')
  assert.deepEqual(warnings, [])
  assert.equal(config.autoContinue.maxAttempts, 50)
})

test('relative logFile resolves against the plugin directory', () => {
  const windows = normalizeConfig({ logFile: 'state/custom.log' }, 'C:\\plugins\\task-notifier')
  assert.deepEqual(windows.warnings, [])
  assert.equal(windows.config.logFile, 'C:\\plugins\\task-notifier\\state\\custom.log')
  const posix = normalizeConfig({ logFile: 'state/custom.log' }, '/plugins/task-notifier')
  assert.equal(posix.config.logFile, '/plugins/task-notifier/state/custom.log')
  const nested = normalizeConfig({ logFile: 'logs\\nested\\x.jsonl' }, '/plugins/task-notifier')
  assert.equal(nested.config.logFile, '/plugins/task-notifier/logs/nested/x.jsonl')
  const absolute = normalizeConfig({ logFile: '/var/log/x.jsonl' }, '/plugins/task-notifier')
  assert.equal(absolute.config.logFile, '/var/log/x.jsonl')
})

test('null logFile disables logging with a warning', () => {
  const { config, warnings } = normalizeConfig({ logFile: null }, '/p')
  assert.equal(config.logFile, false)
  assert.ok(warnings.some((warning) => warning.includes('logFile')))
})

test('unknown config keys produce warnings', () => {
  const { config, warnings } = normalizeConfig({ notifyOnComplet: true, autoContinue: { maxAtempts: 5 } }, '/p')
  assert.equal(config.notifyOnComplete, true)
  assert.ok(warnings.some((warning) => warning.includes('notifyOnComplet')))
  assert.ok(warnings.some((warning) => warning.includes('maxAtempts')))
})

test('titlePrefix is capped at 60 characters', () => {
  const { config, warnings } = normalizeConfig({ titlePrefix: 'x'.repeat(80) }, '/p')
  assert.equal(config.titlePrefix.length, 60)
  assert.ok(warnings.some((warning) => warning.includes('titlePrefix')))
})
