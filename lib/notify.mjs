/**
 * Operating-system notification dispatch.
 *
 * The plugin runs inside the DSH Host process (a plain Node child process),
 * not inside Electron, so it cannot use Electron's `Notification`. Each
 * platform gets its native, self-contained command instead:
 *
 * - Windows: `powershell.exe -File win-toast.ps1` (WinRT toast, tray balloon fallback)
 * - macOS: `osascript -e 'display notification ...'`
 * - Linux: `notify-send`
 * - fallback: the Host logger (and the plugin debug log)
 *
 * Every dispatch is fire-and-forget: the agent loop must never wait for a
 * desktop notification.
 *
 * @module dsh-task-notifier/notify
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { minimalChildEnv } from './child-env.mjs'
import { messagesFor } from './i18n.mjs'

const TOAST_SCRIPT = fileURLToPath(new URL('./win-toast.ps1', import.meta.url))
const LINUX_ICON = fileURLToPath(new URL('../assets/icon.png', import.meta.url))

/**
 * Resolve the effective OS channel.
 * @param {string} configured - `auto`, `windows`, `macos`, `linux`, `log`, `none`
 * @param {NodeJS.Platform} [platform]
 * @returns {'windows'|'macos'|'linux'|'log'|'none'}
 */
export function resolveChannel(configured, platform = process.platform) {
  if (configured === 'none' || configured === 'log') return configured
  if (configured === 'windows' || configured === 'macos' || configured === 'linux') return configured
  if (configured !== 'auto') return 'log'
  if (platform === 'win32') return 'windows'
  if (platform === 'darwin') return 'macos'
  if (platform === 'linux') return 'linux'
  return 'log'
}

/**
 * Find an executable on PATH without spawning it. The plugin only needs an
 * availability check at mount; a missing OS helper must fall back to `log`
 * instead of silently failing every dispatch.
 * @param {string} command
 * @param {NodeJS.ProcessEnv} [env]
 * @param {NodeJS.Platform} [platform]
 * @returns {string|undefined}
 */
