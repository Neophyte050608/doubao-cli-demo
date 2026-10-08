import assert from 'node:assert/strict'
import {test} from 'node:test'

import {loadServerConfig} from '../server/config.mjs'
import {
  TOKEN_ENDPOINT,
  USER_INFO_ENDPOINT,
  buildAuthorizationUrl,
  exchangeCodeForUser,
} from '../server/feishu.mjs'
import {createRequestHandler} from '../server/server.mjs'

const config = {
  appId: 'cli_demo',
  appSecret: 'app-secret-value',
  redirectUri: 'http://127.0.0.1:8787/auth/callback',
  callbackPath: '/auth/callback',
  port: 8787,
}

function feishuFetch({onToken} = {}) {
  return async (url) => {
    if (url === TOKEN_ENDPOINT) {
      onToken?.()
      return Response.json({access_token: 'user-access-token'})
    }
    return Response.json({
      code: 0,
      data: {name: '示例用户', open_id: 'ou_demo', union_id: 'on_demo'},
    })
  }
}

// Minimal fake req/res so we can drive the handler without opening a socket.
function fakeResponse() {
  return {
    statusCode: undefined,
    headers: undefined,
    body: '',
    headersSent: false,
    writeHead(statusCode, headers) {
      this.statusCode = statusCode
      this.headers = headers
      this.headersSent = true
    },
    end(chunk) {
      if (chunk) this.body += chunk
    },
    json() {
      return JSON.parse(this.body)
    },
  }
}

async function invoke(handler, {method, path, headers = {}, body}) {
  const serialized = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  const request = {
    method,
    url: path,
    headers,
    async *[Symbol.asyncIterator]() {
      for (const chunk of serialized) yield chunk
    },
  }
  const response = fakeResponse()
  await handler(request, response)
  return response
}

test('server config requires app credentials', () => {
  assert.throws(
    () => loadServerConfig({FEISHU_APP_ID: 'cli_demo'}),
    (error) => error.code === 'INVALID_CONFIGURATION',
  )
})

test('authorization URL uses the official endpoint and required parameters', () => {
  const url = new URL(
    buildAuthorizationUrl({
      appId: 'cli_demo',
      redirectUri: config.redirectUri,
      state: 'state-value',
    }),
  )
  assert.equal(
    url.origin + url.pathname,
    'https://accounts.feishu.cn/open-apis/authen/v1/authorize',
  )
  assert.equal(url.searchParams.get('client_id'), 'cli_demo')
  assert.equal(url.searchParams.get('state'), 'state-value')
  assert.equal(url.searchParams.has('scope'), false)
})

test('exchangeCodeForUser returns only name/open_id/union_id', async () => {
  const requests = []
  const fetchImpl = async (url, options = {}) => {
    requests.push({url, options})
    if (url === TOKEN_ENDPOINT) return Response.json({access_token: 'user-access-token'})
    return Response.json({code: 0, data: {name: '示例用户', open_id: 'ou_demo', union_id: 'on_demo'}})
  }
  const user = await exchangeCodeForUser(config, 'one-time-code', fetchImpl)
  assert.deepEqual(user, {name: '示例用户', openId: 'ou_demo', unionId: 'on_demo'})
  assert.equal(requests[0].url, TOKEN_ENDPOINT)
  assert.equal(requests[1].url, USER_INFO_ENDPOINT)
  assert.equal(requests[1].options.headers.Authorization, 'Bearer user-access-token')
})

test('exchange failures never leak the secret or code', async () => {
  const sensitive = ['app-secret-value', 'one-time-code', 'upstream-token']
  const fetchImpl = async () =>
    Response.json({error: 'invalid_grant', error_description: sensitive.join(' ')}, {status: 400})
  await assert.rejects(
    exchangeCodeForUser(config, 'one-time-code', fetchImpl),
    (error) => {
      const rendered = `${error.code} ${error.message} ${error.stack}`
      assert.equal(error.code, 'TOKEN_EXCHANGE_FAILED')
      for (const value of sensitive) assert.equal(rendered.includes(value), false)
      return true
    },
  )
})

