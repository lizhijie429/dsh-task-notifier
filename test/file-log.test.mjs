import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createFileLog } from '../lib/file-log.mjs'

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-task-notifier-log-'))
}

test('writes JSONL events and creates the directory', () => {
  const dir = tempDir()
  try {
    const path = join(dir, 'nested', 'log.jsonl')
    const log = createFileLog({ config: { logFile: path } })
    log('one', { a: 1 })
    log('two')
    const lines = readFileSync(path, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    assert.equal(lines.length, 2)
    assert.equal(lines[0].event, 'one')
    assert.deepEqual(lines[0].data, { a: 1 })
    assert.equal(lines[1].event, 'two')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('rotates at maxBytes and keeps one generation', () => {
  const dir = tempDir()
  try {
    const path = join(dir, 'log.jsonl')
    const log = createFileLog({ config: { logFile: path }, maxBytes: 120 })
    for (let i = 0; i < 6; i += 1) log('event', { i, payload: 'x'.repeat(40) })
    assert.ok(readdirSync(dir).includes('log.jsonl.1'))
    assert.ok(readFileSync(path, 'utf8').length > 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('logFile:false is a no-op', () => {
  const log = createFileLog({ config: { logFile: false } })
  assert.doesNotThrow(() => log('x'))
})

test('an unwritable target never throws', () => {
  const dir = tempDir()
  try {
    const path = join(dir, 'is-a-directory')
    mkdirSync(path)
    const log = createFileLog({ config: { logFile: path } })
    assert.doesNotThrow(() => log('event', { a: 1 }))
    assert.doesNotThrow(() => log('event2'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
