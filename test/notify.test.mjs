import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildAppleScript,
  createNotifier,
  escapeAppleScript,
  findExecutableOnPath,
  resolveChannel,
  resolveEffectiveChannel,
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

test('channel probing degrades to log when the OS helper is missing', () => {
  assert.equal(resolveEffectiveChannel('log'), 'log')
  assert.equal(resolveEffectiveChannel('none'), 'none')
  assert.equal(resolveEffectiveChannel('windows', 'win32', { PATH: '' }), 'log')
  assert.equal(resolveEffectiveChannel('linux', 'linux', { PATH: '' }), 'log')
  assert.equal(resolveEffectiveChannel('macos', 'darwin', { PATH: '' }), 'log')
  assert.equal(findExecutableOnPath('definitely-not-a-real-helper-xyz', { PATH: '' }), undefined)
  assert.ok(findExecutableOnPath('node', process.env, process.platform))
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

test('runCommand timeout terminates the helper and reports timedOut', async () => {
  const started = Date.now()
  const result = await runCommand(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { timeoutMs: 300 })
  assert.equal(result.timedOut, true)
  assert.equal(result.code, null)
  assert.ok(Date.now() - started < 5000, 'the timeout must not wait for the helper')
})

test('linux channel passes the configured application name', async () => {
  const invocations = []
  const notifier = createNotifier({
    config: { channel: 'linux', titlePrefix: 'MyPrefix' },
    platform: 'linux',
    run: async (command, args) => {
      invocations.push({ command, args })
      return { code: 0, stdout: '', stderr: '' }
    },
  })
  await notifier.dispatch({ title: 't', body: 'b' })
  assert.equal(invocations[0].command, 'notify-send')
  assert.deepEqual(invocations[0].args.slice(0, 2), ['-a', 'MyPrefix'])

  const fallback = []
  const defaultNotifier = createNotifier({
    config: { channel: 'linux' },
    platform: 'linux',
    run: async (command, args) => {
      fallback.push({ command, args })
      return { code: 0, stdout: '', stderr: '' }
    },
  })
  await defaultNotifier.dispatch({ title: 't', body: 'b' })
  assert.deepEqual(fallback[0].args.slice(0, 2), ['-a', 'DSH'])
})

test('linux channel separates options from the summary and can use an icon', async () => {
  const invocations = []
  const notifier = createNotifier({
    config: { channel: 'linux' },
    platform: 'linux',
    linuxIconPath: '/tmp/icon.png',
    run: async (command, args) => {
      invocations.push({ command, args })
      return { code: 0, stdout: '', stderr: '' }
    },
  })
  await notifier.dispatch({ title: '-starts-with-dash', body: 'body' })
  const args = invocations[0].args
  assert.deepEqual(args.slice(0, 2), ['-a', 'DSH'])
  assert.deepEqual(args.slice(2, 4), ['-i', '/tmp/icon.png'])
  assert.equal(args[4], '--', 'a summary starting with a dash must not be parsed as an option')
  assert.deepEqual(args.slice(5), ['-starts-with-dash', 'body'])

  const noIcon = createNotifier({
    config: { channel: 'linux' },
    platform: 'linux',
    linuxIconPath: '',
    run: async (command, args) => {
      invocations.push({ command, args })
      return { code: 0, stdout: '', stderr: '' }
    },
  })
  await noIcon.dispatch({ title: 't', body: 'b' })
  assert.equal(invocations[1].args[2], '--')
})

test('an explicit channel override wins over the configured channel', async () => {
  const invoked = []
  const notifier = createNotifier({
    config: { channel: 'windows' },
    platform: 'win32',
    channelOverride: 'log',
    log: () => {},
    fileLog: () => {},
    run: async () => {
      invoked.push('spawn')
      return { code: 0, stdout: '', stderr: '' }
    },
  })
  assert.equal(notifier.channel, 'log')
  const result = await notifier.dispatch({ title: 't', body: 'b' })
  assert.equal(result.ok, true)
  assert.equal(invoked.length, 0)
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

test('windows toast exposes the localized open action when clickUrl is set', async () => {
  const invocations = []
  const notifier = createNotifier({
    config: { channel: 'windows', clickUrl: 'dsh://open', locale: 'en' },
    platform: 'win32',
    run: async (command, args, options) => {
      invocations.push({ command, args, env: options.env })
      return { code: 0, stdout: 'TOAST_OK', stderr: '', timedOut: false }
    },
  })
  await notifier.dispatch({ title: 't', body: 'b' })
  assert.equal(invocations[0].env.DSH_NOTIFY_LAUNCH, 'dsh://open')
  assert.equal(invocations[0].env.DSH_NOTIFY_ACTION, 'Open DSH')

  const disabled = createNotifier({
    config: { channel: 'windows', clickUrl: '' },
    platform: 'win32',
    run: async (command, args, options) => {
      invocations.push({ command, args, env: options.env })
      return { code: 0, stdout: 'TOAST_OK', stderr: '', timedOut: false }
    },
  })
  await disabled.dispatch({ title: 't', body: 'b' })
  assert.equal(invocations[1].env.DSH_NOTIFY_LAUNCH, undefined)
  assert.equal(invocations[1].env.DSH_NOTIFY_ACTION, undefined)
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

test('a full queue keeps an approval alert and drops a completion first', async () => {
  const titles = []
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const notifier = createNotifier({
    config: { channel: 'windows' },
    platform: 'win32',
    maxQueued: 2,
    run: async (command, args, options) => {
      titles.push(options.env.DSH_NOTIFY_TITLE)
      await gate
      return { code: 0, stdout: 'TOAST_OK', stderr: '', timedOut: false }
    },
  })
  const first = notifier.dispatch({ title: 'first', body: 'b' }, { phase: 'complete' })
  const second = notifier.dispatch({ title: 'second', body: 'b' }, { phase: 'complete' })
  const third = notifier.dispatch({ title: 'third', body: 'b' }, { phase: 'complete' })
  const approval = notifier.dispatch({ title: 'approval', body: 'b' }, { phase: 'approval' })
  release()
  const results = await Promise.all([first, second, third, approval])
  assert.equal(results[1].ok, false, 'the oldest completion is dropped')
  assert.equal(results[3].ok, true, 'the approval alert is kept')
  assert.ok(titles.includes('approval'))
  assert.ok(!titles.includes('second'))
})
