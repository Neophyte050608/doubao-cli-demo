import assert from 'node:assert/strict'
import test from 'node:test'

import {AuthHttpError, createAuthClient} from '../src/auth-client.mjs'

const startData = {
  loginSessionId: 'cls_1', verificationUrl: 'https://gateway.example.com/api/cli/auth/authorize?loginSessionId=cls_1',
  userCode: 'ABCD-EFGH', pollIntervalSeconds: 2, expiresAt: '2026-09-30T12:00:00Z',
}
const sessionData = {
  accessToken: 'secret-access-token', expiresAt: '2026-09-30T12:00:00Z', principalType: 'USER',
  userId: 'ou_1', displayName: 'Alice', refreshable: true, refreshableUntil: '2026-10-30T12:00:00Z',
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json'}})
}

function recordingClient(responses) {
  const requests = []
  const fetchImpl = async (url, options) => {
    requests.push({url, ...options})
    const response = responses.shift()
    return typeof response === 'function' ? response(url, options) : response
  }
  return {client: createAuthClient({fetchImpl, timeoutMs: 1000, version: '0.1.0'}), requests}
}

test('sends start and poll using contract v3', async () => {
  const {client, requests} = recordingClient([
    jsonResponse({code: 0, data: startData}),
    jsonResponse({code: 0, data: {status: 'pending'}}),
  ])
  assert.deepEqual(await client.start({host: 'https://gateway.example.com'}), startData)
  assert.deepEqual(await client.poll({host: 'https://gateway.example.com', loginSessionId: 'cls_1'}), {status: 'pending'})
  assert.equal(requests[0].url, 'https://gateway.example.com/api/cli/auth/start')
  assert.equal(requests[0].method, 'POST')
  assert.equal(requests[0].headers['X-Lark-Hive-CLI-Contract-Version'], '3')
  assert.equal(requests[0].headers['X-Lark-Hive-CLI-Version'], '0.1.0')
  assert.deepEqual(JSON.parse(requests[0].body), {host: 'https://gateway.example.com'})
  assert.deepEqual(JSON.parse(requests[1].body), {loginSessionId: 'cls_1'})
})

test('supports cancel, refresh, and current without exposing credentials', async () => {
  const {client, requests} = recordingClient([
    jsonResponse({code: 0, data: {status: 'cancelled', loginSessionId: 'cls_1'}}),
    jsonResponse({code: 0, data: sessionData}),
    jsonResponse({code: 0, data: {...sessionData, accessToken: undefined}}),
  ])
  assert.equal((await client.cancel({host: 'https://gateway.example.com', loginSessionId: 'cls_1'})).status, 'cancelled')
  assert.deepEqual(await client.refresh({host: 'https://gateway.example.com', accessToken: 'secret-access-token'}), sessionData)
  const identity = await client.current({host: 'https://gateway.example.com', accessToken: 'secret-access-token'})
  assert.equal(identity.displayName, 'Alice')
  assert.equal(requests[1].headers.Authorization, 'Bearer secret-access-token')
  assert.equal(requests[2].method, 'GET')
  assert.equal(requests[2].headers.Authorization, 'Bearer secret-access-token')
})

test('accepts every documented poll terminal state and authorized sessions', async () => {
  for (const status of ['denied', 'cancelled', 'expired', 'failed', 'consumed']) {
    const {client} = recordingClient([jsonResponse({code: 0, data: {status, loginSessionId: 'cls_1', errorCode: 'SAFE', message: 'Safe failure'}})])
    assert.equal((await client.poll({host: 'https://gateway.example.com', loginSessionId: 'cls_1'})).status, status)
  }
  const {client} = recordingClient([jsonResponse({code: 0, data: {status: 'authorized', session: sessionData}})])
  assert.equal((await client.poll({host: 'https://gateway.example.com', loginSessionId: 'cls_1'})).session.userId, 'ou_1')
})

test('redacts HTTP, envelope, malformed JSON, and malformed DTO errors', async () => {
  const cases = [
    jsonResponse({code: 999, message: 'secret-access-token'}, 500),
    jsonResponse({code: 70001, message: 'secret-access-token'}),
    jsonResponse({code: 0}),
    jsonResponse({code: 0, data: {...startData, pollIntervalSeconds: '2'}}),
    new Response('secret-access-token', {status: 200}),
  ]
  for (const response of cases) {
    const {client} = recordingClient([response])
    await assert.rejects(
      client.start({host: 'https://gateway.example.com'}),
      (error) => error instanceof AuthHttpError && !error.message.includes('secret-access-token'),
    )
  }
})

test('preserves status for unauthorized and maps timeout without raw details', async () => {
  const unauthorized = recordingClient([jsonResponse({code: 70004, message: 'secret-access-token'}, 401)]).client
  await assert.rejects(
    unauthorized.current({host: 'https://gateway.example.com', accessToken: 'secret-access-token'}),
    (error) => error instanceof AuthHttpError && error.status === 401 && !error.message.includes('secret-access-token'),
  )
  const timeout = createAuthClient({
    fetchImpl: async () => { throw new DOMException('secret-access-token', 'TimeoutError') },
    timeoutMs: 1,
    version: '0.1.0',
  })
  await assert.rejects(
    timeout.start({host: 'https://gateway.example.com'}),
    (error) => error instanceof AuthHttpError && error.kind === 'timeout' && !error.message.includes('secret-access-token'),
  )
})
