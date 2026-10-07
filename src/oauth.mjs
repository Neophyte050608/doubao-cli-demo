import {spawn} from 'node:child_process'
import {createServer} from 'node:http'
import process from 'node:process'

import {validateRedirectUri} from './config.mjs'
import {CliError} from './errors.mjs'

export const AUTHORIZATION_ENDPOINT =
  'https://accounts.feishu.cn/open-apis/authen/v1/authorize'
export const TOKEN_ENDPOINT = 'https://accounts.feishu.cn/oauth/v3/token'
export const USER_INFO_ENDPOINT =
  'https://open.feishu.cn/open-apis/authen/v1/user_info'
export const TENANT_ACCESS_TOKEN_ENDPOINT =
  'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal'
export const CONTACT_USER_ENDPOINT =
  'https://open.feishu.cn/open-apis/contact/v3/users'

const AUTHORIZATION_TIMEOUT_MS = 5 * 60 * 1000

export function buildAuthorizationUrl({appId, redirectUri, state}) {
  const url = new URL(AUTHORIZATION_ENDPOINT)
  url.searchParams.set('client_id', appId)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('state', state)
  return url.toString()
}

function sendCallbackResponse(response, statusCode, message) {
  response.writeHead(statusCode, {
    'Cache-Control': 'no-store',
    'Content-Type': 'text/plain; charset=utf-8',
    Pragma: 'no-cache',
  })
  response.end(message)
}

export async function createOAuthCallbackServer({
  redirectUri,
  state,
  timeoutMs = AUTHORIZATION_TIMEOUT_MS,
}) {
  const callbackUrl = validateRedirectUri(redirectUri)
  const host = callbackUrl.hostname === '[::1]' ? '::1' : callbackUrl.hostname
  const requestedPort = Number(callbackUrl.port)

  let resolveCode
  let rejectCode
  let resolveClose
  let settled = false
  let timer

  const waitForCode = new Promise((resolve, reject) => {
    resolveCode = resolve
    rejectCode = reject
  })
  const waitForClose = new Promise((resolve) => {
    resolveClose = resolve
  })

  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? '/', callbackUrl.origin)

    if (request.method !== 'GET' || requestUrl.pathname !== callbackUrl.pathname) {
      sendCallbackResponse(response, 404, 'Not found.')
      return
    }

    if (settled) {
      sendCallbackResponse(response, 409, 'This authorization callback is no longer active.')
      return
    }
    settled = true
    clearTimeout(timer)

    const closeWith = (statusCode, browserMessage, outcome) => {
      sendCallbackResponse(response, statusCode, browserMessage)
      server.close(() => resolveClose())
      outcome()
    }

    if (requestUrl.searchParams.get('state') !== state) {
      closeWith(400, 'Authorization failed. You may close this window.', () => {
        rejectCode(
          new CliError(
            'STATE_MISMATCH',
            'Authorization callback state did not match.',
          ),
        )
      })
      return
    }

    if (requestUrl.searchParams.has('error')) {
      closeWith(403, 'Authorization was not granted. You may close this window.', () => {
        rejectCode(
          new CliError(
            'AUTHORIZATION_DENIED',
            'Authorization was denied or cancelled.',
          ),
        )
      })
      return
    }

    const code = requestUrl.searchParams.get('code')
    if (!code) {
      closeWith(400, 'Authorization failed. You may close this window.', () => {
        rejectCode(
          new CliError(
            'AUTHORIZATION_FAILED',
            'Authorization callback did not contain a code.',
          ),
        )
      })
      return
    }

    closeWith(200, 'Authorization succeeded. You may close this window.', () => {
      resolveCode(code)
    })
  })

  const listening = new Promise((resolve, reject) => {
    server.once('error', () => {
      reject(
        new CliError(
          'CALLBACK_SERVER_FAILED',
          'Could not start the local OAuth callback server.',
        ),
      )
    })
    server.listen(requestedPort, host, resolve)
  })

  try {
    await listening
  } catch (error) {
    rejectCode(error)
    resolveClose()
    await waitForCode.catch(() => {})
    throw error
  }

  timer = setTimeout(() => {
    if (settled) return
    settled = true
    server.close(() => resolveClose())
    rejectCode(
      new CliError(
        'AUTHORIZATION_TIMEOUT',
        'Authorization timed out after 5 minutes.',
      ),
    )
  }, timeoutMs)
  timer.unref?.()

  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : requestedPort

  return {
    port,
    waitForCode,
    waitForClose,
    close() {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        rejectCode(
          new CliError('AUTHORIZATION_CANCELLED', 'Authorization was cancelled.'),
        )
      }
      if (server.listening) {
        server.close(() => resolveClose())
      } else {
        resolveClose()
      }
      return waitForClose
    },
  }
}

async function readJson(response) {
  try {
    return await response.json()
  } catch {
    return null
  }
}

