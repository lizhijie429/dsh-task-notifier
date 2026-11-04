/**
 * Tiny append-only JSONL debug log owned by the plugin.
 *
 * The DSH Host's stdout/stderr are captured by the desktop shell, which makes
 * host-side plugin behavior hard to inspect. This log is deliberately small
 * and best-effort: failures to write must never affect the agent loop.
 *
 * Writes are buffered and flushed in batches so a burst of session events does
 * not issue one synchronous write (and one rotation stat) per event on the
 * Host's event loop. The buffer flushes on the next tick, when it reaches
 * {@link MAX_BATCH_LINES}, or explicitly through `log.flush()` (plugin unload
 * and tests).
 *
 * @module dsh-task-notifier/file-log
 */

import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { dirname } from 'node:path'

const MAX_BYTES = 256 * 1024

/** Flush synchronously once this many lines are pending. */
const MAX_BATCH_LINES = 200

/**
 * @param {object} options
 * @param {any} options.config - normalized plugin config.
 * @param {{warn:(message:string)=>void}} [options.logger]
 * @param {number} [options.maxBytes]
 * @returns {((event:string, data?:unknown) => void) & {flush:() => void}}
 */
export function createFileLog(options) {
  const config = options.config
  const logger = options.logger
  const maxBytes = options.maxBytes ?? MAX_BYTES
  const path = typeof config.logFile === 'string' ? config.logFile : undefined
  if (!path) {
    const noop = () => {}
    noop.flush = () => {}
    return noop
  }

  let disabled = false
  let directoryReady = false
  let warned = false
  /** @type {string[]} */
  const pending = []
  /** @type {ReturnType<typeof setImmediate> | null} */
  let scheduled = null

  const warnOnce = (message) => {
    if (warned) return
    warned = true
    try {
      logger?.warn(message)
    } catch {
      // Logging must stay best-effort.
    }
  }

  function writeBatch() {
    scheduled = null
    if (disabled || pending.length === 0) return
    const batch = pending.splice(0, pending.length)
    let chunk = ''
    try {
      if (!directoryReady) {
        mkdirSync(dirname(path), { recursive: true })
        directoryReady = true
      }
      for (const line of batch) {
        if (chunk.length > 0 && chunk.length + line.length > maxBytes) {
          rotateIfNeeded(path, maxBytes)
          appendFileSync(path, chunk, 'utf8')
          chunk = ''
        }
        chunk += line
      }
      if (chunk.length > 0) {
        rotateIfNeeded(path, maxBytes)
        appendFileSync(path, chunk, 'utf8')
      }
    } catch (error) {
      if (isTransient(error)) {
        // The file may be briefly locked; retry on the next flush instead of
        // disabling the log for the rest of the process.
        pending.unshift(...(chunk === '' ? batch : batch.slice(batch.length - countLines(chunk))))
        warnOnce(`task-notifier debug log write skipped: ${String(error?.message ?? error)}`)
        return
      }
      disabled = true
      warnOnce(`task-notifier debug log disabled: ${String(error?.message ?? error)}`)
    }
  }

  function schedule() {
    if (pending.length >= MAX_BATCH_LINES) {
      if (scheduled !== null) {
        clearImmediate(scheduled)
        scheduled = null
      }
      writeBatch()
      return
    }
    if (scheduled !== null) return
    scheduled = setImmediate(() => {
      scheduled = null
      writeBatch()
    })
  }

  function append(event, data) {
    if (disabled) return
    pending.push(
      `${JSON.stringify({
        time: new Date().toISOString(),
        event,
        ...(data === undefined ? {} : { data: data }),
      })}\n`,
    )
    schedule()
  }

  append.flush = () => {
    if (scheduled !== null) {
      clearImmediate(scheduled)
      scheduled = null
    }
    writeBatch()
  }

  return append
}

/**
 * Count newline-terminated lines in a string chunk.
 * @param {string} chunk
 * @returns {number}
 */
function countLines(chunk) {
  let count = 0
  for (let i = 0; i < chunk.length; i += 1) if (chunk.charCodeAt(i) === 10) count += 1
  return count
}

/**
 * Errors that may clear on a later write. Anything else (bad path, no space,
 * read-only volume) disables the log permanently.
 * @param {any} error
 * @returns {boolean}
 */
function isTransient(error) {
  const code = error?.code
  return code === 'ENOENT' || code === 'EPERM' || code === 'EBUSY'
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
