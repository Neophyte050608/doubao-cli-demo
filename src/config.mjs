import {join} from 'node:path'

import {CliError, EXIT_CODES} from './errors.mjs'

export function normalizeHost(rawHost) {
  if (typeof rawHost !== 'string' || rawHost.trim() === '') {
    throw new CliError('INVALID_HOST', 'Gateway host is required', EXIT_CODES.OPERATIONAL)
  }

  let url
  try {
    url = new URL(rawHost.trim())
  } catch {
    throw new CliError('INVALID_HOST', 'Gateway host must be a valid URL', EXIT_CODES.OPERATIONAL)
  }

  if (url.username || url.password) {
    throw new CliError('INVALID_HOST', 'Gateway host must not contain credentials', EXIT_CODES.OPERATIONAL)
  }
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new CliError('INVALID_HOST', 'Gateway host must contain the origin only', EXIT_CODES.OPERATIONAL)
  }

  const loopback = url.hostname === '127.0.0.1' || url.hostname === '[::1]'
  if (url.protocol === 'http:' && loopback && !url.port) {
    throw new CliError('INVALID_HOST', 'Loopback HTTP Gateway host requires an explicit port', EXIT_CODES.OPERATIONAL)
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback && url.port)) {
    throw new CliError('INVALID_HOST', 'Gateway host must use HTTPS', EXIT_CODES.OPERATIONAL)
  }

  return url.origin
}

export function getDataDirectory({env, platform, homeDir}) {
  if (platform === 'win32') {
    return join(env.APPDATA || join(homeDir, 'AppData', 'Roaming'), 'doubao-login-demo')
  }
  return join(env.XDG_CONFIG_HOME || join(homeDir, '.config'), 'doubao-login-demo')
}
