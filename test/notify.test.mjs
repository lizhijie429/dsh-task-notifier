import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildAppleScript,
  createNotifier,
  escapeAppleScript,
  resolveChannel,
  runCommand,
} from '../lib/notify.mjs'

test('resolveChannel maps automatic mode per platform', () => {
  assert.equal(resolveChannel('auto', 'win32'), 'windows')
  assert.equal(resolveChannel('auto', 'darwin'), 'macos')
  assert.equal(resolveChannel('auto', 'linux'), 'linux')
  assert.equal(resolveChannel('auto', 'freebsd'), 'log')
  assert.equal(resolveChannel('windows', 'darwin'), 'windows', 'explicit channel wins')
  assert.equal(resolveChannel('log', 'win32'), 'log')
  assert.equal(resolveChannel('none', 'win32'), 'none')
})

test('AppleScript escaping quotes, backslashes and newlines', () => {
  assert.equal(escapeAppleScript('say "hi"\\now'), 'say \\"hi\\"\\\\now')
  assert.equal(escapeAppleScript('line1\nline2'), 'line1 line2')
  assert.equal(
    buildAppleScript('DSH · 任务完成', '会话：demo'),
    'display notification "会话：demo" with title "DSH · 任务完成"',
  )
})

test('runCommand captures stdout and exit codes', async () => {
  const result = await runCommand(process.execPath, ['-e', "process.stdout.write('hello')"])
  assert.equal(result.code, 0)
  assert.equal(result.stdout, 'hello')
  assert.equal(result.timedOut, false)
})

test('runCommand reports spawn failures without throwing', async () => {
  const result = await runCommand(process.execPath, ['-e', "process.stderr.write('boom'); process.exit(3)"])
  assert.equal(result.code, 3)
  assert.match(result.stderr, /boom/)
})

test('log channel never shells out and reports success', async () => {
  const lines = []
  const notifier = createNotifier({
    config: { channel: 'log' },
    platform: 'linux',
    log: (level, message) => lines.push(`${level}:${message}`),
    fileLog: () => {},
  })
  assert.equal(notifier.channel, 'log')
  const result = await notifier.dispatch({ title: 't', body: 'b' })
  assert.equal(result.ok, true)
  assert.match(lines[0], /notify\/log/)
})

test('none channel suppresses every sink', async () => {
  const calls = []
  const notifier = createNotifier({
    config: { channel: 'none' },
    platform: 'win32',
    log: () => calls.push('log'),
    fileLog: () => calls.push('file'),
  })
  const result = await notifier.dispatch({ title: 't', body: 'b' })
  assert.equal(result.ok, true)
  assert.deepEqual(calls, ['file'])
})

test('windows channel passes text through environment, not argv', async () => {
  const invocations = []
  const notifier = createNotifier({
    config: { channel: 'windows' },
    platform: 'win32',
    windowsAppId: 'DSH.TaskNotifier',
    windowsIconPath: 'C:\\plugins\\assets\\tray.ico',
    run: async (command, args, options) => {
      invocations.push({ command, args, env: options.env })
      return { code: 0, stdout: 'TOAST_OK', stderr: '', timedOut: false }
    },
  })
  const result = await notifier.dispatch({ title: 'a "quoted" title', body: 'line1\nline2' })
  assert.equal(result.ok, true)
  assert.equal(invocations.length, 1)
  assert.equal(invocations[0].args.at(-2), '-File')
  assert.ok(invocations[0].args.at(-1).endsWith('win-toast.ps1'))
  assert.equal(invocations[0].env.DSH_NOTIFY_TITLE, 'a "quoted" title')
  assert.equal(invocations[0].env.DSH_NOTIFY_BODY, 'line1\nline2')
  assert.equal(invocations[0].env.DSH_NOTIFY_AUMID, 'DSH.TaskNotifier')
  assert.equal(invocations[0].env.DSH_NOTIFY_ICON, 'C:\\plugins\\assets\\tray.ico')
})

