import {randomBytes} from 'node:crypto'
import {createServer} from 'node:http'
import process from 'node:process'
import {fileURLToPath} from 'node:url'

import {loadServerConfig} from './config.mjs'
import {AuthError} from './errors.mjs'
import {buildAuthorizationUrl, exchangeCodeForUser} from './feishu.mjs'

const PENDING_TTL_MS = 5 * 60 * 1000
const POLL_INTERVAL_SECONDS = 2

function token() {
  return randomBytes(32).toString('base64url')
}

function sanitizeAuthMessage(message) {
  return String(message)
    .replace(/\b(bearer)\s+[^\s,;}]+/gi, '$1 [redacted]')
    .replace(
      /\b(access[_ -]?token|refresh[_ -]?token|authorization|cookie|token|secret|client_secret|authorization_code)\b\s*[:=]\s*[^\s,;}]+/gi,
      '$1=[redacted]',
    )
}

function sendJson(response, statusCode, body) {
  const payload = JSON.stringify(body)
  response.writeHead(statusCode, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
  })
  response.end(payload)
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('\"', '&quot;')
    .replaceAll("'", '&#39;')
}

function sendHtml(response, statusCode, message) {
  response.writeHead(statusCode, {
    'Cache-Control': 'no-store',
    'Content-Type': 'text/html; charset=utf-8',
  })
  response.end(
    `<!doctype html><meta charset="utf-8"><title>Doubao CLI demo</title>` +
      `<body style="font-family:system-ui;padding:3rem;text-align:center">` +
      `<p>${escapeHtml(message)}</p></body>`,
  )
}

async function readRequestBody(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return {}
  }
}

