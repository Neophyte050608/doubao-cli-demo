import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {EventEmitter} from 'node:events'
import {readFile, stat, symlink, mkdtemp} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'
import {fileURLToPath} from 'node:url'

import {createBackendClient} from '../src/backend.mjs'
import {ROOT_HELP, runCli} from '../src/cli.mjs'
import {loadConfig} from '../src/config.mjs'
import {openBrowser} from '../src/browser.mjs'
import {login} from '../src/login.mjs'
import {createSessionStore} from '../src/session-store.mjs'

function memoryStream() {
  let value = ''
  return {
    write(chunk) { value += String(chunk) },
    text() { return value },
  }
}

function createChildProcess(exitCode = 0) {
  const child = new EventEmitter()
  child.unref = () => {}
  queueMicrotask(() => child.emit('close', exitCode))
  return child
}

async function expectCliError(promise, expectedCode) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, expectedCode)
    return true
  })
}

// ---- config ----

test('config defaults to the loopback backend URL', () => {
  assert.deepEqual(loadConfig({}), {backendUrl: 'http://127.0.0.1:8787'})
})

test('config reads and normalizes the backend URL', () => {
  assert.deepEqual(
    loadConfig({DOUBAO_LOGIN_DEMO_BACKEND_URL: 'https://demo.example.com/'}),
    {backendUrl: 'https://demo.example.com'},
  )
})

test('config rejects a non-http backend URL', () => {
  assert.throws(
    () => loadConfig({DOUBAO_LOGIN_DEMO_BACKEND_URL: 'ftp://demo.example.com'}),
    (error) => error.code === 'INVALID_CONFIGURATION',
  )
})

// ---- backend client ----

test('backend client startAuth posts to /auth/start', async () => {
  const calls = []
  const fetchImpl = async (url, options) => {
    calls.push({url, options})
    return Response.json({authorizationUrl: 'https://feishu/auth', deviceCode: 'dev-1', pollInterval: 2})
  }
  const client = createBackendClient({backendUrl: 'http://127.0.0.1:8787', fetchImpl})
  const result = await client.startAuth()
  assert.equal(calls[0].url, 'http://127.0.0.1:8787/auth/start')
  assert.equal(calls[0].options.method, 'POST')
  assert.deepEqual(result, {authorizationUrl: 'https://feishu/auth', deviceCode: 'dev-1', pollInterval: 2})
})

test('backend client fetchMe returns null on 401', async () => {
  const fetchImpl = async () => new Response('{"error":"unauthorized"}', {status: 401})
  const client = createBackendClient({backendUrl: 'http://127.0.0.1:8787', fetchImpl})
  assert.equal(await client.fetchMe('token'), null)
})

test('backend client reports an unreachable backend', async () => {
  const fetchImpl = async () => { throw new Error('ECONNREFUSED') }
  const client = createBackendClient({backendUrl: 'http://127.0.0.1:8787', fetchImpl})
  await expectCliError(client.startAuth(), 'BACKEND_UNREACHABLE')
})

// ---- login orchestration ----

test('login starts, opens the browser, polls, and returns the session token', async () => {
  const events = []
  let polls = 0
  const fetchImpl = async (url, options = {}) => {
    if (url.endsWith('/auth/start')) {
      events.push('start')
      return Response.json({authorizationUrl: 'https://feishu/auth?state=x', deviceCode: 'dev-9', pollInterval: 1})
    }
    if (url.includes('/auth/poll')) {
      polls += 1
      return Response.json(polls < 2 ? {status: 'pending'} : {status: 'complete', sessionToken: 'sess-abc'})
    }
    throw new Error(`unexpected url ${url}`)
  }
  const result = await login({
    environment: {},
    fetchImpl,
    spawnImpl: (command, args) => {
      events.push(`open:${args[0]}`)
      return createChildProcess()
    },
    platform: 'darwin',
    stderr: memoryStream(),
    sleep: async () => {},
  })
  assert.deepEqual(result, {sessionToken: 'sess-abc'})
  assert.equal(events[0], 'start')
  assert.equal(events[1], 'open:https://feishu/auth?state=x')
  assert.ok(polls >= 2)
})

test('login surfaces a denied authorization', async () => {
  const fetchImpl = async (url) => {
    if (url.endsWith('/auth/start')) {
      return Response.json({authorizationUrl: 'https://feishu/auth', deviceCode: 'dev-1', pollInterval: 1})
    }
    return Response.json({status: 'denied'})
  }
  await expectCliError(
    login({
      environment: {},
      fetchImpl,
      spawnImpl: () => createChildProcess(),
      platform: 'darwin',
      stderr: memoryStream(),
      sleep: async () => {},
    }),
    'AUTHORIZATION_DENIED',
  )
})

// ---- browser launcher ----

test('browser launch passes the URL as one argument with shell false', async () => {
  let invocation
  await openBrowser('https://example.com/login?a=1&b=2', {
    platform: 'darwin',
    spawnImpl(command, args, options) {
      invocation = {command, args, options}
      return createChildProcess()
    },
  })
  assert.deepEqual(invocation, {
    command: 'open',
    args: ['https://example.com/login?a=1&b=2'],
    options: {shell: false, stdio: 'ignore'},
  })
})

