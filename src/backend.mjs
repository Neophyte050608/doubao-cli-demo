import {CliError} from './errors.mjs'

async function readJson(response) {
  try {
    return await response.json()
  } catch {
    return null
  }
}

// Thin client over the demo backend's public contract. The CLI only speaks to
// this backend, never to Feishu directly.
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
    async startAuth() {
      const response = await call('POST', '/auth/start', {body: {}})
      const data = await readJson(response)
      if (!response.ok || !data?.authorizationUrl || !data?.deviceCode) {
        throw new CliError('LOGIN_START_FAILED', 'The backend could not start a login.')
      }
      return {
        authorizationUrl: data.authorizationUrl,
        deviceCode: data.deviceCode,
        pollInterval: Number(data.pollInterval) > 0 ? Number(data.pollInterval) : 2,
      }
    },
    async pollAuth(deviceCode) {
      const response = await call(
        'GET',
        `/auth/poll?device_code=${encodeURIComponent(deviceCode)}`,
      )
      const data = await readJson(response)
      if (!data?.status) {
        throw new CliError('LOGIN_POLL_FAILED', 'The backend returned an invalid poll response.')
      }
      return data
    },
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
