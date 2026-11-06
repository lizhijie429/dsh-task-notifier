/**
 * Minimal environment for the OS notification helpers.
 *
 * The Host process environment also carries provider credentials, proxy
 * passwords and tokens. A notification helper (`powershell.exe`,
 * `osascript`, `notify-send`, `reg.exe`, `taskkill`) needs only desktop and
 * locale plumbing, so passing the whole environment would hand every helper a
 * copy of those secrets. This module builds an allowlisted environment instead.
 *
 * @module dsh-task-notifier/child-env
 */

const ALLOWED = Object.freeze({
  win32: [
    'SystemRoot',
    'SystemDrive',
    'windir',
    'TEMP',
    'TMP',
    'USERPROFILE',
    'HOMEDRIVE',
    'HOMEPATH',
    'APPDATA',
    'LOCALAPPDATA',
    'PATH',
    'PSModulePath',
    'PATHEXT',
    'COMSPEC',
    'PROCESSOR_ARCHITECTURE',
    'USERNAME',
  ],
  darwin: ['HOME', 'PATH', 'TMPDIR', 'LANG', 'USER', 'SHELL'],
  linux: [
    'HOME',
    'PATH',
    'DISPLAY',
    'WAYLAND_DISPLAY',
    'DBUS_SESSION_BUS_ADDRESS',
    'XDG_RUNTIME_DIR',
    'XDG_SESSION_TYPE',
    'XDG_CURRENT_DESKTOP',
    'LANG',
    'USER',
    'SHELL',
    'TMPDIR',
  ],
})

const FALLBACK = Object.freeze(['HOME', 'PATH', 'LANG', 'TMPDIR'])

/**
 * Build the allowlisted environment for one child process.
 * @param {NodeJS.Platform} [platform]
 * @param {Record<string,string|undefined>} [extra] - notification-specific variables.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Record<string,string>}
 */
export function minimalChildEnv(platform = process.platform, extra = {}, env = process.env) {
  const allowed = ALLOWED[platform] ?? FALLBACK
  /** @type {Record<string,string>} */
  const result = {}
  for (const key of allowed) {
    const value = env[key]
    if (typeof value === 'string') result[key] = value
  }
  // Locale families (LC_MESSAGES, LC_CTYPE, ...) are needed for correct text
  // rendering inside the helper, but carry no secrets.
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith('LC_') && typeof value === 'string') result[key] = value
  }
  for (const [key, value] of Object.entries(extra)) {
    if (typeof value === 'string') result[key] = value
  }
  return result
}