test('browser launch rejects when the platform command exits unsuccessfully', async () => {
  await expectCliError(
    openBrowser('https://example.com/login', {
      platform: 'linux',
      spawnImpl: () => createChildProcess(1),
    }),
    'BROWSER_OPEN_FAILED',
  )
})

// ---- CLI lifecycle ----

function fakeBackend(user = {name: 'Alice', openId: 'ou_alice', unionId: 'on_alice'}) {
  return {
    fetchMe: async (token) => (token ? user : null),
  }
}

async function createCliHarness({
  login: loginImpl = async () => ({sessionToken: 'sess-token'}),
  backendUser,
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'doubao-login-demo-'))
  const stdout = memoryStream()
  const stderr = memoryStream()
  return {
    directory,
    stdout,
    stderr,
    dependencies: {
      version: '0.1.0',
      stdout,
      stderr,
      environment: {DOUBAO_LOGIN_DEMO_BACKEND_URL: 'http://127.0.0.1:8787'},
      sessionStore: createSessionStore({directory}),
      login: loginImpl,
      createBackend: () => fakeBackend(backendUser),
      now: () => new Date('2026-10-08T01:00:00.000Z'),
    },
  }
}

test('installed bin symlink runs the CLI entrypoint', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'doubao-login-bin-'))
  const executable = join(directory, 'doubao-login-demo')
  await symlink(fileURLToPath(new URL('../src/cli.mjs', import.meta.url)), executable)
  const result = spawnSync(executable, ['--version'], {encoding: 'utf8'})
  assert.equal(result.status, 0)
  assert.equal(result.stdout, '0.1.0\n')
})

test('help lists the connector commands', async () => {
  const harness = await createCliHarness()
  assert.equal(await runCli(['--help'], harness.dependencies), 0)
  assert.match(harness.stdout.text(), /auth login/)
  assert.match(harness.stdout.text(), /whoami/)
  assert.equal(harness.stdout.text(), ROOT_HELP)
})

test('status reports not logged in before login', async () => {
  const harness = await createCliHarness()
  assert.equal(await runCli(['auth', 'status'], harness.dependencies), 1)
  assert.equal(harness.stdout.text(), 'Not logged in\n')
})

test('login, status, whoami and logout form a complete lifecycle', async () => {
  const harness = await createCliHarness()

  assert.equal(await runCli(['auth', 'login'], harness.dependencies), 0)
  assert.equal(harness.stdout.text(), 'Logged in as Alice\n')

  const statusOutput = memoryStream()
  assert.equal(await runCli(['auth', 'status'], {...harness.dependencies, stdout: statusOutput}), 0)
  assert.equal(statusOutput.text(), 'Logged in\nName: Alice\nOpen ID: ou_alice\nUnion ID: on_alice\n')

  const whoamiOutput = memoryStream()
  assert.equal(await runCli(['whoami', '--json'], {...harness.dependencies, stdout: whoamiOutput}), 0)
  assert.deepEqual(JSON.parse(whoamiOutput.text()), {name: 'Alice', openId: 'ou_alice', unionId: 'on_alice'})

  // Session token is persisted but never stored in plaintext.
  const encrypted = await readFile(join(harness.directory, 'session.json.enc'), 'utf8')
  assert.doesNotMatch(encrypted, /Alice|ou_alice|on_alice|sess-token/)
  assert.equal((await stat(join(harness.directory, 'session.json.enc'))).mode & 0o777, 0o600)

  const logoutOutput = memoryStream()
  assert.equal(await runCli(['auth', 'logout'], {...harness.dependencies, stdout: logoutOutput}), 0)
  assert.equal(logoutOutput.text(), 'Logged out\n')

  const afterLogout = memoryStream()
  assert.equal(await runCli(['auth', 'status', '--json'], {...harness.dependencies, stdout: afterLogout}), 1)
  assert.deepEqual(JSON.parse(afterLogout.text()), {loggedIn: false})
})

test('whoami clears the session when the backend rejects the token', async () => {
  const harness = await createCliHarness()
  await runCli(['auth', 'login'], harness.dependencies)

  const rejecting = {
    ...harness.dependencies,
    createBackend: () => ({fetchMe: async () => null}),
    stdout: memoryStream(),
  }
  assert.equal(await runCli(['whoami'], rejecting), 1)
  assert.equal(rejecting.stdout.text(), 'Not logged in\n')

  // Session was cleared, so a follow-up status is also logged out.
  const after = memoryStream()
  assert.equal(await runCli(['auth', 'status'], {...harness.dependencies, stdout: after}), 1)
})

test('status JSON is stable for connector detection', async () => {
  const harness = await createCliHarness()
  await runCli(['auth', 'login'], harness.dependencies)
  const output = memoryStream()
  assert.equal(await runCli(['auth', 'status', '--json'], {...harness.dependencies, stdout: output}), 0)
  assert.deepEqual(JSON.parse(output.text()), {
    loggedIn: true,
    user: {name: 'Alice', openId: 'ou_alice', unionId: 'on_alice'},
    authenticatedAt: '2026-10-08T01:00:00.000Z',
  })
})
