/**
 * dsh-task-notifier — a DSH Host plugin that:
 *
 * 1. monitors live agent turns (start / steps / end) from the durable
 *    `session/event` feed,
 * 2. reports turn outcomes through OS notifications (Windows toast,
 *    macOS notification center, Linux notify-send), and
 * 3. re-submits a continuation prompt when a turn failed because the model
 *    request retry budget was exhausted (`llm/retry` events reached
 *    `maxRetries` and the loop closed the turn with `reason.kind === 'error'`).
 *
 * The plugin is host-only and has no dependencies beyond Node built-ins, so it
 * can be mounted from a profile patch by absolute path without a build step.
 *
 * @module dsh-task-notifier
 */

import { fileURLToPath } from 'node:url'
import { normalizeConfig } from './lib/config.mjs'
import { createFileLog } from './lib/file-log.mjs'
import { createNotifier, resolveChannel } from './lib/notify.mjs'
import { TaskObserver } from './lib/observer.mjs'
import { registerWindowsAppId, resolveWindowsIconPath, resolveWindowsImagePath } from './lib/win-appid.mjs'

/** Cordis plugin name. */
export const name = 'task-notifier'

/**
 * The live Agent registry is required: Cordis only exposes a service to plugins
 * that inject it. Without this injection `ctx.agents`/`ctx.get('agents')` stay
 * undefined and every continuation is skipped as `agent-gone` (observed
 * 2026-11-04: `agentsAvailable:false` broke auto-continue for all failures).
 */
export const inject = ['agents']

const PLUGIN_DIR = fileURLToPath(new URL('.', import.meta.url))

/**
 * Process-wide mount latch. A profile patch that inserts the same id twice
 * would otherwise mount two observers and emit every notification twice.
 * `Symbol.for` survives module reloads, so a hot-reloaded instance that is
 * applied before the old disposer runs is still rejected.
 */
const MOUNT_KEY = Symbol.for('dsh-task-notifier.mount')

/**
 * Mount the turn observer.
 * @param {any} ctx - Cordis context of the profile/host plugin tree.
 * @param {unknown} rawConfig - the `config:` block of the loader entry.
 */
