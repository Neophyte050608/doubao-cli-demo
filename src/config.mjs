import process from 'node:process'

import {CliError} from './errors.mjs'

const DEFAULT_REDIRECT_URI = 'http://127.0.0.1:8787/callback'

function requiredEnvironmentValue(environment, name) {
  const value = environment[name]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new CliError('INVALID_CONFIGURATION', `Missing environment variable: ${name}`)
  }
  return value
}

export function validateRedirectUri(value) {
  let redirectUri
  try {
    redirectUri = new URL(value)
  } catch {
    throw new CliError(
      'INVALID_REDIRECT_URI',
      'FEISHU_REDIRECT_URI must be a valid loopback URL.',
    )
  }

  const isIpv4Loopback = redirectUri.hostname === '127.0.0.1'
  const isIpv6Loopback = redirectUri.hostname === '[::1]'
  const isValid =
    redirectUri.protocol === 'http:' &&
    (isIpv4Loopback || isIpv6Loopback) &&
    redirectUri.port !== '' &&
    redirectUri.username === '' &&
    redirectUri.password === '' &&
    redirectUri.search === '' &&
    redirectUri.hash === ''

  if (!isValid) {
    throw new CliError(
      'INVALID_REDIRECT_URI',
      'FEISHU_REDIRECT_URI must use HTTP, an explicit loopback address and port, and contain no credentials, query, or fragment.',
    )
  }

  return redirectUri
}

export function loadConfig(environment = process.env) {
  const appId = requiredEnvironmentValue(environment, 'FEISHU_APP_ID')
  const appSecret = requiredEnvironmentValue(environment, 'FEISHU_APP_SECRET')
  const redirectUri =
    environment.FEISHU_REDIRECT_URI?.trim() || DEFAULT_REDIRECT_URI
  validateRedirectUri(redirectUri)

  return {appId, appSecret, redirectUri}
}
