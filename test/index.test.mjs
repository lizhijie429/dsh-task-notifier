import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply } from '../index.mjs'

const MOUNT_KEY = Symbol.for('dsh-task-notifier.mount')

function makeCtx() {
  const cleanups = []
  return {
    cleanups,
    logger: () => ({ info() {}, warn() {}, error() {} }),
    effect(fn) {
      cleanups.push(fn())
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

test('a duplicate mount is rejected until the first instance unloads', () => {
  delete globalThis[MOUNT_KEY]
  try {
    const first = makeCtx()
    apply(first, { channel: 'log', logFile: false })
    assert.equal(first.cleanups.length, 1, 'the first instance registers its lifecycle effect')

    const second = makeCtx()
    apply(second, { channel: 'log', logFile: false })
    assert.equal(second.cleanups.length, 0, 'the duplicate registers nothing')

    first.cleanups[0]()
    assert.equal(globalThis[MOUNT_KEY], undefined, 'unload releases the latch')

    const third = makeCtx()
    apply(third, { channel: 'log', logFile: false })
    assert.equal(third.cleanups.length, 1, 'a fresh mount is admitted after unload')
    third.cleanups[0]()
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
    assert.equal(retry.cleanups.length, 1, 'a later mount is admitted')
    retry.cleanups[0]()
  } finally {
    delete globalThis[MOUNT_KEY]
  }
})
