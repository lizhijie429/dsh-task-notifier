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

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const TOAST_SCRIPT = fileURLToPath(new URL('./win-toast.ps1', import.meta.url))

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
 * Locate `powershell.exe` for the toast script.
 * @returns {string|undefined}
 */
export function resolveWindowsPowerShell() {
  const systemRoot = process.env.SystemRoot ?? process.env.windir
  const candidates = []
  if (systemRoot) candidates.push(`${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`)
  candidates.push('powershell.exe')
  for (const candidate of candidates) {
    if (candidate === 'powershell.exe') return candidate
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/**
 * Run one child process to completion with a hard timeout.
 * @param {string} command
 * @param {string[]} args
 * @param {{env?: NodeJS.ProcessEnv, timeoutMs?: number}} [options]
 * @returns {Promise<{code:number|null, stdout:string, stderr:string, timedOut:boolean}>}
 */
export function runCommand(command, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? 10_000
  return new Promise((resolve) => {
    let settled = false
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let child
    try {
      child = spawn(command, args, {
        env: { ...process.env, ...(options.env ?? {}) },
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
      try {
        child.kill()
      } catch {
        // The child may already be gone; the settled guard below is authoritative.
      }
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
  const channel = resolveChannel(config.channel, platform)
  const log = options.log ?? (() => {})
  const fileLog = options.fileLog ?? (() => {})
  const run = options.run ?? runCommand
  const windowsIdentity = {
    ...(options.windowsAppId ? { DSH_NOTIFY_AUMID: options.windowsAppId } : {}),
    ...(options.windowsImagePath ?? options.windowsIconPath
      ? { DSH_NOTIFY_ICON: options.windowsImagePath ?? options.windowsIconPath }
      : {}),
  }

  /**
   * @param {{title:string, body:string}} notification
   * @param {string} phase - notification phase, used for the queue and timeout policy.
   * @returns {Promise<{ok:boolean, channel:string, detail?:string}>}
   */
  async function dispatchNow(notification, phase) {
    try {
      switch (channel) {
        case 'none':
          fileLog('notification.suppressed', { title: notification.title })
          return { ok: true, channel, detail: 'suppressed' }
        case 'log':
          log('info', `[notify/log] ${notification.title} :: ${notification.body}`)
          fileLog('notification.log', notification)
          return { ok: true, channel, detail: 'logged' }
        case 'windows': {
          const powershell = resolveWindowsPowerShell()
          if (!powershell) {
            log('warn', 'no powershell.exe found; falling back to log notification')
            fileLog('notification.fallback-log', { ...notification, reason: 'no-powershell' })
            return { ok: false, channel: 'windows', detail: 'no powershell.exe' }
          }
          const result = await run(
            powershell,
            ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', TOAST_SCRIPT],
            {
              env: {
                DSH_NOTIFY_TITLE: notification.title,
                DSH_NOTIFY_BODY: notification.body,
                ...windowsIdentity,
              },
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
            ...notification,
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
            timeoutMs: 8_000,
          })
          const ok = result.code === 0
          fileLog(ok ? 'notification.sent' : 'notification.failed', {
            ...notification,
            channel,
            exitCode: result.code,
            detail: (ok ? result.stdout : result.stderr).trim().slice(0, 1000),
          })
          return { ok, channel, detail: ok ? result.stdout.trim() : result.stderr.trim() }
        }
        case 'linux': {
          const result = await run('notify-send', ['-a', 'DSH', notification.title, notification.body], {
            timeoutMs: 8_000,
          })
          const ok = result.code === 0
          fileLog(ok ? 'notification.sent' : 'notification.failed', {
            ...notification,
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
      fileLog('notification.error', { ...notification, channel, detail })
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
  /** @type {Array<{notification:{title:string,body:string}, phase:string, resolve:(result:any)=>void}>} */
  const queue = []
  let pumping = false

  function enqueue(entry) {
    if (queue.length >= maxQueued) {
      const expendableIndex = queue.findIndex((item) => item.phase === 'step' || item.phase === 'start')
      const dropped = expendableIndex >= 0 ? queue.splice(expendableIndex, 1)[0] : queue.shift()
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
        const result = await dispatchNow(entry.notification, entry.phase)
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
   * @param {{phase?:string}} [meta]
   */
  async function dispatch(notification, meta = {}) {
    return await new Promise((resolve) => {
      enqueue({ notification, phase: meta.phase ?? 'unknown', resolve })
    })
  }

  return { channel, dispatch }
}
