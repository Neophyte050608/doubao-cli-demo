import assert from 'node:assert/strict'
import test from 'node:test'

import {AuthHttpError} from '../src/auth-client.mjs'
import {CliError, EXIT_CODES} from '../src/errors.mjs'
import {SessionStoreCorruptedError} from '../src/session-store.mjs'
import {invoke} from './support/run-cli.mjs'

const identity = {
  loggedIn: true,
  host: 'https://gateway.example.com',
  user: {displayName: 'Alice', userId: 'ou_1'},
  expiresAt: '2026-09-30T13:00:00Z',
  refreshable: true,
  refreshableUntil: '2026-10-30T12:00:00Z',
}

function dependencies(overrides = {}) {
  return {
    authSession: {
      getIdentity: async () => identity,
      logout: async () => {},
      ...overrides.authSession,
    },
    login: overrides.login ?? (async ({host, onPending}) => {
      await onPending({
        verificationUrl: `${host}/api/cli/auth/authorize?loginSessionId=cls_1`,
        userCode: 'ABCD-EFGH', loginSessionId: 'cls_1', expiresAt: '2026-09-30T12:04:30Z', pollIntervalSeconds: 2,
      })
      return {displayName: 'Alice', userId: 'ou_1', host}
    }),
  }
}

test('prints a stable version', async () => {
  const result = await invoke(['--version'])
  assert.equal(result.code, 0)
  assert.match(result.stdout, /^0\.1\.0\n$/)
  assert.equal(result.stderr, '')
})

test('prints offline help without secrets', async () => {
  const result = await invoke(['--help'])
  assert.equal(result.code, 0)
  assert.match(result.stdout, /auth login/)
  assert.match(result.stdout, /auth status/)
  assert.match(result.stdout, /auth logout/)
  assert.match(result.stdout, /whoami/)
  assert.doesNotMatch(result.stdout, /App Secret|access token|FEISHU_APP_SECRET/i)
})

test('rejects unknown commands, missing commands, and unknown flags', async () => {
  for (const argv of [['unknown'], [], ['auth', 'status', '--wat'], ['whoami', '--host', 'https://gateway.example.com']]) {
    const result = await invoke(argv, dependencies())
    assert.equal(result.code, 2)
    assert.match(result.stderr, /Unknown|Usage|option/)
  }
})

test('runs blocking login and prints pending details before success', async () => {
  const result = await invoke(['auth', 'login', '--host', 'https://gateway.example.com/'], dependencies())
  assert.equal(result.code, 0)
  assert.match(result.stdout, /^Authorization pending\nOpen: https:\/\/gateway\.example\.com\/api\/cli\/auth\/authorize/)
  assert.match(result.stdout, /Code: ABCD-EFGH/)
  assert.match(result.stdout, /Logged in as Alice\n$/)
  assert.equal(result.stderr, '')
})

test('requires a safe host for login', async () => {
  for (const argv of [['auth', 'login'], ['auth', 'login', '--host', 'http://gateway.example.com']]) {
    const result = await invoke(argv, dependencies())
    assert.equal(result.code, 2)
    assert.match(result.stderr, /host|HTTPS/i)
  }
})

test('maps login auth and operational failures without leaking details', async () => {
  const auth = await invoke(['auth', 'login', '--host', 'https://gateway.example.com'], dependencies({
    login: async () => { throw new CliError('LOGIN_DENIED', 'Login denied', EXIT_CODES.AUTH) },
  }))
  assert.equal(auth.code, 3)
  assert.match(auth.stderr, /Login denied/)

  const operational = await invoke(['auth', 'login', '--host', 'https://gateway.example.com'], dependencies({
    login: async () => { throw new AuthHttpError('server', 'Gateway request failed', {status: 500, cause: new Error('secret-access-token')}) },
  }))
  assert.equal(operational.code, 2)
  assert.match(operational.stderr, /Gateway request failed/)
  assert.doesNotMatch(operational.stderr, /secret-access-token/)
})

test('prints status with an exact first line and stable JSON', async () => {
  const text = await invoke(['auth', 'status'], dependencies())
  assert.equal(text.code, 0)
  assert.equal(text.stdout.split('\n')[0], 'Logged in')
  assert.match(text.stdout, /Name: Alice/)
  assert.match(text.stdout, /User ID: ou_1/)
  assert.match(text.stdout, /Host: https:\/\/gateway\.example\.com/)

  const json = await invoke(['auth', 'status', '--json'], dependencies())
  assert.equal(json.code, 0)
  assert.deepEqual(JSON.parse(json.stdout), {loggedIn: true, user: identity.user, host: identity.host})
})

test('reports logged out status with exit 1', async () => {
  const deps = dependencies({authSession: {getIdentity: async () => ({loggedIn: false})}})
  const text = await invoke(['auth', 'status'], deps)
  assert.equal(text.code, 1)
  assert.equal(text.stdout, 'Not logged in\n')
  const json = await invoke(['auth', 'status', '--json'], deps)
  assert.equal(json.code, 1)
  assert.equal(json.stdout, '{"loggedIn":false}\n')
})

test('does not misreport storage or network failures as logged out', async () => {
  for (const error of [new SessionStoreCorruptedError(), new AuthHttpError('network', 'Gateway request failed')]) {
    const result = await invoke(['auth', 'status'], dependencies({authSession: {getIdentity: async () => { throw error }}}))
    assert.equal(result.code, 2)
    assert.equal(result.stdout, '')
    assert.doesNotMatch(result.stderr, /Not logged in/)
  }
})

test('shows whoami as text or JSON and returns exit 1 when logged out', async () => {
  const text = await invoke(['whoami'], dependencies())
  assert.equal(text.code, 0)
  assert.match(text.stdout, /^Name: Alice\nUser ID: ou_1\nHost:/)
  const json = await invoke(['whoami', '--json'], dependencies())
  assert.deepEqual(JSON.parse(json.stdout), {displayName: 'Alice', userId: 'ou_1', host: identity.host})
  const loggedOut = await invoke(['whoami'], dependencies({authSession: {getIdentity: async () => ({loggedIn: false})}}))
  assert.equal(loggedOut.code, 1)
  assert.equal(loggedOut.stdout, 'Not logged in\n')
})

test('logs out idempotently in text and JSON modes', async () => {
  let clears = 0
  const deps = dependencies({authSession: {logout: async () => { clears += 1 }}})
  const text = await invoke(['auth', 'logout'], deps)
  assert.equal(text.code, 0)
  assert.equal(text.stdout, 'Logged out\n')
  const json = await invoke(['auth', 'logout', '--json'], deps)
  assert.deepEqual(JSON.parse(json.stdout), {loggedOut: true})
  assert.equal(clears, 2)
})

test('never renders access tokens or authorization headers', async () => {
  const deps = dependencies({authSession: {getIdentity: async () => ({...identity, accessToken: 'secret-access-token'})}})
  for (const argv of [['auth', 'status'], ['auth', 'status', '--json'], ['whoami'], ['whoami', '--json']]) {
    const result = await invoke(argv, deps)
    assert.doesNotMatch(result.stdout + result.stderr, /secret-access-token|Authorization: Bearer/)
  }
})
