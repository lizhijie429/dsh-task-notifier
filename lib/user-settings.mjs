/**
 * Persistent user settings for the graphical settings page.
 *
 * The DSH settings service refuses writes for rows that live in a home patch
 * (the recommended way to mount this plugin by absolute path), so the page
 * stores its overrides in a small JSON sidecar under the plugin's state
 * directory. The file takes precedence over the profile patch and is applied
 * to the running plugin without a remount.
 *
 * Only the JSON-shaped config is stored; there are no credentials in it.
 *
 * @module dsh-task-notifier/user-settings
 */

import fs from 'node:fs'
import path from 'node:path'

/** Absolute path of the GUI settings sidecar. */
export function userSettingsPath(pluginDir) {
  return path.join(pluginDir, 'state', 'user-settings.json')
}

/**
 * Read the sidecar; malformed or unreadable files are ignored (with a warning).
 * @param {string} pluginDir
 * @param {(message: string) => void} warn
 * @returns {Record<string, unknown>}
 */
export function readUserSettings(pluginDir, warn = () => {}) {
  const file = userSettingsPath(pluginDir)
  try {
    const raw = fs.readFileSync(file, 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      warn(`user settings at ${file} must be a JSON object; ignoring it`)
      return {}
    }
    return parsed
  } catch (error) {
    if (error?.code !== 'ENOENT') warn(`could not read user settings at ${file}: ${String(error?.message ?? error)}`)
    return {}
  }
}

/**
 * Persist the effective config as the user-settings layer.
 * @param {string} pluginDir
 * @param {object} config
 */
export function writeUserSettings(pluginDir, config) {
  const file = userSettingsPath(pluginDir)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  try {
    fs.chmodSync(file, 0o600)
  } catch {
    // Windows inherits the user-profile ACL; chmod is best effort.
  }
}

/** Remove the sidecar so the profile patch/defaults take over again. */
export function deleteUserSettings(pluginDir) {
  try {
    fs.rmSync(userSettingsPath(pluginDir), { force: true })
  } catch {
    // Deleting a missing sidecar is not an error.
  }
}

/**
 * Merge the user-settings layer over the plain profile config.
 * The saved object is a complete config, so a shallow object merge is enough;
 * nested objects (autoContinue) are replaced as a whole.
 * @param {Record<string, unknown>} raw
 * @param {Record<string, unknown>} user
 * @returns {Record<string, unknown>}
 */
export function mergeUserSettings(raw, user) {
  return { ...raw, ...user }
}