import {normalizeHost} from './config.mjs'

const CONTRACT_HEADERS = Object.freeze({'X-Lark-Hive-CLI-Contract-Version': '3'})
const TERMINAL_STATUSES = new Set(['denied', 'cancelled', 'expired', 'failed', 'consumed'])

export class AuthHttpError extends Error {
  constructor(kind, message, {status, serverCode, cause} = {}) {
    super(message, {cause})
    this.name = 'AuthHttpError'
    this.kind = kind
    this.status = status
    this.serverCode = serverCode
  }
}

export function createAuthClient({fetchImpl, timeoutMs = 10_000, version}) {
  const request = async ({host, path, method = 'POST', body, accessToken, validate}) => {
    const normalizedHost = normalizeHost(host)
    const headers = {
      Accept: 'application/json',
      ...CONTRACT_HEADERS,
      'X-Lark-Hive-CLI-Version': version,
    }
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    if (accessToken) headers.Authorization = `Bearer ${accessToken}`

    let response
    try {
      response = await fetchImpl(`${normalizedHost}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : {body: JSON.stringify(body)}),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      const timedOut = error?.name === 'AbortError' || error?.name === 'TimeoutError'
      throw new AuthHttpError(timedOut ? 'timeout' : 'network', timedOut ? 'Gateway request timed out' : 'Gateway request failed', {cause: error})
    }

    let envelope
    try {
      envelope = await response.json()
    } catch (error) {
      throw new AuthHttpError('invalid-response', 'Gateway returned an invalid response', {status: response.status, cause: error})
    }
    const serverCode = typeof envelope?.code === 'number' ? envelope.code : undefined
    if (!response.ok || serverCode !== 0) {
      throw new AuthHttpError('server', 'Gateway request failed', {status: response.status, serverCode})
    }
    if (!('data' in envelope) || !validate(envelope.data)) {
      throw new AuthHttpError('invalid-response', 'Gateway returned an invalid response', {status: response.status, serverCode})
    }
    return envelope.data
  }

  return {
    start: ({host}) => request({host, path: '/api/cli/auth/start', body: {host: normalizeHost(host)}, validate: isStart}),
    poll: ({host, loginSessionId}) => request({host, path: '/api/cli/auth/poll', body: {loginSessionId}, validate: isPoll}),
    cancel: ({host, loginSessionId}) => request({host, path: '/api/cli/auth/cancel', body: {loginSessionId}, validate: isCancel}),
    refresh: ({host, accessToken}) => request({host, path: '/api/cli/auth/refresh', body: {}, accessToken, validate: isSession}),
    current: ({host, accessToken}) => request({host, path: '/api/cli/auth/current', method: 'GET', accessToken, validate: isIdentity}),
  }
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function isString(value) {
  return typeof value === 'string' && value.length > 0
}
function isStart(value) {
  return isRecord(value) && isString(value.loginSessionId) && isString(value.verificationUrl)
    && isString(value.userCode) && Number.isInteger(value.pollIntervalSeconds)
    && value.pollIntervalSeconds > 0 && isString(value.expiresAt)
}
function isIdentity(value) {
  return isRecord(value) && value.principalType === 'USER' && isString(value.userId)
    && isString(value.displayName) && isString(value.expiresAt)
    && typeof value.refreshable === 'boolean' && isString(value.refreshableUntil)
}
function isSession(value) {
  return isIdentity(value) && isString(value.accessToken)
}
function isPoll(value) {
  if (!isRecord(value) || !isString(value.status)) return false
  if (value.status === 'pending') return true
  if (value.status === 'authorized') return isSession(value.session)
  return TERMINAL_STATUSES.has(value.status)
    && (value.loginSessionId === undefined || isString(value.loginSessionId))
    && (value.errorCode === undefined || typeof value.errorCode === 'string')
    && (value.message === undefined || typeof value.message === 'string')
}
function isCancel(value) {
  return isRecord(value) && isString(value.status) && isString(value.loginSessionId)
}
