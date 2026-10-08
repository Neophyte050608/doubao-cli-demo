import {spawn} from 'node:child_process'
import process from 'node:process'
import {setTimeout as delay} from 'node:timers/promises'

import {createBackendClient} from './backend.mjs'
import {loadConfig} from './config.mjs'
import {openBrowser} from './browser.mjs'
import {CliError} from './errors.mjs'

const LOGIN_TIMEOUT_MS = 5 * 60 * 1000

// Drive the login handshake against the backend:
//   start -> open browser -> poll until the backend finishes the OAuth exchange.
// Returns the backend-issued session token (no Feishu tokens ever reach the CLI).
export async function login({
  environment = process.env,
  fetchImpl = fetch,
  spawnImpl = spawn,
  platform = process.platform,
  stderr = process.stderr,
  sleep = (ms) => delay(ms),
  now = () => Date.now(),
} = {}) {
  const config = loadConfig(environment)
  const backend = createBackendClient({backendUrl: config.backendUrl, fetchImpl})

  const {authorizationUrl, deviceCode, pollInterval} = await backend.startAuth()

  stderr.write('Waiting for Feishu authorization in your browser...\n')
  try {
    await openBrowser(authorizationUrl, {platform, spawnImpl})
  } catch {
    stderr.write(`Could not open a browser. Open this URL manually:\n${authorizationUrl}\n`)
  }

  const deadline = now() + LOGIN_TIMEOUT_MS
  for (;;) {
    const result = await backend.pollAuth(deviceCode)
    if (result.status === 'complete') {
      if (!result.sessionToken) {
        throw new CliError('LOGIN_FAILED', 'The backend completed login without a session token.')
      }
      return {sessionToken: result.sessionToken}
    }
    if (result.status === 'denied') {
      throw new CliError('AUTHORIZATION_DENIED', 'Authorization was denied or cancelled.')
    }
    if (result.status === 'failed') {
      throw new CliError('AUTHORIZATION_FAILED', 'The backend failed to complete authorization.')
    }
    if (result.status === 'expired') {
      throw new CliError('AUTHORIZATION_TIMEOUT', 'The login session expired before completion.')
    }
    if (now() >= deadline) {
      throw new CliError('AUTHORIZATION_TIMEOUT', 'Authorization timed out after 5 minutes.')
    }
    await sleep(pollInterval * 1000)
  }
}
