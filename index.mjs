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
 * The host half has no dependencies beyond Node built-ins (the browser settings
 * half and the vendored Config schema live beside it and are only loaded by the
 * matching DSH subsystems), so it can be mounted from a profile patch by
 * absolute path without a build step.
 *
 * @module dsh-task-notifier
 */

import { fileURLToPath } from 'node:url'
import { cloneConfig, normalizeConfig, unwrapConfig } from './lib/config.mjs'
import { registerConfigApi } from './lib/config-api.mjs'
import { createFileLog } from './lib/file-log.mjs'
import { mergeUserSettings, readUserSettings, deleteUserSettings, writeUserSettings } from './lib/user-settings.mjs'
import { createNotifier, resolveChannel, resolveEffectiveChannel } from './lib/notify.mjs'
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
/** Loader-enforced config schema; the client settings page and the loader use it. */
export { Config } from './lib/schema.mjs'

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

  const baseRaw = unwrapConfig(rawConfig)
  const initialUserSettings = readUserSettings(PLUGIN_DIR, (message) => log('warn', message))
  let revision = 0
  const { config: normalizedConfig, warnings } = normalizeConfig(
    mergeUserSettings(baseRaw, initialUserSettings),
    PLUGIN_DIR,
  )
  // The settings service edits `.volatile()` fields without remounting the
  // plugin. Keep one mutable snapshot that the file log, notifier and observer
  // all share, and refresh it in place on loader/volatile-update or a GUI save.
  const config = cloneConfig(normalizedConfig)
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
  const requestedChannel = resolveChannel(config.channel, process.platform)
  const effectiveChannel = resolveEffectiveChannel(config.channel, process.platform)
  if (effectiveChannel !== requestedChannel) {
    log(
      'warn',
      `notification channel "${requestedChannel}" is unavailable on this machine; falling back to "${effectiveChannel}" (install the OS helper or set channel explicitly)`,
    )
    fileLog('channel.fallback', { requested: requestedChannel, effective: effectiveChannel })
  }
  const windowsChannel = effectiveChannel === 'windows'
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
    channelOverride: effectiveChannel,
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

  // `.volatile()` Config fields (the whole schema) are committed into the
  // running entry without a remount; refresh the shared snapshot so the
  // observer and notifier read the new values on their next event. Mount-scoped
  // decisions (channel probe, Windows AUMID registration, the log file handle)
  // intentionally keep the values chosen at mount.
  const reloadVolatileConfig = () => {
    try {
      const merged = mergeUserSettings(
        unwrapConfig(rawConfig),
        readUserSettings(PLUGIN_DIR, (message) => log('warn', message)),
      )
      const next = normalizeConfig(merged, PLUGIN_DIR)
      Object.assign(config, cloneConfig(next.config))
      revision += 1
      for (const warning of next.warnings) {
        log('warn', `config: ${warning}`)
        fileLog('config.warning', { warning })
      }
      fileLog('config.volatile-update', { config: sanitizedConfig(config) })
      log('info', `config updated live (reminderMs=${config.reminderMs}, reminderMax=${config.reminderMax})`)
    } catch (error) {
      const message = String(error?.message ?? error)
      log('warn', `config.volatile-update failed: ${message}`)
      fileLog('config.volatile-update.error', { reason: message })
    }
  }
  if (typeof ctx.on === 'function') {
    const registerVolatileConfig = () => {
      const off = ctx.on('loader/volatile-update', reloadVolatileConfig)
      return () => {
        try {
          off?.()
        } catch {
          // Disposal is best effort; the loader owns the listener lifecycle.
        }
      }
    }
    if (typeof ctx.effect === 'function') {
      ctx.effect(registerVolatileConfig, 'task-notifier: volatile config')
    } else {
      registerVolatileConfig()
    }
  }

  // Graphical settings API. DSH's settings service rejects writes for rows
  // inserted by a home patch (the recommended absolute-path install), so the
  // page saves into the plugin's own user-settings sidecar and this handler
  // applies the validated config to the shared runtime snapshot.
  const publicConfig = () => cloneConfig(config)
  const saveUserConfig = (raw) => {
    const next = normalizeConfig(mergeUserSettings(baseRaw, raw), PLUGIN_DIR)
    writeUserSettings(PLUGIN_DIR, next.config)
    Object.assign(config, cloneConfig(next.config))
    revision += 1
    for (const warning of next.warnings) {
      log('warn', `settings: ${warning}`)
      fileLog('config.warning', { warning })
    }
    fileLog('settings.saved', { config: sanitizedConfig(config) })
    return { config: publicConfig(), revision }
  }
  const resetUserConfig = () => {
    deleteUserSettings(PLUGIN_DIR)
    const next = normalizeConfig(baseRaw, PLUGIN_DIR)
    Object.assign(config, cloneConfig(next.config))
    revision += 1
    fileLog('settings.reset', { config: sanitizedConfig(config) })
    return { config: publicConfig(), revision }
  }
  registerConfigApi(ctx, {
    get: () => ({ config: publicConfig(), revision }),
    save: saveUserConfig,
    reset: resetUserConfig,
    log: (message) => {
      log('info', message)
      fileLog('settings.api', { message })
    },
  })

  fileLog('plugin.mounted', {
    pid: process.pid,
    node: process.version,
    platform: process.platform,
    channel: notifier.channel,
    channelRequested: requestedChannel,
    channelFallback: effectiveChannel !== requestedChannel,
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

  try {
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
  } catch (error) {
    // A failed registration must not leave the process-wide latch behind.
    if (globalThis[MOUNT_KEY] === mountToken) delete globalThis[MOUNT_KEY]
    throw error
  }
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
    notifyOnApproval: config.notifyOnApproval,
    approvalGraceMs: config.approvalGraceMs,
    notifyOnQuestion: config.notifyOnQuestion,
    questionGraceMs: config.questionGraceMs,
    locale: config.locale,
    reminderMs: config.reminderMs,
    reminderMax: config.reminderMax,
    actionSound: config.actionSound,
    clickUrl: config.clickUrl,
    titleSessionLabel: config.titleSessionLabel,
    privacyMode: config.privacyMode,
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
