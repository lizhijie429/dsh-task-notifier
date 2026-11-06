/**
 * Same-origin HTTP API for the graphical settings page.
 *
 * DSH's own settings service rejects writes when the plugin row comes from a
 * home patch (the recommended absolute-path install), so the page talks to
 * this small API instead. It is mounted on the same host web server as the
 * GUI, requires a same-origin request plus a custom request header (so a
 * cross-site form post cannot mutate settings), and never returns secrets.
 *
 * @module dsh-task-notifier/config-api
 */

const PATH = '/task-notifier/config'
const MAX_BODY = 64 * 1024

/**
 * @param {any} ctx Cordis host context
 * @param {{get: () => {config: object, revision: number}, save: (raw: object) => object, reset: () => object, log?: (message: string) => void}} handlers
 */
export function registerConfigApi(ctx, handlers) {
  if (typeof ctx?.inject !== 'function') return
  try {
    ctx.inject(['webServer'], (sub) => {
      try {
        const webServer = sub.webServer
        if (!webServer || typeof webServer.register !== 'function') return
        const handler = createHandler(ctx, handlers)
        sub.effect(
          () => webServer.register({ kind: 'exact', path: PATH, handler }),
          'task-notifier: settings API',
        )
        handlers.log?.(`settings-api.registered path=${PATH}`)
      } catch (error) {
        handlers.log?.(`settings-api.register-failed ${safeMessage(error)}`)
      }
    })
  } catch (error) {
    handlers.log?.(`settings-api.inject-failed ${safeMessage(error)}`)
  }
}

/** @param {any} ctx @param {any} handlers */
function createHandler(ctx, handlers) {
  return async (req, res) => {
    try {
      if (!sameOrigin(req, ctx)) return json(res, 403, { ok: false, error: 'forbidden origin' })
      if (req.method === 'GET') {
        return json(res, 200, { ok: true, ...handlers.get() })
      }
      if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method not allowed' })
      // A custom header is not sent by HTML form posts; this blocks CSRF even
      // when the browser attaches the DSH auth cookie.
      if (req.headers['x-task-notifier-config'] !== '1') {
        return json(res, 403, { ok: false, error: 'missing settings header' })
      }
      const body = await readJson(req)
      if (body === null || typeof body !== 'object') return json(res, 400, { ok: false, error: 'invalid JSON body' })
      if (body.reset === true) {
        return json(res, 200, { ok: true, ...handlers.reset() })
      }
      if (body.config === null || typeof body.config !== 'object' || Array.isArray(body.config)) {
        return json(res, 400, { ok: false, error: 'config must be an object' })
      }
      const expected = body.expectedRevision
      const current = handlers.get()
      if (Number.isInteger(expected) && expected !== current.revision) {
        return json(res, 409, { ok: false, error: 'settings conflict', revision: current.revision })
      }
      return json(res, 200, { ok: true, ...handlers.save(body.config) })
    } catch (error) {
      handlers.log?.(`settings-api.error ${safeMessage(error)}`)
      return json(res, 400, { ok: false, error: safeMessage(error) })
    }
  }
}

/** Verify the browser's Origin matches this host (absent Origin is allowed for same-origin GETs). */
function sameOrigin(req, ctx) {
  const origin = req.headers.origin
  if (typeof origin !== 'string' || origin.length === 0) return true
  try {
    const parsed = new URL(origin)
    const expectedProtocol = ctx?.get?.('webServer')?.protocol ?? 'http:'
    return parsed.host === req.headers.host && parsed.protocol === expectedProtocol
  } catch {
    return false
  }
}

/** Read a bounded JSON request body. */
function readJson(req) {
  return new Promise((resolve) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
        resolve(null)
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        resolve(null)
      }
    })
    req.on('error', () => resolve(null))
  })
}

function json(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(payload))
}

function safeMessage(error) {
  const message = String(error?.message ?? error)
  return message.length > 300 ? `${message.slice(0, 300)}…` : message
}