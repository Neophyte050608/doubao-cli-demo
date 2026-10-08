import process from 'node:process'

import {CliError} from './errors.mjs'

const DEFAULT_BACKEND_URL = 'http://127.0.0.1:8787'

// The CLI only needs to know where the backend lives. It never holds the
// Feishu app secret: all OAuth happens on the backend.
export function loadConfig(environment = process.env) {
  const raw =
    environment.DOUBAO_LOGIN_DEMO_BACKEND_URL?.trim() || DEFAULT_BACKEND_URL

  let backendUrl
  try {
    backendUrl = new URL(raw)
  } catch {
    throw new CliError(
      'INVALID_CONFIGURATION',
      'DOUBAO_LOGIN_DEMO_BACKEND_URL must be a valid URL.',
    )
  }
  if (backendUrl.protocol !== 'http:' && backendUrl.protocol !== 'https:') {
    throw new CliError(
      'INVALID_CONFIGURATION',
      'DOUBAO_LOGIN_DEMO_BACKEND_URL must use http or https.',
    )
  }

  // Normalize to an origin string without a trailing slash.
  return {backendUrl: backendUrl.origin}
}
