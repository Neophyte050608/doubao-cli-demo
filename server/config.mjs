import process from 'node:process'

import {AuthError} from './errors.mjs'

const DEFAULT_PORT = 8787
const DEFAULT_REDIRECT_URI = 'http://127.0.0.1:8787/auth/callback'

function requiredValue(environment, name) {
  const value = environment[name]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new AuthError('INVALID_CONFIGURATION', `Missing environment variable: ${name}`)
  }
  return value.trim()
}

// The backend owns the Feishu credentials. redirect_uri must point back at this
// backend's /auth/callback route (public URL in production, loopback in local dev).
export function loadServerConfig(environment = process.env) {
  const appId = requiredValue(environment, 'FEISHU_APP_ID')
  const appSecret = requiredValue(environment, 'FEISHU_APP_SECRET')
  const redirectUri =
    environment.FEISHU_REDIRECT_URI?.trim() || DEFAULT_REDIRECT_URI

  let parsedRedirect
  try {
    parsedRedirect = new URL(redirectUri)
  } catch {
    throw new AuthError('INVALID_REDIRECT_URI', 'FEISHU_REDIRECT_URI must be a valid URL.')
  }
  if (parsedRedirect.protocol !== 'http:' && parsedRedirect.protocol !== 'https:') {
    throw new AuthError('INVALID_REDIRECT_URI', 'FEISHU_REDIRECT_URI must use http or https.')
  }

  const portValue = environment.PORT?.trim()
  const port = portValue ? Number(portValue) : DEFAULT_PORT
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new AuthError('INVALID_CONFIGURATION', 'PORT must be a valid TCP port.')
  }

  return {
    appId,
    appSecret,
    redirectUri,
    callbackPath: parsedRedirect.pathname,
    port,
  }
}
