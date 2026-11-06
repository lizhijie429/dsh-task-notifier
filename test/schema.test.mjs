import test from 'node:test'
import assert from 'node:assert/strict'
import { Config } from '../lib/schema.mjs'
import { cloneConfig, normalizeConfig, unwrapVolatile } from '../lib/config.mjs'

test('config schema accepts an empty config and documents volatile fields', () => {
  assert.doesNotThrow(() => Config({}))
  // Volatile fields parse to runtime references; the schema's job here is to
  // validate the raw profile config before apply() normalizes it.
  assert.doesNotThrow(() => Config({ remindOnStart: true }))
})

test('config schema accepts clickUrl: false and nested auto-continue fields', () => {
  assert.doesNotThrow(() => Config({ clickUrl: false, autoContinue: { enabled: false, maxAttempts: 5 } }))
  assert.doesNotThrow(() => Config({ autoContinue: { retryableCodes: ['TRANSPORT'] } }))
})

test('config schema rejects out-of-range values before apply', () => {
  assert.throws(() => Config({ reminderMax: 99 }))
  assert.throws(() => Config({ maxBodyChars: 10 }))
  assert.throws(() => Config({ channel: 'carrier-pigeon' }))
  assert.throws(() => Config({ autoContinue: { maxAttempts: 0 } }))
})

test('normalizing a plain config keeps the runtime defaults', () => {
  const { config, warnings } = normalizeConfig({ logFile: undefined }, '/opt/task-notifier')
  assert.deepEqual(warnings, [])
  assert.equal(config.logFile, '/opt/task-notifier/state/task-notifier.log')
  assert.equal(config.reminderMs, 60_000)
  assert.equal(config.actionSound, true)
  assert.ok(Object.isFrozen(config))
})

test('normalization unwraps schemastery volatile references', () => {
  const ref = (value) => ({ get: () => value })
  const { config, warnings } = normalizeConfig(
    {
      notifyOnStart: ref(true),
      reminderMs: ref(120_000),
      locale: ref('en'),
      clickUrl: ref(false),
      autoContinue: { enabled: ref(false), message: ref('go'), retryableCodes: ref(['TRANSPORT']) },
    },
    '/opt/task-notifier',
  )
  assert.deepEqual(warnings, [])
  assert.equal(config.notifyOnStart, true)
  assert.equal(config.reminderMs, 120_000)
  assert.equal(config.locale, 'en')
  assert.equal(config.clickUrl, '', 'false disables the click action internally')
  assert.equal(config.autoContinue.enabled, false)
  assert.equal(config.autoContinue.message, 'go')
  assert.deepEqual(config.autoContinue.retryableCodes, ['TRANSPORT'])
  assert.equal(unwrapVolatile(ref('x')), 'x')
  assert.equal(unwrapVolatile('x'), 'x')
})

test('cloneConfig produces the mutable runtime snapshot used for volatile updates', () => {
  const { config } = normalizeConfig({}, '/opt/task-notifier')
  const mutable = cloneConfig(config)
  assert.notEqual(mutable, config)
  assert.notEqual(mutable.autoContinue, config.autoContinue)
  assert.equal(Object.isFrozen(mutable), false)
  mutable.reminderMs = 120_000
  mutable.autoContinue.message = 'go'
  assert.equal(config.reminderMs, 60_000)
  assert.equal(config.autoContinue.message, '继续')
  assert.equal(mutable.reminderMs, 120_000)
})