export function findExecutableOnPath(command, env = process.env, platform = process.platform) {
  const pathValue = env.PATH ?? env.Path ?? ''
  if (pathValue === '') return undefined
  const extensions =
    platform === 'win32'
      ? (env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
      : ['']
  const hasExtension = /\.[A-Za-z0-9]+$/.test(command)
  for (const directory of pathValue.split(delimiter)) {
    if (directory === '') continue
    const names = hasExtension ? [command] : extensions.map((extension) => `${command}${extension}`)
    for (const name of names) {
      const candidate = join(directory, name)
      try {
        if (existsSync(candidate)) return candidate
      } catch {
        // Unreadable PATH entry: try the next one.
      }
    }
  }
  return undefined
}

/**
 * Pick the channel that can actually deliver on this machine. `auto` already
 * maps by platform, but a Linux box without `notify-send` (or a blocked
 * PowerShell install) must degrade to logging with a visible warning instead
 * of failing every notification.
 * @param {string} configured
 * @param {NodeJS.Platform} [platform]
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {'windows'|'macos'|'linux'|'log'|'none'}
 */
export function resolveEffectiveChannel(configured, platform = process.platform, env = process.env) {
  const channel = resolveChannel(configured, platform)
  switch (channel) {
    case 'windows':
      return findExecutableOnPath('powershell.exe', env, platform) ? 'windows' : 'log'
    case 'macos':
      return findExecutableOnPath('osascript', env, platform) ? 'macos' : 'log'
    case 'linux':
      return findExecutableOnPath('notify-send', env, platform) ? 'linux' : 'log'
    default:
      return channel
  }
}

/**
 * Locate `powershell.exe` for the toast script.
 * @returns {string|undefined}
 */
export function resolveWindowsPowerShell() {
  const systemRoot = process.env.SystemRoot ?? process.env.windir
  const candidates = []
  if (systemRoot) candidates.push(`${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`)
  candidates.push('powershell.exe')
  const resolved = findExecutableOnPath('powershell.exe', process.env, 'win32')
  for (const candidate of candidates) {
    if (candidate !== 'powershell.exe' && existsSync(candidate)) return candidate
  }
  // A PATH-resolved absolute path is preferred over the bare name; the bare
  // name remains only as a last-resort compatibility fallback.
  return resolved ?? 'powershell.exe'
}

/**
 * Run one child process to completion with a hard timeout.
 * @param {string} command
 * @param {string[]} args
 * @param {{env?: NodeJS.ProcessEnv, replaceEnv?: boolean, timeoutMs?: number}} [options]
 * @returns {Promise<{code:number|null, stdout:string, stderr:string, timedOut:boolean}>}
 */
export function runCommand(command, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? 10_000
  const env = options.replaceEnv
    ? { ...(options.env ?? {}) }
    : { ...process.env, ...(options.env ?? {}) }
  return new Promise((resolve) => {
    let settled = false
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let child
    try {
      child = spawn(command, args, {
        env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      resolve({ code: null, stdout, stderr: String(error?.message ?? error), timedOut: false })
      return
    }

    const finish = (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, stdout, stderr, timedOut })
    }
    const timer = setTimeout(() => {
      timedOut = true
      killChildTree(child)
      finish(null)
    }, timeoutMs)
    timer.unref?.()

    child.stdout?.on('data', (chunk) => {
      if (stdout.length < 8192) stdout += String(chunk)
    })
    child.stderr?.on('data', (chunk) => {
      if (stderr.length < 8192) stderr += String(chunk)
    })
    child.on('error', (error) => {
      stderr += String(error?.message ?? error)
      finish(null)
    })
    child.on('close', (code) => finish(code))
  })
}

/**
 * Terminate a timed-out helper together with its descendants. `child.kill()`
 * only signals the direct child; Windows PowerShell launches conhost/child
 * processes that would otherwise keep running after a toast timeout.
 * @param {import('node:child_process').ChildProcess} child
 */
function killChildTree(child) {
  const pid = typeof child?.pid === 'number' ? child.pid : undefined
  try {
    if (process.platform === 'win32' && pid !== undefined) {
      const systemRoot = process.env.SystemRoot ?? process.env.windir
      const taskkill = systemRoot ? join(systemRoot, 'System32', 'taskkill.exe') : 'taskkill'
      spawnSync(taskkill, ['/pid', String(pid), '/T', '/F'], {
        windowsHide: true,
        timeout: 2_000,
        env: minimalChildEnv('win32'),
      })
      return
    }
    child.kill('SIGKILL')
  } catch {
    // The child may already be gone; the caller's settled guard is authoritative.
  }
}

/**
 * Build the AppleScript source for one macOS notification.
 * @param {string} title
 * @param {string} body
 * @returns {string}
 */
export function buildAppleScript(title, body) {
  return `display notification "${escapeAppleScript(body)}" with title "${escapeAppleScript(title)}"`
}

/** @param {string} value */
export function escapeAppleScript(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/[\u0000\r\n\u2028\u2029]/g, ' ')
}

/**
 * Create the notifier used by the observer.
 * @param {object} options
 * @param {any} options.config - normalized plugin config.
 * @param {(level:string, message:string, data?:unknown) => void} [options.log]
 * @param {(event:string, data?:unknown) => void} [options.fileLog]
 * @param {NodeJS.Platform} [options.platform]
 * @param {string} [options.channelOverride] - effective channel already probed by the caller.
 * @param {string} [options.linuxIconPath] - optional icon path for notify-send.
 * @param {(command:string, args:string[], options?:any) => Promise<any>} [options.run]
 * @param {string} [options.windowsAppId] - registered AUMID to brand the toast (undefined keeps the PowerShell identity).
 * @param {string} [options.windowsIconPath] - .ico used for the registry identity.
 * @param {string} [options.windowsImagePath] - raster image used as toast banner artwork.
 * @param {number} [options.maxQueued] - bounded dispatch queue length (default 20).
 * @returns {{channel:string, dispatch:(notification:{title:string, body:string}, meta?:{phase?:string})=>Promise<any>}}
 */
