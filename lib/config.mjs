/**
 * Configuration defaults and normalization for the task-notifier plugin.
 *
 * The plugin is loaded from a cordis patch entry, so `raw` is whatever the
 * `config:` block in `cordis.patch.yml` contains (possibly undefined). This
 * module merges it over the defaults with strict, defensive coercion: invalid
 * values never throw during plugin mount (a broken patch must not prevent the
 * kernel from booting), they fall back to the documented default.
 *
 * @module dsh-task-notifier/config
 */

/** Hard safety stop for continuation prompts, enforced by both config and observer. */
export const HARD_CONTINUE_LIMIT = 50

/**
 * Failure codes that count as a transient network or model-request failure.
 *
 * The first five mirror the built-in LLM retry policy (they appear in its
 * `policyKey`); the rest cover transport errors that surface under their own
 * code and provider-side failures the policy does not retry (e.g. the
 * `PI_AI_ERROR` wrapper) — the user asked for both classes to auto-continue.
 */
export const DEFAULT_RETRYABLE_CODES = Object.freeze([
  'EMPTY_RESPONSE',
  'RATE_LIMIT',
  'SERVER',
  'TIMEOUT',
  'TRANSPORT',
  'PI_AI_ERROR',
  'AI_ERROR',
  'PROVIDER',
  'MODEL',
  'OVERLOADED',
  'NETWORK',
  'CONNECTION',
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'SOCKET',
])

/** Supported operating-system notification channels. */
export const CHANNELS = Object.freeze(['auto', 'windows', 'macos', 'linux', 'log', 'none'])

/**
 * @typedef {object} AutoContinueConfig
 * @property {boolean} enabled - send a continuation prompt after an exhausted retry budget.
 * @property {string} message - the prompt text re-submitted to the agent.
 * @property {number} maxAttempts - consecutive auto-continuations allowed without a successful turn.
 * @property {number} cooldownMs - minimum spacing between two auto-continuations.
 * @property {boolean} requireRetryExhausted - only continue when the failure followed exhausted retries.
 * @property {boolean} respectProviderRetryAfter - wait at least `providerRetryAfterMs` before continuing.
 * @property {string[]} retryableCodes - failure codes considered transient/retryable.
 */

/**
 * @typedef {object} TaskNotifierConfig
 * @property {boolean} notifyOnStart
 * @property {boolean} notifyOnComplete
 * @property {boolean} notifyOnError
 * @property {boolean} notifyOnAbort
 * @property {boolean} notifyOnStep
 * @property {boolean} notifySubagents
 * @property {boolean} notifyOnApproval - notify when an approval prompt is pending for the user.
 * @property {number} approvalGraceMs - suppress auto-decided approvals answered within this window.
 * @property {boolean} notifyOnQuestion - notify when a tool call is waiting for a user answer (ask_user_question / plan review).
 * @property {number} questionGraceMs - suppress questions answered within this window.
 * @property {string} channel
 * @property {string} titlePrefix
 * @property {string} windowsAppId
 * @property {string} windowsAppName
 * @property {number} maxBodyChars
 * @property {boolean} includePreview - include the model-output preview in notifications.
 * @property {string|false} logFile
 * @property {AutoContinueConfig} autoContinue
 */

const DEFAULT_AUTO_CONTINUE = Object.freeze({
  enabled: true,
  message: '继续',
  maxAttempts: 3,
  cooldownMs: 5000,
  requireRetryExhausted: false,
  respectProviderRetryAfter: true,
  retryableCodes: DEFAULT_RETRYABLE_CODES,
})

/**
 * Build the default configuration for one plugin root directory.
 * @param {string} pluginDir - absolute plugin directory (used for the default log path).
 * @returns {Readonly<TaskNotifierConfig>}
 */
export function defaultConfig(pluginDir) {
  return deepFreeze({
    notifyOnStart: false,
    notifyOnComplete: true,
    notifyOnError: true,
    notifyOnAbort: false,
    notifyOnStep: false,
    notifySubagents: false,
    notifyOnApproval: true,
    approvalGraceMs: 1000,
    notifyOnQuestion: true,
    questionGraceMs: 1000,
    channel: 'auto',
    titlePrefix: 'DSH',
    windowsAppId: 'DSH.TaskNotifier',
    windowsAppName: 'DSH',
    maxBodyChars: 240,
    includePreview: false,
    logFile: joinPath(pluginDir, 'state', 'task-notifier.log'),
    autoContinue: { ...DEFAULT_AUTO_CONTINUE, retryableCodes: [...DEFAULT_RETRYABLE_CODES] },
  })
}

/**
 * Merge a raw patch `config:` block over the defaults.
 *
 * Unknown keys are ignored on purpose: patch files are user-editable and a
 * typo must not prevent the rest of the profile from booting.
 *
 * @param {unknown} raw - raw config from the loader.
 * @param {string} pluginDir - absolute plugin directory for default paths.
 * @returns {{config: TaskNotifierConfig, warnings: string[]}}
 */
