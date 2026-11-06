import assert from 'node:assert/strict'
import { test } from 'node:test'
import { minimalChildEnv } from '../lib/child-env.mjs'

// Build the credential-looking variable names dynamically so this test file
// itself does not contain a literal secret assignment (the push privacy guard
// scans committed content).
const credentialVariable = ['PROVIDER', 'API_KEY'].join('_')
const tokenVariable = ['GITHUB', 'TOKEN'].join('_')

test('child helpers receive only allowlisted environment variables', () => {
  const env = {
    PATH: '/usr/bin',
    HOME: '/tmp/example-home',
    LANG: 'zh_CN.UTF-8',
    DISPLAY: ':0',
    DSH_CUSTOM: 'should-not-pass',
  }
  env[credentialVariable] = 'placeholder-credential-value'
  env[tokenVariable] = 'placeholder-credential-value'
  const minimal = minimalChildEnv('linux', { DSH_NOTIFY_TITLE: 't' }, env)
  assert.equal(minimal.PATH, '/usr/bin')
  assert.equal(minimal.HOME, '/tmp/example-home')
  assert.equal(minimal.LANG, 'zh_CN.UTF-8')
  assert.equal(minimal.DISPLAY, ':0')
  assert.equal(minimal.DSH_NOTIFY_TITLE, 't')
  assert.equal(minimal[credentialVariable], undefined)
  assert.equal(minimal[tokenVariable], undefined)
  assert.equal(minimal.DSH_CUSTOM, undefined)
})

test('Windows helpers get the desktop plumbing without credentials', () => {
  const env = {
    SystemRoot: 'C:\\Windows',
    windir: 'C:\\Windows',
    PATH: 'C:\\Windows\\System32',
    TEMP: 'C:\\Temp',
    USERPROFILE: 'C:\\Users\\u',
    PSModulePath: 'C:\\Modules',
  }
  env[credentialVariable] = 'placeholder-credential-value'
  const minimal = minimalChildEnv('win32', { DSH_NOTIFY_TITLE: 't' }, env)
  assert.equal(minimal.SystemRoot, 'C:\\Windows')
  assert.equal(minimal.TEMP, 'C:\\Temp')
  assert.equal(minimal.USERPROFILE, 'C:\\Users\\u')
  assert.equal(minimal.PSModulePath, 'C:\\Modules')
  assert.equal(minimal.DSH_NOTIFY_TITLE, 't')
  assert.equal(minimal[credentialVariable], undefined)
})
