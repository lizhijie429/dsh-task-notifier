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
  assert.equal(config.autoContinue.requireRetryExhausted, true)
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