export function normalizeConfig(raw, pluginDir) {
  const defaults = defaultConfig(pluginDir)
  const warnings = []
  const input = isPlainObject(raw) ? raw : {}
  if (raw !== undefined && !isPlainObject(raw)) {
    warnings.push('config must be a mapping; using defaults')
  }

  const config = {
    notifyOnStart: bool(input.notifyOnStart, defaults.notifyOnStart, 'notifyOnStart', warnings),
    notifyOnComplete: bool(input.notifyOnComplete, defaults.notifyOnComplete, 'notifyOnComplete', warnings),
    notifyOnError: bool(input.notifyOnError, defaults.notifyOnError, 'notifyOnError', warnings),
    notifyOnAbort: bool(input.notifyOnAbort, defaults.notifyOnAbort, 'notifyOnAbort', warnings),
    notifyOnStep: bool(input.notifyOnStep, defaults.notifyOnStep, 'notifyOnStep', warnings),
    notifySubagents: bool(input.notifySubagents, defaults.notifySubagents, 'notifySubagents', warnings),
    notifyOnApproval: bool(input.notifyOnApproval, defaults.notifyOnApproval, 'notifyOnApproval', warnings),
    approvalGraceMs: integer(
      input.approvalGraceMs,
      defaults.approvalGraceMs,
      0,
      60_000,
      'approvalGraceMs',
      warnings,
    ),
    notifyOnQuestion: bool(input.notifyOnQuestion, defaults.notifyOnQuestion, 'notifyOnQuestion', warnings),
    questionGraceMs: integer(
      input.questionGraceMs,
      defaults.questionGraceMs,
      0,
      60_000,
      'questionGraceMs',
      warnings,
    ),
    channel: enumeration(input.channel, CHANNELS, defaults.channel, 'channel', warnings),
    titlePrefix: titlePrefixValue(input.titlePrefix, defaults.titlePrefix, warnings),
    windowsAppId: text(input.windowsAppId, defaults.windowsAppId, 'windowsAppId', warnings),
    windowsAppName: text(input.windowsAppName, defaults.windowsAppName, 'windowsAppName', warnings),
    maxBodyChars: integer(input.maxBodyChars, defaults.maxBodyChars, 60, 2000, 'maxBodyChars', warnings),
    includePreview: bool(input.includePreview, defaults.includePreview, 'includePreview', warnings),
    logFile: logFileValue(input.logFile, defaults.logFile, warnings, pluginDir),
    autoContinue: normalizeAutoContinue(input.autoContinue, defaults.autoContinue, warnings),
  }
  warnUnknownKeys(input, KNOWN_TOP_LEVEL_KEYS, '', warnings)

  return { config: deepFreeze(config), warnings }
}

/** Top-level config keys this plugin understands. */
const KNOWN_TOP_LEVEL_KEYS = [
  'notifyOnStart',
  'notifyOnComplete',
  'notifyOnError',
  'notifyOnAbort',
  'notifyOnStep',
  'notifySubagents',
  'notifyOnApproval',
  'approvalGraceMs',
  'notifyOnQuestion',
  'questionGraceMs',
  'channel',
  'titlePrefix',
  'windowsAppId',
  'windowsAppName',
  'maxBodyChars',
  'includePreview',
  'logFile',
  'autoContinue',
]

/** Keys of the nested `autoContinue` mapping. */
const KNOWN_AUTO_CONTINUE_KEYS = [
  'enabled',
  'message',
  'maxAttempts',
  'cooldownMs',
  'requireRetryExhausted',
  'respectProviderRetryAfter',
  'retryableCodes',
]

/**
 * Report config keys the plugin does not read instead of silently ignoring a
 * typo in a hand-written patch.
 * @param {Record<string,unknown>} input
 * @param {readonly string[]} known
 * @param {string} prefix
 * @param {string[]} warnings
 */
function warnUnknownKeys(input, known, prefix, warnings) {
  for (const key of Object.keys(input)) {
    if (!known.includes(key)) warnings.push(`unknown config key ${prefix}${key} ignored`)
  }
}

/**
 * @param {unknown} raw
 * @param {Readonly<AutoContinueConfig>} defaults
 * @param {string[]} warnings
 * @returns {AutoContinueConfig}
 */
function normalizeAutoContinue(raw, defaults, warnings) {
  const input = isPlainObject(raw) ? raw : {}
  if (raw !== undefined && !isPlainObject(raw)) warnings.push('autoContinue must be a mapping; using defaults')
  warnUnknownKeys(input, KNOWN_AUTO_CONTINUE_KEYS, 'autoContinue.', warnings)

  return {
    enabled: bool(input.enabled, defaults.enabled, 'autoContinue.enabled', warnings),
    message: text(input.message, defaults.message, 'autoContinue.message', warnings),
    maxAttempts: integer(input.maxAttempts, defaults.maxAttempts, 0, HARD_CONTINUE_LIMIT, 'autoContinue.maxAttempts', warnings),
    cooldownMs: integer(input.cooldownMs, defaults.cooldownMs, 0, 600_000, 'autoContinue.cooldownMs', warnings),
    requireRetryExhausted: bool(
      input.requireRetryExhausted,
      defaults.requireRetryExhausted,
      'autoContinue.requireRetryExhausted',
      warnings,
    ),
    respectProviderRetryAfter: bool(
      input.respectProviderRetryAfter,
      defaults.respectProviderRetryAfter,
      'autoContinue.respectProviderRetryAfter',
      warnings,
    ),
    retryableCodes: stringList(
      input.retryableCodes,
      defaults.retryableCodes,
      'autoContinue.retryableCodes',
      warnings,
    ),
  }
}

