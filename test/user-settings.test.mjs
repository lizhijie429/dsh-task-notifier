import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  deleteUserSettings,
  mergeUserSettings,
  readUserSettings,
  userSettingsPath,
  writeUserSettings,
} from '../lib/user-settings.mjs'

function tempPluginDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'task-notifier-settings-'))
}

test('user settings round-trip and take precedence over profile config', () => {
  const dir = tempPluginDir()
  try {
    assert.deepEqual(readUserSettings(dir), {})
    writeUserSettings(dir, { reminderMs: 120000, autoContinue: { enabled: false } })
    const file = userSettingsPath(dir)
    assert.ok(fs.existsSync(file))
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.equal(stored.reminderMs, 120000)
    assert.deepEqual(readUserSettings(dir), stored)
    assert.deepEqual(
      mergeUserSettings({ reminderMs: 60000, titlePrefix: 'DSH' }, { reminderMs: 120000 }),
      { reminderMs: 120000, titlePrefix: 'DSH' },
    )
    deleteUserSettings(dir)
    assert.equal(fs.existsSync(file), false)
    assert.deepEqual(readUserSettings(dir), {})
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('malformed user settings are ignored with a warning', () => {
  const dir = tempPluginDir()
  const warnings = []
  try {
    fs.mkdirSync(path.join(dir, 'state'), { recursive: true })
    fs.writeFileSync(userSettingsPath(dir), '{ not json', 'utf8')
    assert.deepEqual(readUserSettings(dir, (message) => warnings.push(message)), {})
    assert.equal(warnings.length, 1)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})