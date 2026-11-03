/**
 * Windows notification identity (AUMID) branding.
 *
 * A WinRT toast is rendered under an AppUserModelID. Using Windows PowerShell's
 * built-in AUMID (the plugin's first implementation) works everywhere, but the
 * toast then shows the "Windows PowerShell" name and icon. Unpackaged desktop
 * apps can register their own AUMID under
 * `HKCU\Software\Classes\AppUserModelId\<id>` with `DisplayName` and `IconUri`;
 * afterwards `ToastNotificationManager.CreateToastNotifier(id)` renders the
 * toast with that name and icon in the toast banner and Action Center.
 *
 * Registration is idempotent, HKCU-only, and best effort: when it fails the
 * caller keeps the built-in PowerShell identity so notifications still show.
 *
 * @module dsh-task-notifier/win-appid
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** AUMID used for DSH-branded Windows toasts. */
export const WINDOWS_APP_ID = 'DSH.TaskNotifier'

/** Display name shown on the toast's app header. */
export const WINDOWS_APP_NAME = 'DSH'

const REG_KEY_PREFIX = 'HKCU\\Software\\Classes\\AppUserModelId'

/**
 * Locate a DSH icon usable for the notification identity.
 *
 * Prefers the plugin's own `assets/` copies (stable when the app is moved),
 * then the installed app's `resources/` folder.
 *
 * @param {string} pluginDir - absolute plugin directory.
 * @param {string} [execPath] - Host executable (for the resources fallback).
 * @returns {string|undefined}
 */
export function resolveWindowsIconPath(pluginDir, execPath = process.execPath) {
  const candidates = []
  if (pluginDir) {
    candidates.push(join(pluginDir, 'assets', 'tray.ico'))
    candidates.push(join(pluginDir, 'assets', 'icon.png'))
  }
  const exeDir = typeof execPath === 'string' && execPath.length > 0 ? dirname(execPath) : ''
  if (exeDir) {
    candidates.push(join(exeDir, 'resources', 'tray.ico'))
    candidates.push(join(exeDir, 'resources', 'icon.png'))
  }
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return candidate
    } catch {
      // Unreadable candidate: try the next one.
    }
  }
  return undefined
}

/**
 * Build the `reg.exe` command lines that register one AUMID.
 * @param {{appId?:string, displayName?:string, iconPath?:string}} [options]
 * @returns {Array<{args:string[]}>}
 */
export function buildAppIdCommands(options = {}) {
  const appId = options.appId ?? WINDOWS_APP_ID
  const displayName = options.displayName ?? WINDOWS_APP_NAME
  const key = `${REG_KEY_PREFIX}\\${appId}`
  const commands = [
    { args: ['add', key, '/v', 'DisplayName', '/t', 'REG_SZ', '/d', displayName, '/f'] },
  ]
  if (options.iconPath) {
    commands.push({ args: ['add', key, '/v', 'IconUri', '/t', 'REG_SZ', '/d', options.iconPath, '/f'] })
  }
  // A read-back doubles as verification that the key is really addressable.
  commands.push({ args: ['query', key] })
  return commands
}

/**
 * Locate a raster image usable as the toast banner artwork.
 *
 * `appLogoOverride` only renders PNG/JPEG/GIF; the `.ico` used for the registry
 * identity is not valid there.
 *
 * @param {string} pluginDir - absolute plugin directory.
 * @returns {string|undefined}
 */
export function resolveWindowsImagePath(pluginDir) {
  if (!pluginDir) return undefined
  const candidate = join(pluginDir, 'assets', 'icon.png')
  try {
    return existsSync(candidate) ? candidate : undefined
  } catch {
    return undefined
  }
}

/**
 * Resolve `reg.exe` next to the current Windows installation.
 * @returns {string}
 */
function resolveRegExe() {
  const systemRoot = process.env.SystemRoot ?? process.env.windir
  if (systemRoot) {
    const candidate = join(systemRoot, 'System32', 'reg.exe')
    try {
      if (existsSync(candidate)) return candidate
    } catch {
      // Fall through to PATH lookup.
    }
  }
  return 'reg.exe'
}

/**
 * Register the DSH notification identity (idempotent, best effort).
 *
 * @param {object} options
 * @param {string} [options.appId]
 * @param {string} [options.displayName]
 * @param {string} [options.iconPath]
 * @param {NodeJS.Platform} [options.platform]
 * @param {typeof spawnSync} [options.spawnSyncFn] - injection point for tests.
 * @param {(level:string, message:string) => void} [options.log]
 * @param {(event:string, data?:unknown) => void} [options.fileLog]
 * @returns {{ok:boolean, skipped?:string, detail?:string}}
 */
export function registerWindowsAppId(options = {}) {
  const platform = options.platform ?? process.platform
  const log = options.log ?? (() => {})
  const fileLog = options.fileLog ?? (() => {})
  if (platform !== 'win32') return { ok: false, skipped: 'platform' }

  const spawn = options.spawnSyncFn ?? spawnSync
  const commands = buildAppIdCommands(options)
  let detail = ''
  for (const command of commands) {
    let result
    try {
      result = spawn(resolveRegExe(), command.args, {
        windowsHide: true,
        timeout: 1500,
        encoding: 'utf8',
      })
    } catch (error) {
      const reason = String(error?.message ?? error)
      fileLog('windows-appid.failed', { appId: options.appId, command: command.args[0], reason })
      log('warn', `could not register Windows notification identity: ${reason}`)
      return { ok: false, detail: reason }
    }
    if (result?.error) {
      const reason = String(result.error?.message ?? result.error)
      fileLog('windows-appid.failed', { appId: options.appId, command: command.args[0], reason })
      log('warn', `could not register Windows notification identity: ${reason}`)
      return { ok: false, detail: reason }
    }
    if (result?.status !== 0) {
      const reason = String(result?.stderr ?? '').trim() || `reg.exe exited with ${result?.status}`
      fileLog('windows-appid.failed', { appId: options.appId, command: command.args[0], reason })
      log('warn', `could not register Windows notification identity: ${reason}`)
      return { ok: false, detail: reason }
    }
    detail = String(result?.stdout ?? '').trim()
  }

  fileLog('windows-appid.registered', {
    appId: options.appId ?? WINDOWS_APP_ID,
    displayName: options.displayName ?? WINDOWS_APP_NAME,
    iconPath: options.iconPath,
  })
  return { ok: true, detail }
}
