/**
 * Tiny append-only JSONL debug log owned by the plugin.
 *
 * The DSH Host's stdout/stderr are captured by the desktop shell, which makes
 * host-side plugin behavior hard to inspect. This log is deliberately small
 * and best-effort: failures to write must never affect the agent loop.
 *
 * @module dsh-task-notifier/file-log
 */

import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { dirname } from 'node:path'

const MAX_BYTES = 256 * 1024

/**
 * @param {object} options
 * @param {any} options.config - normalized plugin config.
 * @param {{warn:(message:string)=>void}} [options.logger]
 * @param {number} [options.maxBytes]
 * @returns {(event:string, data?:unknown) => void}
 */
export function createFileLog(options) {
  const config = options.config
  const logger = options.logger
  const maxBytes = options.maxBytes ?? MAX_BYTES
  const path = typeof config.logFile === 'string' ? config.logFile : undefined
  if (!path) return () => {}

  let disabled = false
  let directoryReady = false

  return function append(event, data) {
    if (disabled) return
    try {
      if (!directoryReady) {
        mkdirSync(dirname(path), { recursive: true })
        directoryReady = true
      } else {
        rotateIfNeeded(path, maxBytes)
      }
      const line = `${JSON.stringify({
        time: new Date().toISOString(),
        event,
        ...(data === undefined ? {} : { data: data }),
      })}\n`
      appendFileSync(path, line, 'utf8')
    } catch (error) {
      disabled = true
      try {
        logger?.warn(`task-notifier debug log disabled: ${String(error?.message ?? error)}`)
      } catch {
        // Logging must stay best-effort.
      }
    }
  }
}

/**
 * Keep one rotated generation so the file can never grow without bound.
 * @param {string} path
 * @param {number} maxBytes
 */
function rotateIfNeeded(path, maxBytes) {
  try {
    const size = statSync(path).size
    if (size <= maxBytes) return
    renameSync(path, `${path}.1`)
  } catch (error) {
    if (error && /** @type {any} */ (error).code === 'ENOENT') return
    throw error
  }
}
