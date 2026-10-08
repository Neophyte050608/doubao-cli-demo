import {CliError} from './errors.mjs'

async function readJson(response) {
  try {
    return await response.json()
  } catch {
    return null
  }
}

// Thin client over the demo backend's public contract. The CLI only speaks to
// this backend, never to Feishu directly. The handshake mirrors lark-hive-cli:
// start -> poll (-> cancel) with a login session id, plus a live /api/me.
export function createBackendClient({backendUrl, fetchImpl = fetch}) {
  async function call(method, path, {body, token} = {}) {
    const headers = {}
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    if (token) headers.Authorization = `Bearer ${token}`
    let response
    try {
      response = await fetchImpl(`${backendUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    } catch {
      throw new CliError(
        'BACKEND_UNREACHABLE',
        `Could not reach the backend at ${backendUrl}.`,
      )
    }
    return response
  }

  return {
    // Begin a login. The backend owns the OAuth state and secret.
    async start() {
      const response = await call('POST', '/auth/start', {body: {}})
      const data = await readJson(response)
      if (!response.ok || !data?.loginSessionId || !data?.verificationUrl) {
        throw new CliError('LOGIN_START_FAILED', 'The backend could not start a login.')
      }
      return {
        loginSessionId: data.loginSessionId,
        verificationUrl: data.verificationUrl,
        pollIntervalSeconds: Number(data.pollIntervalSeconds) > 0 ? Number(data.pollIntervalSeconds) : 2,
        expiresAt: data.expiresAt,
      }
    },
    // Single status check for a login session (does not wait).
    async poll(loginSessionId) {
      const response = await call('POST', '/auth/poll', {body: {loginSessionId}})
      const data = await readJson(response)
      if (!data?.status) {
        throw new CliError('LOGIN_POLL_FAILED', 'The backend returned an invalid poll response.')
      }
      return data
    },
    // Best-effort cancel for a pending login session (used on Ctrl+C).
    async cancel(loginSessionId) {
      const response = await call('POST', '/auth/cancel', {body: {loginSessionId}})
      return (await readJson(response)) ?? {status: 'cancelled', loginSessionId}
    },
    // The one business endpoint: "who am I?" resolved live from the session.
    async fetchMe(token) {
      const response = await call('GET', '/api/me', {token})
      if (response.status === 401) {
        return null
      }
      const data = await readJson(response)
      if (!response.ok || !data?.name || !data?.openId || !data?.unionId) {
        throw new CliError('ME_FAILED', 'The backend could not return the current user.')
      }
      return {name: data.name, openId: data.openId, unionId: data.unionId}
    },
  }
}