export async function exchangeCodeForUser(config, code, fetchImpl = fetch) {
  let userAccessToken
  let tenantAccessToken

  try {
    let tokenResponse
    try {
      tokenResponse = await fetchImpl(TOKEN_ENDPOINT, {
        method: 'POST',
        headers: {'Content-Type': 'application/x-www-form-urlencoded'},
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: config.appId,
          client_secret: config.appSecret,
          code,
          redirect_uri: config.redirectUri,
        }).toString(),
      })
    } catch {
      throw new CliError(
        'TOKEN_EXCHANGE_FAILED',
        'Failed to exchange the authorization code.',
      )
    }

    const tokenBody = await readJson(tokenResponse)
    userAccessToken = tokenBody?.access_token
    if (!tokenResponse.ok || typeof userAccessToken !== 'string' || !userAccessToken) {
      throw new CliError(
        'TOKEN_EXCHANGE_FAILED',
        'Failed to exchange the authorization code.',
      )
    }

    let userResponse
    try {
      userResponse = await fetchImpl(USER_INFO_ENDPOINT, {
        method: 'GET',
        headers: {Authorization: `Bearer ${userAccessToken}`},
      })
    } catch {
      throw new CliError(
        'USER_INFO_FAILED',
        'Failed to retrieve the current Feishu user.',
      )
    }

    const userBody = await readJson(userResponse)
    const name = userBody?.data?.name
    const openId = userBody?.data?.open_id
    if (
      !userResponse.ok ||
      userBody?.code !== 0 ||
      typeof name !== 'string' ||
      !name ||
      typeof openId !== 'string' ||
      !openId
    ) {
      throw new CliError(
        'USER_INFO_FAILED',
        'Failed to retrieve the current Feishu user.',
      )
    }

    // The OAuth token proves which user completed login. The app-identity
    // lookup then resolves that open_id to the enterprise employee ID.
    userAccessToken = undefined
    let tenantTokenResponse
    try {
      tenantTokenResponse = await fetchImpl(TENANT_ACCESS_TOKEN_ENDPOINT, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          app_id: config.appId,
          app_secret: config.appSecret,
        }),
      })
    } catch {
      throw new CliError(
        'ENTERPRISE_IDENTITY_FAILED',
        'Failed to resolve the enterprise Feishu identity.',
      )
    }

    const tenantTokenBody = await readJson(tenantTokenResponse)
    tenantAccessToken = tenantTokenBody?.tenant_access_token
    if (
      !tenantTokenResponse.ok ||
      tenantTokenBody?.code !== 0 ||
      typeof tenantAccessToken !== 'string' ||
      !tenantAccessToken
    ) {
      throw new CliError(
        'ENTERPRISE_IDENTITY_FAILED',
        'Failed to resolve the enterprise Feishu identity.',
      )
    }

    let contactResponse
    try {
      const contactUrl = `${CONTACT_USER_ENDPOINT}/${encodeURIComponent(openId)}?user_id_type=open_id&department_id_type=open_department_id`
      contactResponse = await fetchImpl(contactUrl, {
        method: 'GET',
        headers: {Authorization: `Bearer ${tenantAccessToken}`},
      })
    } catch {
      throw new CliError(
        'ENTERPRISE_IDENTITY_FAILED',
        'Failed to resolve the enterprise Feishu identity.',
      )
    }

    const contactBody = await readJson(contactResponse)
    const contactUser = contactBody?.data?.user
    const employeeId = contactUser?.user_id
    if (
      !contactResponse.ok ||
      contactBody?.code !== 0 ||
      typeof employeeId !== 'string' ||
      !employeeId ||
      (typeof contactUser?.open_id === 'string' && contactUser.open_id !== openId)
    ) {
      throw new CliError(
        'ENTERPRISE_IDENTITY_FAILED',
        'Failed to resolve the enterprise Feishu identity.',
      )
    }

    return {name, openId, employeeId}
  } finally {
    userAccessToken = undefined
    tenantAccessToken = undefined
  }
}

export function openBrowser(
  url,
  {platform = process.platform, spawnImpl = spawn} = {},
) {
  const command =
    platform === 'darwin'
      ? 'open'
      : platform === 'win32'
        ? 'explorer.exe'
        : 'xdg-open'

  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawnImpl(command, [url], {
        shell: false,
        stdio: 'ignore',
      })
    } catch {
      reject(new CliError('BROWSER_OPEN_FAILED', 'Could not open the browser.'))
      return
    }

    let finished = false
    const fail = () => {
      if (finished) return
      finished = true
      reject(new CliError('BROWSER_OPEN_FAILED', 'Could not open the browser.'))
    }
    const finish = (exitCode) => {
      if (finished) return
      if (exitCode === 0) {
        finished = true
        resolve()
        return
      }
      fail()
    }

    child.once('error', fail)
    child.once('close', finish)
    child.unref?.()
  })
}