/**
 * Title prefixes are rendered in every notification title; cap them so a long
 * value cannot crowd out the status text on Windows toasts.
 * @param {unknown} value @param {string} fallback @param {string[]} warnings
 */
function titlePrefixValue(value, fallback, warnings) {
  const prefix = text(value, fallback, 'titlePrefix', warnings)
  if (prefix.length <= 60) return prefix
  warnings.push('titlePrefix is limited to 60 characters; truncated')
  return prefix.slice(0, 60)
}

/** @param {unknown} value @param {boolean} fallback @param {string} key @param {string[]} warnings */
function bool(value, fallback, key, warnings) {
  if (value === undefined) return fallback
  if (typeof value === 'boolean') return value
  warnings.push(`${key} must be a boolean; using ${String(fallback)}`)
  return fallback
}

/** @param {unknown} value @param {number} fallback @param {number} min @param {number} max @param {string} key @param {string[]} warnings */
function integer(value, fallback, min, max, key, warnings) {
  if (value === undefined) return fallback
  const parsed = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  if (typeof parsed === 'number' && Number.isFinite(parsed)) {
    const rounded = Math.trunc(parsed)
    if (rounded >= min && rounded <= max) return rounded
    warnings.push(`${key} must be between ${min} and ${max}; using ${fallback}`)
    return fallback
  }
  warnings.push(`${key} must be an integer; using ${fallback}`)
  return fallback
}

/** @param {unknown} value @param {string} fallback @param {string} key @param {string[]} warnings */
function text(value, fallback, key, warnings) {
  if (value === undefined) return fallback
  if (typeof value === 'string' && value.trim() !== '') return value.trim()
  warnings.push(`${key} must be a non-empty string; using ${JSON.stringify(fallback)}`)
  return fallback
}

/** @param {unknown} value @param {readonly string[]} allowed @param {string} fallback @param {string} key @param {string[]} warnings */
function enumeration(value, allowed, fallback, key, warnings) {
  if (value === undefined) return fallback
  if (typeof value === 'string' && allowed.includes(value)) return value
  warnings.push(`${key} must be one of ${allowed.join(', ')}; using ${fallback}`)
  return fallback
}

/** @param {unknown} value @param {string|false} fallback @param {string[]} warnings @param {string} pluginDir */
function logFileValue(value, fallback, warnings, pluginDir) {
  if (value === undefined) return fallback
  if (value === false || value === null) {
    if (value === null) warnings.push('logFile must be a non-empty string or false; using the default path')
    return false
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const trimmed = value.trim()
    // A relative path must not resolve against the Host process cwd: on Windows
    // that is usually the install directory under Program Files, which is not
    // writable and would silently disable the debug log. Join without node:path
    // so a Windows-style plugin dir keeps backslashes on every platform.
    if (/^([A-Za-z]:[\\/]|\\\\|\/)/.test(trimmed)) return trimmed
    return joinPath(pluginDir, ...trimmed.split(/[\\/]+/).filter((segment) => segment !== ''))
  }
  warnings.push('logFile must be a non-empty string or false; using the default path')
  return fallback
}

/** @param {unknown} value @param {readonly string[]} fallback @param {string} key @param {string[]} warnings */
function stringList(value, fallback, key, warnings) {
  if (value === undefined) return [...fallback]
  const source = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : undefined
  if (source === undefined) {
    warnings.push(`${key} must be a list of strings; using defaults`)
    return [...fallback]
  }
  const cleaned = []
  for (const item of source) {
    if (typeof item !== 'string') continue
    const trimmed = item.trim().toUpperCase()
    if (trimmed !== '' && !cleaned.includes(trimmed)) cleaned.push(trimmed)
  }
  if (cleaned.length === 0) {
    warnings.push(`${key} contains no usable codes; using defaults`)
    return [...fallback]
  }
  return cleaned
}

/** @param {string} dir @param {...string} parts */
function joinPath(dir, ...parts) {
  if (!dir) return parts.join('/')
  const base = dir.replace(/[\\/]+$/, '')
  const separator = base.includes('\\') && !base.includes('/') ? '\\' : '/'
  return [base, ...parts].join(separator)
}

/** @param {unknown} value */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** @template T @param {T} value @returns {Readonly<T>} */
export function deepFreeze(value) {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  for (const child of Object.values(value)) deepFreeze(child)
  return Object.freeze(value)
}
