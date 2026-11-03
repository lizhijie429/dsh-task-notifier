import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import {
  WINDOWS_APP_ID,
  WINDOWS_APP_NAME,
  buildAppIdCommands,
  registerWindowsAppId,
  resolveWindowsIconPath,
} from '../lib/win-appid.mjs'

const PLUGIN_DIR = fileURLToPath(new URL('..', import.meta.url))

test('resolveWindowsIconPath prefers the bundled DSH icon', () => {
  const icon = resolveWindowsIconPath(PLUGIN_DIR)
  assert.ok(icon)
  assert.match(icon, /assets[\\/](tray\.ico|icon\.png)$/)
})

test('resolveWindowsIconPath returns undefined when nothing is installed', () => {
  const missing = resolveWindowsIconPath('/nonexistent/plugin', '/nonexistent/exe')
  assert.equal(missing, undefined)
})

test('buildAppIdCommands brands the AUMID and verifies the key', () => {
  const commands = buildAppIdCommands({
    appId: WINDOWS_APP_ID,
    displayName: WINDOWS_APP_NAME,
    iconPath: 'C:\\plugins\\assets\\tray.ico',
  })
  const key = `HKCU\\Software\\Classes\\AppUserModelId\\${WINDOWS_APP_ID}`
  assert.equal(commands.length, 3)
  assert.deepEqual(commands[0].args, ['add', key, '/v', 'DisplayName', '/t', 'REG_SZ', '/d', 'DSH', '/f'])
  assert.deepEqual(commands[1].args, ['add', key, '/v', 'IconUri', '/t', 'REG_SZ', '/d', 'C:\\plugins\\assets\\tray.ico', '/f'])
  assert.deepEqual(commands[2].args, ['query', key])
})

test('buildAppIdCommands omits IconUri when no icon is available', () => {
  const commands = buildAppIdCommands({ appId: 'X.Y', displayName: 'X' })
  assert.equal(commands.length, 2)
  assert.equal(commands[0].args.includes('IconUri'), false)
})

test('registerWindowsAppId is skipped outside Windows', () => {
  const platform = registerWindowsAppId({ platform: 'darwin', iconPath: 'C:\\x.ico' })
  assert.deepEqual(platform, { ok: false, skipped: 'platform' })
})

test('registerWindowsAppId brands the name even without an icon', () => {
  const calls = []
  const events = []
  const result = registerWindowsAppId({
    platform: 'win32',
    appId: WINDOWS_APP_ID,
    displayName: WINDOWS_APP_NAME,
    iconPath: undefined,
    spawnSyncFn: (command, args) => {
      calls.push({ command, args })
      return { status: 0, stdout: `${args[1]}\r\n`, stderr: '' }
    },
    fileLog: (event) => events.push(event),
  })
  assert.equal(result.ok, true)
  assert.equal(calls.length, 2)
  assert.equal(calls.some((call) => call.args.includes('IconUri')), false)
  assert.equal(events.at(-1), 'windows-appid.registered')
})

test('registerWindowsAppId runs every reg.exe command and reports success', () => {
  const calls = []
  const events = []
  const result = registerWindowsAppId({
    platform: 'win32',
    appId: WINDOWS_APP_ID,
    displayName: WINDOWS_APP_NAME,
    iconPath: 'C:\\plugins\\assets\\tray.ico',
    spawnSyncFn: (command, args) => {
      calls.push({ command, args })
      return { status: 0, stdout: `${args[1]}\r\n`, stderr: '' }
    },
    fileLog: (event) => events.push(event),
  })
  assert.equal(result.ok, true)
  assert.equal(calls.length, 3)
  assert.equal(events.at(-1), 'windows-appid.registered')
})

test('registerWindowsAppId reports a failing reg.exe add without throwing', () => {
  const events = []
  const result = registerWindowsAppId({
    platform: 'win32',
    iconPath: 'C:\\plugins\\assets\\tray.ico',
    spawnSyncFn: (command, args) => ({ status: args[0] === 'add' ? 1 : 0, stdout: '', stderr: 'access denied' }),
    fileLog: (event) => events.push(event),
  })
  assert.equal(result.ok, false)
  assert.match(result.detail, /access denied/)
  assert.equal(events.at(-1), 'windows-appid.failed')
})

test('registerWindowsAppId decodes OEM-code-page output without mangling the path', () => {
  const gbk = Buffer.from([0xc0, 0xee, 0xd6, 0xbe, 0xbd, 0xdc])
  const result = registerWindowsAppId({
    platform: 'win32',
    appId: WINDOWS_APP_ID,
    iconPath: 'C:\\x.ico',
    spawnSyncFn: () => ({ status: 0, stdout: gbk, stderr: Buffer.alloc(0) }),
  })
  assert.equal(result.ok, true)
  assert.ok(result.detail.includes('李志杰'), `detail=${result.detail}`)
})