// Factory so tests can inject fetch and construct the handler without binding a port.
export function createRequestHandler(config, {fetchImpl = fetch, now = () => Date.now()} = {}) {
  // loginSessionId -> {state, status, user?, sessionToken?, createdAt}
  const pending = new Map()
  // state -> loginSessionId (the callback only knows the OAuth state)
  const stateIndex = new Map()
  // sessionToken -> {name, openId, unionId, authenticatedAt}
  const sessions = new Map()

  function sweep() {
    const cutoff = now() - PENDING_TTL_MS
    for (const [loginSessionId, record] of pending) {
      if (record.createdAt < cutoff) {
        pending.delete(loginSessionId)
        stateIndex.delete(record.state)
      }
    }
  }

  async function handle(request, response, url, body) {
    // 1. CLI asks the backend to begin a login. Backend owns state + the
    //    authorization URL; the CLI never sees the app secret.
    if (request.method === 'POST' && url.pathname === '/auth/start') {
      sweep()
      const state = token()
      const loginSessionId = `cls_${token()}`
      const createdAt = now()
      pending.set(loginSessionId, {state, status: 'pending', createdAt})
      stateIndex.set(state, loginSessionId)
      sendJson(response, 200, {
        loginSessionId,
        verificationUrl: buildAuthorizationUrl({
          appId: config.appId,
          redirectUri: config.redirectUri,
          state,
        }),
        pollIntervalSeconds: POLL_INTERVAL_SECONDS,
        expiresAt: new Date(createdAt + PENDING_TTL_MS).toISOString(),
      })
      return
    }

    // 2. Feishu redirects the browser here with the one-time code. The backend
    //    exchanges it (using the secret) and links the result to the session.
    if (request.method === 'GET' && url.pathname === config.callbackPath) {
      const state = url.searchParams.get('state')
      const code = url.searchParams.get('code')
      const loginSessionId = state ? stateIndex.get(state) : undefined
      const record = loginSessionId ? pending.get(loginSessionId) : undefined
      if (!record) {
        sendHtml(response, 400, 'Login session not found or expired. Please retry from the CLI.')
        return
      }
      if (url.searchParams.has('error') || !code) {
        record.status = 'denied'
        record.errorCode = 'AUTHORIZATION_DENIED'
        record.message = 'Authorization was not granted.'
        sendHtml(response, 403, 'Authorization was not granted. You may close this window.')
        return
      }
      try {
        const user = await exchangeCodeForUser(config, code, fetchImpl)
        const sessionToken = token()
        sessions.set(sessionToken, {
          ...user,
          authenticatedAt: new Date(now()).toISOString(),
        })
        record.status = 'authorized'
        record.user = user
        record.sessionToken = sessionToken
        sendHtml(response, 200, 'Login succeeded. You may close this window and return to the CLI.')
      } catch (error) {
        record.status = 'failed'
        record.errorCode = error instanceof AuthError ? error.code : 'AUTHORIZATION_FAILED'
        record.message = sanitizeAuthMessage(error instanceof Error ? error.message : 'Authorization failed.')
        sendHtml(response, 502, `${record.message} Please retry from the CLI.`)
      }
      return
    }

    // 3. CLI polls with the login session id until the browser flow finishes.
    if (request.method === 'POST' && url.pathname === '/auth/poll') {
      const loginSessionId = typeof body?.loginSessionId === 'string' ? body.loginSessionId : ''
      const record = loginSessionId ? pending.get(loginSessionId) : undefined
      if (!record) {
        sendJson(response, 200, {status: 'expired', loginSessionId})
        return
      }
      if (record.status === 'authorized') {
        const {sessionToken, user} = record
        pending.delete(loginSessionId)
        stateIndex.delete(record.state)
        sendJson(response, 200, {status: 'authorized', loginSessionId, sessionToken, user})
        return
      }
      if (record.status === 'denied' || record.status === 'failed') {
        pending.delete(loginSessionId)
        stateIndex.delete(record.state)
        sendJson(response, 200, {
          status: record.status,
          loginSessionId,
          errorCode: record.errorCode ?? (record.status === 'denied' ? 'AUTHORIZATION_DENIED' : 'AUTHORIZATION_FAILED'),
          message: record.message ?? (record.status === 'denied' ? 'Authorization was not granted.' : 'Authorization failed.'),
        })
        return
      }
      sendJson(response, 200, {status: 'pending', loginSessionId})
      return
    }

    // 3b. Best-effort cancel of a pending login (e.g. CLI received Ctrl+C).
    if (request.method === 'POST' && url.pathname === '/auth/cancel') {
      const loginSessionId = typeof body?.loginSessionId === 'string' ? body.loginSessionId : ''
      const record = loginSessionId ? pending.get(loginSessionId) : undefined
      if (record) {
        pending.delete(loginSessionId)
        stateIndex.delete(record.state)
      }
      sendJson(response, 200, {status: 'cancelled', loginSessionId})
      return
    }

    // 4. The one business endpoint: identify the caller from their session token.
    if (request.method === 'GET' && url.pathname === '/api/me') {
      const authorization = request.headers.authorization ?? ''
      const sessionToken = authorization.startsWith('Bearer ')
        ? authorization.slice('Bearer '.length)
        : ''
      const session = sessionToken ? sessions.get(sessionToken) : undefined
      if (!session) {
        sendJson(response, 401, {error: 'unauthorized'})
        return
      }
      sendJson(response, 200, {
        name: session.name,
        openId: session.openId,
        unionId: session.unionId,
        authenticatedAt: session.authenticatedAt,
      })
      return
    }

    if (request.method === 'GET' && url.pathname === '/healthz') {
      sendJson(response, 200, {status: 'ok'})
      return
    }

    sendJson(response, 404, {error: 'not_found'})
  }

  return async function requestHandler(request, response) {
    const url = new URL(request.url ?? '/', 'http://localhost')
    try {
      const body = request.method === 'POST' ? await readRequestBody(request) : undefined
      await handle(request, response, url, body)
    } catch {
      if (!response.headersSent) sendJson(response, 500, {error: 'internal_error'})
      else response.end()
    }
  }
}

export function startServer(config, options = {}) {
  const server = createServer(createRequestHandler(config, options))
  return new Promise((resolve) => {
    server.listen(config.port, () => resolve(server))
  })
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const {loadDotEnv} = await import('../src/env.mjs')
  await loadDotEnv()
  const config = loadServerConfig()
  const server = await startServer(config)
  const address = server.address()
  const shownPort = typeof address === 'object' && address ? address.port : config.port
  process.stderr.write(`Doubao CLI demo backend listening on http://127.0.0.1:${shownPort}\n`)
  process.stderr.write(`Feishu redirect URI: ${config.redirectUri}\n`)
}