export function apply(ctx, rawConfig) {
  const logger = resolveLogger(ctx)
  const log = (level, message) => {
    try {
      const method = logger && typeof logger[level] === 'function' ? logger[level] : logger?.info
      method?.call(logger, `[task-notifier] ${message}`)
    } catch {
      // Logging is best effort; the observer must keep working.
    }
  }

  if (globalThis[MOUNT_KEY] !== undefined) {
    log('warn', 'another task-notifier instance is already mounted in this process; skipping the duplicate mount')
    return
  }

  const { config, warnings } = normalizeConfig(rawConfig, PLUGIN_DIR)
  const fileLog = createFileLog({ config, logger: { warn: (message) => log('warn', message) } })
  for (const warning of warnings) {
    log('warn', `config: ${warning}`)
    fileLog('config.warning', { warning })
  }

  // Brand Windows toasts as DSH instead of "Windows PowerShell": register an
  // AUMID under HKCU (best effort) and pass it to the toast helper. When the
  // registration fails the helper keeps PowerShell's registered identity, so a
  // notification still appears, just with the generic name/icon. Registration
  // failures must never break the plugin mount.
  const windowsIconPath = resolveWindowsIconPath(PLUGIN_DIR)
  const windowsImagePath = resolveWindowsImagePath(PLUGIN_DIR)
  const windowsChannel = resolveChannel(config.channel, process.platform) === 'windows'
  const windowsRegistration = (() => {
    if (!windowsChannel) return { ok: false, skipped: 'channel' }
    try {
      return registerWindowsAppId({
        appId: config.windowsAppId,
        displayName: config.windowsAppName,
        iconPath: windowsIconPath,
        log,
        fileLog,
      })
    } catch (error) {
      log('warn', `Windows notification identity registration threw: ${String(error?.message ?? error)}`)
      fileLog('windows-appid.error', { reason: String(error?.message ?? error) })
      return { ok: false, detail: String(error?.message ?? error) }
    }
  })()

  const notifier = createNotifier({
    config,
    log,
    fileLog,
    windowsAppId: windowsRegistration.ok ? config.windowsAppId : undefined,
    windowsIconPath,
    windowsImagePath,
  })
  const agentRegistry = {
    get: (sessionId) => {
      try {
        return (ctx.agents ?? ctx.get?.('agents'))?.get?.(sessionId)
      } catch {
        return undefined
      }
    },
  }
  const agentsAvailable = (() => {
    try {
      return Boolean(ctx.agents ?? ctx.get?.('agents'))
    } catch {
      return false
    }
  })()

  const observer = new TaskObserver({ config, log, fileLog, notifier, agents: agentRegistry })

  fileLog('plugin.mounted', {
    pid: process.pid,
    node: process.version,
    platform: process.platform,
    channel: notifier.channel,
    warnings: warnings.slice(),
    agentsAvailable,
    windows: {
      appId: config.windowsAppId,
      registered: windowsRegistration.ok,
      ...(windowsRegistration.skipped ? { skipped: windowsRegistration.skipped } : {}),
      ...(windowsRegistration.detail ? { detail: String(windowsRegistration.detail).slice(0, 300) } : {}),
      iconPath: windowsIconPath ?? null,
      imagePath: windowsImagePath ?? null,
    },
    config: sanitizedConfig(config),
  })
  log(
    'info',
    `mounted (channel=${notifier.channel}, autoContinue=${config.autoContinue.enabled ? `on/${config.autoContinue.maxAttempts}` : 'off'})`,
  )

  const mountToken = {}
  globalThis[MOUNT_KEY] = mountToken

  ctx.effect(() => {
    const offSession = ctx.on('session/event', (session, event) => {
      try {
        observer.onSessionEvent(session, event)
      } catch (error) {
        log('warn', `session event handler failed: ${String(error?.message ?? error)}`)
        fileLog('observer.error', { event: event?.type, reason: String(error?.message ?? error) })
      }
    })
    const offStatus = ctx.on('agent/status', (payload) => {
      try {
        fileLog('agent.status', {
          sessionId: payload?.agent?.id,
          status: payload?.status,
        })
        observer.onAgentStatus(payload)
      } catch (error) {
        log('warn', `agent status handler failed: ${String(error?.message ?? error)}`)
      }
    })
    const offDisposed = ctx.on('session/disposed', (session) => {
      try {
        observer.onSessionDisposed(session)
      } catch (error) {
        log('warn', `session disposal handler failed: ${String(error?.message ?? error)}`)
      }
    })
    return () => {
      offSession?.()
      offStatus?.()
      offDisposed?.()
      observer.dispose()
      fileLog('plugin.unmounted', { pid: process.pid })
      // Buffered JSONL lines must land before the process may drop the plugin.
      fileLog.flush?.()
      if (globalThis[MOUNT_KEY] === mountToken) delete globalThis[MOUNT_KEY]
    }
  }, 'task-notifier.lifecycle()')
}

/**
 * Resolve a named Cordis logger, falling back to the console.
 * @param {any} ctx
 * @returns {any}
 */
function resolveLogger(ctx) {
  try {
    if (typeof ctx?.logger === 'function') {
      const named = ctx.logger('task-notifier')
      if (named && typeof named.info === 'function') return named
    }
    if (ctx?.logger && typeof ctx.logger.info === 'function') return ctx.logger
  } catch {
    // Fall through to console.
  }
  return console
}

/**
 * Keep the mount log readable and free of secrets.
 * @param {any} config
 */
function sanitizedConfig(config) {
  return {
    notifyOnStart: config.notifyOnStart,
    notifyOnComplete: config.notifyOnComplete,
    notifyOnError: config.notifyOnError,
    notifyOnAbort: config.notifyOnAbort,
    notifyOnStep: config.notifyOnStep,
    notifySubagents: config.notifySubagents,
    channel: config.channel,
    titlePrefix: config.titlePrefix,
    windowsAppId: config.windowsAppId,
    windowsAppName: config.windowsAppName,
    maxBodyChars: config.maxBodyChars,
    includePreview: config.includePreview,
    logFile: config.logFile,
    autoContinue: {
      ...config.autoContinue,
    },
  }
}