export function createNotifier(options) {
  const config = options.config
  const platform = options.platform ?? process.platform
  const channel = options.channelOverride ?? resolveChannel(config.channel, platform)
  const linuxIconPath =
    options.linuxIconPath !== undefined
      ? options.linuxIconPath
      : existsSync(LINUX_ICON)
        ? LINUX_ICON
        : ''
  const log = options.log ?? (() => {})
  const fileLog = options.fileLog ?? (() => {})
  const run = options.run ?? runCommand
  const windowsIdentity = {
    ...(options.windowsAppId ? { DSH_NOTIFY_AUMID: options.windowsAppId } : {}),
    ...(options.windowsImagePath ?? options.windowsIconPath
      ? { DSH_NOTIFY_ICON: options.windowsImagePath ?? options.windowsIconPath }
      : {}),
    // Clicking the toast focuses DSH through its registered `dsh://` protocol;
    // the label follows the configured notification language.
    ...(typeof config.clickUrl === 'string' && config.clickUrl !== ''
      ? { DSH_NOTIFY_LAUNCH: config.clickUrl, DSH_NOTIFY_ACTION: messagesFor(config.locale).openApp }
      : {}),
  }

  /**
   * @param {{title:string, body:string}} notification
   * @param {string} phase - notification phase, used for the queue and timeout policy.
   * @param {{title:string, body:string}} [logNotification] - full copy persisted to the debug log.
   * @returns {Promise<{ok:boolean, channel:string, detail?:string}>}
   */
  async function dispatchNow(notification, phase, logNotification = notification) {
    try {
      switch (channel) {
        case 'none':
          fileLog('notification.suppressed', { title: logNotification.title })
          return { ok: true, channel, detail: 'suppressed' }
        case 'log':
          log('info', `[notify/log] ${notification.title} :: ${notification.body}`)
          fileLog('notification.log', logNotification)
          return { ok: true, channel, detail: 'logged' }
        case 'windows': {
          const powershell = resolveWindowsPowerShell()
          if (!powershell) {
            log('warn', 'no powershell.exe found; falling back to log notification')
            fileLog('notification.fallback-log', { ...logNotification, reason: 'no-powershell' })
            return { ok: false, channel: 'windows', detail: 'no powershell.exe' }
          }
          const result = await run(
            powershell,
            ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', TOAST_SCRIPT],
            {
              env: minimalChildEnv(platform, {
                DSH_NOTIFY_TITLE: notification.title,
                DSH_NOTIFY_BODY: notification.body,
                ...windowsIdentity,
              }),
              replaceEnv: true,
              // Progress toasts are expendable; a terminal notification may
              // wait longer for the Windows toast stack.
              timeoutMs: phase === 'step' || phase === 'start' ? 6_000 : 12_000,
            },
          )
          const ok = result.code === 0
          const stdout = String(result.stdout ?? '')
          const marker = /(TOAST_OK_LEGACY|TOAST_OK|BALLOON_OK)/.exec(stdout)
          const mode = marker ? marker[1] : 'none'
          const rawDetail = (ok ? stdout : String(result.stderr ?? '') || stdout).trim()
          const detail = result.timedOut ? `timeout: ${rawDetail}` : rawDetail
          fileLog(ok ? 'notification.sent' : 'notification.failed', {
            ...logNotification,
            channel,
            exitCode: result.code,
            timedOut: result.timedOut,
            mode,
            degraded: mode !== 'TOAST_OK',
            detail: detail.slice(0, 1000),
          })
          if (!ok) log('warn', `windows toast failed (exit ${String(result.code)}): ${detail}`)
          return { ok, channel, detail, mode }
        }
        case 'macos': {
          const result = await run('osascript', ['-e', buildAppleScript(notification.title, notification.body)], {
            env: minimalChildEnv(platform),
            replaceEnv: true,
            timeoutMs: 8_000,
          })
          const ok = result.code === 0
          fileLog(ok ? 'notification.sent' : 'notification.failed', {
            ...logNotification,
            channel,
            exitCode: result.code,
            detail: (ok ? result.stdout : result.stderr).trim().slice(0, 1000),
          })
          return { ok, channel, detail: ok ? result.stdout.trim() : result.stderr.trim() }
        }
        case 'linux': {
          const appName =
            typeof config.titlePrefix === 'string' && config.titlePrefix.trim() !== ''
              ? config.titlePrefix.trim()
              : 'DSH'
          const args = ['-a', appName]
          if (linuxIconPath) args.push('-i', linuxIconPath)
          // `--` keeps a title/body that starts with "-" from being parsed as
          // a notify-send option.
          args.push('--', notification.title, notification.body)
          const result = await run('notify-send', args, {
            env: minimalChildEnv(platform),
            replaceEnv: true,
            timeoutMs: 8_000,
          })
          const ok = result.code === 0
          fileLog(ok ? 'notification.sent' : 'notification.failed', {
            ...logNotification,
            channel,
            exitCode: result.code,
            detail: (ok ? result.stdout : result.stderr).trim().slice(0, 1000),
          })
          return { ok, channel, detail: ok ? result.stdout.trim() : result.stderr.trim() }
        }
        default:
          return { ok: false, channel, detail: 'unsupported channel' }
      }
    } catch (error) {
      const detail = String(error?.message ?? error)
      log('warn', `notification dispatch failed: ${detail}`)
      fileLog('notification.error', { ...logNotification, channel, detail })
      return { ok: false, channel, detail }
    }
  }

  // Serialize dispatches through a bounded queue: a burst of step
  // notifications must not spawn one PowerShell process per step at the same
  // time, and a long outage must not leave minutes of stale toasts queued.
  // When the queue is full the oldest expendable entry (step/start) is
  // dropped; terminal notifications are never dropped before progress ones.
  const maxQueued =
    Number.isFinite(options.maxQueued) && options.maxQueued > 0 ? Math.floor(options.maxQueued) : 20
  /** @type {Array<{notification:{title:string,body:string}, logNotification:{title:string,body:string}, phase:string, resolve:(result:any)=>void}>} */
  const queue = []
  let pumping = false

  function enqueue(entry) {
    if (queue.length >= maxQueued) {
      // Drop by priority: progress first, then completions, then other
      // terminals. An approval alert is the one a user must act on, so it is
      // discarded only when the queue holds nothing else.
      const expendableIndex = pickDropIndex(queue)
      const dropped = queue.splice(expendableIndex, 1)[0]
      if (dropped) {
        fileLog('notification.dropped', {
          title: dropped.notification.title,
          phase: dropped.phase,
          reason: 'queue-full',
        })
        dropped.resolve({ ok: false, channel, detail: 'dropped (queue full)' })
      }
    }
    queue.push(entry)
    if (!pumping) void pump()
  }

  async function pump() {
    if (pumping) return
    pumping = true
    try {
      while (queue.length > 0) {
        const entry = queue.shift()
        const result = await dispatchNow(entry.notification, entry.phase, entry.logNotification)
        entry.resolve(result)
      }
    } finally {
      pumping = false
    }
  }

  /**
   * Queue one notification; the returned promise resolves with its dispatch
   * result (or a `dropped` result when the queue discarded it).
   * @param {{title:string, body:string}} notification
   * @param {{phase?:string, logNotification?:{title:string, body:string}}} [meta]
   */
  async function dispatch(notification, meta = {}) {
    return await new Promise((resolve) => {
      enqueue({
        notification,
        logNotification: meta.logNotification ?? notification,
        phase: meta.phase ?? 'unknown',
        resolve,
      })
    })
  }

  return { channel, dispatch }
}

/**
 * Pick the next queue entry to drop. Progress toasts are expendable, then
 * completions, then any notification that does not need user action; approval
 * and question alerts are the last resort because the user has to act on them.
 * @param {Array<{phase:string}>} queue
 * @returns {number}
 */
function pickDropIndex(queue) {
  const progress = queue.findIndex((item) => item.phase === 'step' || item.phase === 'start')
  if (progress >= 0) return progress
  const completion = queue.findIndex((item) => item.phase === 'complete')
  if (completion >= 0) return completion
  const actionless = queue.findIndex((item) => item.phase !== 'approval' && item.phase !== 'question')
  return actionless >= 0 ? actionless : 0
}