test('windows channel keeps the PowerShell identity when no AUMID is supplied', async () => {
  const invocations = []
  const notifier = createNotifier({
    config: { channel: 'windows' },
    platform: 'win32',
    run: async (command, args, options) => {
      invocations.push({ command, args, env: options.env })
      return { code: 0, stdout: 'TOAST_OK', stderr: '', timedOut: false }
    },
  })
  await notifier.dispatch({ title: 't', body: 'b' })
  assert.equal(invocations[0].env.DSH_NOTIFY_AUMID, undefined)
  assert.equal(invocations[0].env.DSH_NOTIFY_ICON, undefined)
})

test('failed dispatch is reported, never thrown', async () => {
  const notifier = createNotifier({
    config: { channel: 'windows' },
    platform: 'win32',
    run: async () => ({ code: 1, stdout: '', stderr: 'toast denied', timedOut: false }),
  })
  const result = await notifier.dispatch({ title: 't', body: 'b' })
  assert.equal(result.ok, false)
  assert.equal(result.detail, 'toast denied')
})

test('windows dispatch reports the toast mode and degrades visibly', async () => {
  const events = []
  const notifier = createNotifier({
    config: { channel: 'windows' },
    platform: 'win32',
    run: async () => ({ code: 0, stdout: 'BALLOON_OK\n', stderr: '', timedOut: false }),
    fileLog: (event, data) => events.push({ event, data }),
  })
  const result = await notifier.dispatch({ title: 't', body: 'b' })
  assert.equal(result.mode, 'BALLOON_OK')
  const sent = events.find((entry) => entry.event === 'notification.sent')
  assert.equal(sent.data.mode, 'BALLOON_OK')
  assert.equal(sent.data.degraded, true)
})

test('windowsImagePath wins over windowsIconPath for the banner image', async () => {
  const invocations = []
  const notifier = createNotifier({
    config: { channel: 'windows' },
    platform: 'win32',
    windowsIconPath: 'C:\\plugins\\assets\\tray.ico',
    windowsImagePath: 'C:\\plugins\\assets\\icon.png',
    run: async (command, args, options) => {
      invocations.push({ env: options.env })
      return { code: 0, stdout: 'TOAST_OK', stderr: '', timedOut: false }
    },
  })
  await notifier.dispatch({ title: 't', body: 'b' })
  assert.equal(invocations[0].env.DSH_NOTIFY_ICON, 'C:\\plugins\\assets\\icon.png')
})

test('dispatches are serialized', async () => {
  const order = []
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const notifier = createNotifier({
    config: { channel: 'windows' },
    platform: 'win32',
    run: async () => {
      order.push('start')
      await gate
      order.push('end')
      return { code: 0, stdout: 'TOAST_OK', stderr: '', timedOut: false }
    },
  })
  const first = notifier.dispatch({ title: '1', body: 'b' })
  const second = notifier.dispatch({ title: '2', body: 'b' })
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(order, ['start'], 'the second dispatch waits for the first')
  release()
  await Promise.all([first, second])
  assert.deepEqual(order, ['start', 'end', 'start', 'end'])
})

test('a burst beyond the queue cap drops progress but keeps terminal notifications', async () => {
  const runs = []
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const notifier = createNotifier({
    config: { channel: 'windows' },
    platform: 'win32',
    maxQueued: 2,
    run: async () => {
      runs.push('run')
      await gate
      return { code: 0, stdout: 'TOAST_OK', stderr: '', timedOut: false }
    },
  })
  const first = notifier.dispatch({ title: 's1', body: 'b' }, { phase: 'step' })
  const second = notifier.dispatch({ title: 's2', body: 'b' }, { phase: 'step' })
  const third = notifier.dispatch({ title: 's3', body: 'b' }, { phase: 'step' })
  const terminal = notifier.dispatch({ title: 'failed', body: 'b' }, { phase: 'error' })
  release()
  const results = await Promise.all([first, second, third, terminal])
  // s1 is in flight; the queue holds s2/s3; the terminal one pushes s2 out.
  assert.equal(runs.length, 3)
  assert.equal(results[1].ok, false)
  assert.match(results[1].detail, /dropped/)
  assert.equal(results[3].ok, true)
})
