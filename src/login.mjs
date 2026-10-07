import {spawn} from 'node:child_process'
import {randomBytes} from 'node:crypto'
import process from 'node:process'

import {loadConfig} from './config.mjs'
import {
  buildAuthorizationUrl,
  createOAuthCallbackServer,
  exchangeCodeForUser,
  openBrowser,
} from './oauth.mjs'

export async function login({
  environment = process.env,
  fetchImpl = fetch,
  spawnImpl = spawn,
  platform = process.platform,
  stderr = process.stderr,
} = {}) {
  const config = loadConfig(environment)
  const state = randomBytes(32).toString('base64url')
  const callback = await createOAuthCallbackServer({
    redirectUri: config.redirectUri,
    state,
  })
  const authorizationUrl = buildAuthorizationUrl({
    appId: config.appId,
    redirectUri: config.redirectUri,
    state,
  })

  stderr.write('Waiting for Feishu authorization in your browser...\n')
  try {
    try {
      await openBrowser(authorizationUrl, {platform, spawnImpl})
    } catch {
      stderr.write(`Could not open a browser. Open this URL manually:\n${authorizationUrl}\n`)
    }

    const code = await callback.waitForCode
    return await exchangeCodeForUser(config, code, fetchImpl)
  } finally {
    await callback.close()
  }
}
