import {createServer} from 'node:http'

const ACCESS_TOKEN = 'fake-access-token-do-not-print'

export async function startFakeGateway() {
  const requests = []
  let pollCount = 0
  let host

  const server = createServer(async (request, response) => {
    const url = new URL(request.url, host)
    const body = await readJsonBody(request)
    requests.push({method: request.method, path: url.pathname})

    if (request.headers['x-lark-hive-cli-contract-version'] !== '3'
      || request.headers['x-lark-hive-cli-version'] !== '0.1.0') {
      send(response, 400, {code: 400, data: null})
      return
    }

    if (request.method === 'POST' && url.pathname === '/api/cli/auth/start') {
      if (body?.host !== host) return send(response, 400, {code: 400, data: null})
      return send(response, 200, {code: 0, data: {
        loginSessionId: 'cls_fake_1',
        verificationUrl: `${host}/api/cli/auth/authorize?loginSessionId=cls_fake_1`,
        userCode: 'FAKE-CODE',
        pollIntervalSeconds: 1,
        expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      }})
    }

    if (request.method === 'POST' && url.pathname === '/api/cli/auth/poll') {
      if (body?.loginSessionId !== 'cls_fake_1') return send(response, 400, {code: 400, data: null})
      pollCount += 1
      if (pollCount === 1) return send(response, 200, {code: 0, data: {status: 'pending'}})
      return send(response, 200, {code: 0, data: {
        status: 'authorized',
        session: sessionData(),
      }})
    }

    if (request.method === 'GET' && url.pathname === '/api/cli/auth/current') {
      if (request.headers.authorization !== `Bearer ${ACCESS_TOKEN}`) {
        return send(response, 401, {code: 401, data: null})
      }
      const session = sessionData()
      return send(response, 200, {code: 0, data: {
        principalType: session.principalType,
        userId: session.userId,
        displayName: session.displayName,
        expiresAt: session.expiresAt,
        refreshable: session.refreshable,
        refreshableUntil: session.refreshableUntil,
      }})
    }

    if (request.method === 'POST' && url.pathname === '/api/cli/auth/refresh') {
      if (request.headers.authorization !== `Bearer ${ACCESS_TOKEN}`) {
        return send(response, 401, {code: 401, data: null})
      }
      return send(response, 200, {code: 0, data: sessionData()})
    }

    if (request.method === 'POST' && url.pathname === '/api/cli/auth/cancel') {
      return send(response, 200, {code: 0, data: {status: 'cancelled', loginSessionId: 'cls_fake_1'}})
    }

    send(response, 404, {code: 404, data: null})
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  host = `http://127.0.0.1:${address.port}`

  return {
    host,
    requests,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    }),
  }
}

function sessionData() {
  return {
    accessToken: ACCESS_TOKEN,
    principalType: 'USER',
    userId: 'ou_fake_alice',
    displayName: 'Alice',
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    refreshable: true,
    refreshableUntil: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
  }
}

async function readJsonBody(request) {
  if (request.method === 'GET' || request.method === 'HEAD') return undefined
  let raw = ''
  for await (const chunk of request) raw += chunk
  if (raw === '') return undefined
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function send(response, status, payload) {
  response.writeHead(status, {'Content-Type': 'application/json'})
  response.end(JSON.stringify(payload))
}
