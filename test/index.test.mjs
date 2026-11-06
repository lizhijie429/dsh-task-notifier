import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply } from '../index.mjs'

const MOUNT_KEY = Symbol.for('dsh-task-notifier.mount')

function makeCtx() {
  const cleanups = []
  const labels = []
  return {
    cleanups,
    labels,
    logger: () => ({ info() {}, warn() {}, error() {} }),
    effect(fn, label) {
      cleanups.push(fn())
      labels.push(label)
    },
    on() {
      return () => {}
    },
    get() {
      return undefined
    },
    agents: { get() {} },
  }
}

/** Dispose every registered effect, lifecycle first (reverse registration order). */
function disposeAll(ctx) {
  for (const cleanup of [...ctx.cleanups].reverse()) {
    if (typeof cleanup === 'function') cleanup()
  }
}

test('a duplicate mount is rejected until the first instance unloads', () => {
  delete globalThis[MOUNT_KEY]
  try {
    const first = makeCtx()
    apply(first, { channel: 'log', logFile: false })
    assert.equal(first.cleanups.length, 2, 'volatile-config and lifecycle effects')
    assert.ok(first.labels.includes('task-notifier.lifecycle()'))

    const second = makeCtx()
    apply(second, { channel: 'log', logFile: false })
    assert.equal(second.cleanups.length, 0, 'the duplicate registers nothing')

    disposeAll(first)
    assert.equal(globalThis[MOUNT_KEY], undefined, 'unload releases the latch')

    const third = makeCtx()
    apply(third, { channel: 'log', logFile: false })
    assert.equal(third.cleanups.length, 2, 'a fresh mount is admitted after unload')
    disposeAll(third)
  } finally {
    delete globalThis[MOUNT_KEY]
  }
})

test('a failed lifecycle registration releases the mount latch', () => {
  delete globalThis[MOUNT_KEY]
  try {
    const broken = makeCtx()
    broken.effect = () => {
      throw new Error('registration failed')
    }
    assert.throws(() => apply(broken, { channel: 'log', logFile: false }), /registration failed/)
    assert.equal(globalThis[MOUNT_KEY], undefined, 'the latch must not survive a failed mount')

    const retry = makeCtx()
    apply(retry, { channel: 'log', logFile: false })
    assert.equal(retry.cleanups.length, 2, 'a later mount is admitted')
    assert.ok(retry.labels.includes('task-notifier.lifecycle()'))
    disposeAll(retry)
  } finally {
    delete globalThis[MOUNT_KEY]
  }
})