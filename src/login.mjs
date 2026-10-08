import {spawn} from 'node:child_process'
import process from 'node:process'
import {setTimeout as delay} from 'node:timers/promises'

import {openBrowser} from './browser.mjs'
import {CliError} from './errors.mjs'

// Terminal poll statuses that mean the login will never succeed. Mirrors the
// set lark-hive-cli maps from its gateway auth contract.
const TERMINAL_FAILURES = {
  denied: ['AUTHORIZATION_DENIED', 'Authorization was denied or cancelled.'],
  cancelled: ['AUTHORIZATION_CANCELLED', 'Login was cancelled.'],
  expired: ['AUTHORIZATION_TIMEOUT', 'The login session expired before completion.'],
  failed: ['AUTHORIZATION_FAILED', 'The backend failed to complete authorization.'],
  consumed: ['AUTHORIZATION_CONSUMED', 'This login session was already used. Please login again.'],
}

function sanitizeAuthMessage(message) {
  return String(message)
    .replace(/\b(bearer)\s+[^\s,;}]+/gi, '$1 [redacted]')
    .replace(
      /\b(access[_ -]?token|refresh[_ -]?token|authorization|cookie|token|secret|client_secret|authorization_code)\b\s*[:=]\s*[^\s,;}]+/gi,
      '$1=[redacted]',
    )
}

function terminalError(status, result = {}) {
  const [code, message] = TERMINAL_FAILURES[status] ?? ['AUTHORIZATION_FAILED', 'Authorization failed.']
  return new CliError(result.errorCode ?? code, sanitizeAuthMessage(result.message ?? message))
}

// Normalize a single poll response into pending / authorized / terminal shapes.
export function interpretPoll(result) {
  if (result.status === 'pending') {
    return {status: 'pending'}
  }
  if (result.status === 'authorized') {
    if (!result.sessionToken || !result.user) {
      throw new CliError('LOGIN_FAILED', 'The backend authorized the login without a session.')
    }
    return {status: 'authorized', sessionToken: result.sessionToken, user: result.user}
  }
  throw terminalError(result.status, result)
}

// Begin a login and return the metadata the user needs to authorize in a
// browser. The backend owns the OAuth state and app secret.
export async function startLogin({backend, stderr = process.stderr, open = true, spawnImpl = spawn, platform = process.platform}) {
  const started = await backend.start()
  stderr.write('Authorization pending\n')
  stderr.write(`Open:          ${started.verificationUrl}\n`)
  stderr.write(`Login session: ${started.loginSessionId}\n`)
  assertValidLoginStart(started)
  if (open) {
    try {
      await openBrowser(started.verificationUrl, {platform, spawnImpl})
    } catch {
      stderr.write(`Could not open a browser. Open the URL above manually.\n`)
    }
  }
  return started
}

function assertValidLoginStart(started) {
  if (!Number.isFinite(started.pollIntervalSeconds) || started.pollIntervalSeconds <= 0) {
    throw new CliError('LOGIN_START_FAILED', 'The backend returned an invalid poll interval.')
  }
}

// Poll the backend until the login reaches a terminal state, honoring the
// server-provided interval and expiry (like lark-hive-cli's wait loop).
export async function waitForLogin({
  backend,
  started,
  sleep = (ms) => delay(ms),
  now = () => Date.now(),
  signal,
}) {
  const expiresAt = started.expiresAt ? Date.parse(started.expiresAt) : Number.POSITIVE_INFINITY
  for (;;) {
    if (signal?.aborted) {
      await backend.cancel(started.loginSessionId).catch(() => {})
      throw terminalError('cancelled')
    }
    if (now() >= expiresAt) {
      throw terminalError('expired')
    }
    const outcome = interpretPoll(await backend.poll(started.loginSessionId))
    if (outcome.status === 'authorized') {
      return {sessionToken: outcome.sessionToken, user: outcome.user}
    }
    await sleep(started.pollIntervalSeconds * 1000)
  }
}

// Interactive login: start, open the browser, then wait for authorization.
export async function login({
  backend,
  spawnImpl = spawn,
  platform = process.platform,
  stderr = process.stderr,
  sleep = (ms) => delay(ms),
  now = () => Date.now(),
  signal,
}) {
  const started = await startLogin({backend, stderr, spawnImpl, platform})
  return waitForLogin({backend, started, sleep, now, signal})
}