test('full backend handshake: start -> callback -> poll -> /api/me', async () => {
  const handler = createRequestHandler(config, {fetchImpl: feishuFetch()})

  const start = await invoke(handler, {method: 'POST', path: '/auth/start'})
  assert.equal(start.statusCode, 200)
  const {loginSessionId, verificationUrl, pollIntervalSeconds, expiresAt} = start.json()
  const state = new URL(verificationUrl).searchParams.get('state')
  assert.ok(loginSessionId.startsWith('cls_'))
  assert.equal(pollIntervalSeconds, 2)
  assert.ok(Number.isFinite(Date.parse(expiresAt)))

  // Poll before callback: still pending.
  const pending = await invoke(handler, {method: 'POST', path: '/auth/poll', body: {loginSessionId}})
  assert.equal(pending.json().status, 'pending')

  // Feishu redirects the browser to the callback.
  const callback = await invoke(handler, {
    method: 'GET',
    path: `/auth/callback?state=${state}&code=one-time-code`,
  })
  assert.equal(callback.statusCode, 200)

  // Poll again: authorized, with a session token and the user inline.
  const authorized = await invoke(handler, {method: 'POST', path: '/auth/poll', body: {loginSessionId}})
  assert.equal(authorized.json().status, 'authorized')
  const sessionToken = authorized.json().sessionToken
  assert.ok(sessionToken)
  assert.deepEqual(authorized.json().user, {name: '示例用户', openId: 'ou_demo', unionId: 'on_demo'})

  // The login session is single-use now.
  const expired = await invoke(handler, {method: 'POST', path: '/auth/poll', body: {loginSessionId}})
  assert.equal(expired.json().status, 'expired')

  // The one business call.
  const me = await invoke(handler, {
    method: 'GET',
    path: '/api/me',
    headers: {authorization: `Bearer ${sessionToken}`},
  })
  assert.equal(me.statusCode, 200)
  assert.deepEqual(me.json(), {
    name: '示例用户',
    openId: 'ou_demo',
    unionId: 'on_demo',
    authenticatedAt: me.json().authenticatedAt,
  })
})

test('cancel removes a pending login session', async () => {
  const handler = createRequestHandler(config, {fetchImpl: feishuFetch()})
  const start = await invoke(handler, {method: 'POST', path: '/auth/start'})
  const {loginSessionId} = start.json()
  const cancelled = await invoke(handler, {method: 'POST', path: '/auth/cancel', body: {loginSessionId}})
  assert.equal(cancelled.json().status, 'cancelled')
  const afterCancel = await invoke(handler, {method: 'POST', path: '/auth/poll', body: {loginSessionId}})
  assert.equal(afterCancel.json().status, 'expired')
})

test('/api/me rejects a missing or unknown token', async () => {
  const handler = createRequestHandler(config, {fetchImpl: feishuFetch()})
  const noToken = await invoke(handler, {method: 'GET', path: '/api/me'})
  assert.equal(noToken.statusCode, 401)
  const badToken = await invoke(handler, {
    method: 'GET',
    path: '/api/me',
    headers: {authorization: 'Bearer nope'},
  })
  assert.equal(badToken.statusCode, 401)
})

test('callback denial surfaces as a denied poll status', async () => {
  const handler = createRequestHandler(config, {fetchImpl: feishuFetch()})
  const start = await invoke(handler, {method: 'POST', path: '/auth/start'})
  const {loginSessionId, verificationUrl} = start.json()
  const state = new URL(verificationUrl).searchParams.get('state')
  const callback = await invoke(handler, {
    method: 'GET',
    path: `/auth/callback?state=${state}&error=access_denied`,
  })
  assert.equal(callback.statusCode, 403)
  const poll = await invoke(handler, {method: 'POST', path: '/auth/poll', body: {loginSessionId}})
  assert.equal(poll.json().status, 'denied')
})
