import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {EventEmitter} from 'node:events'
import {mkdir, readFile, stat, symlink, mkdtemp, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'
import {fileURLToPath} from 'node:url'

import {createBackendClient} from '../src/backend.mjs'
import {ROOT_HELP, runCli} from '../src/cli.mjs'
import {
  createConfigStore,
  getPackageDefaultBackendUrl,
  loadConfig,
  resetPackageDefaultBackendUrlCacheForTests,
} from '../src/config.mjs'
import {openBrowser} from '../src/browser.mjs'
import {login, interpretPoll, waitForLogin} from '../src/login.mjs'
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

function createNeverClosingChildProcess() {
  const child = new EventEmitter()
  child.unref = () => {}
  return child
}

async function expectCliError(promise, expectedCode) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, expectedCode)
    return true
  })
}

// ---- config ----

test('config defaults to package.json config.default_host', () => {
  resetPackageDefaultBackendUrlCacheForTests()
  assert.deepEqual(loadConfig({}), {backendUrl: 'http://127.0.0.1:8787'})
})

test('config reads and normalizes the backend URL', () => {
  assert.deepEqual(
    loadConfig({DOUBAO_CLI_DEMO_BACKEND_URL: 'https://demo.example.com/'}),
    {backendUrl: 'https://demo.example.com'},
  )
})

test('package default host is read from the nearest package.json', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'doubao-cli-default-host-'))
  await mkdir(join(directory, 'dist', 'src'), {recursive: true})
  await writeFile(
    join(directory, 'package.json'),
    JSON.stringify({name: 'doubao-cli-demo', config: {default_host: 'https://cloud.example.com/base'}}, null, 2),
  )

  resetPackageDefaultBackendUrlCacheForTests()
  assert.equal(getPackageDefaultBackendUrl({startDir: join(directory, 'dist', 'src')}), 'https://cloud.example.com')
  resetPackageDefaultBackendUrlCacheForTests()
})

test('config rejects a non-http backend URL', () => {
  assert.throws(
    () => loadConfig({DOUBAO_CLI_DEMO_BACKEND_URL: 'ftp://demo.example.com'}),
    (error) => error.code === 'INVALID_CONFIGURATION',
  )
})

// ---- backend client ----

test('backend client start posts to /auth/start', async () => {
  const calls = []
  const fetchImpl = async (url, options) => {
    calls.push({url, options})
    return Response.json({
      loginSessionId: 'cls_1',
      verificationUrl: 'https://feishu/auth',
      pollIntervalSeconds: 2,
      expiresAt: '2026-10-08T01:05:00.000Z',
    })
  }
  const client = createBackendClient({backendUrl: 'http://127.0.0.1:8787', fetchImpl})
  const result = await client.start()
  assert.equal(calls[0].url, 'http://127.0.0.1:8787/auth/start')
  assert.equal(calls[0].options.method, 'POST')
  assert.equal(result.loginSessionId, 'cls_1')
  assert.equal(result.pollIntervalSeconds, 2)
})

test('backend client poll posts the login session id', async () => {
  const calls = []
  const fetchImpl = async (url, options) => {
    calls.push({url, options})
    return Response.json({status: 'pending'})
  }
  const client = createBackendClient({backendUrl: 'http://127.0.0.1:8787', fetchImpl})
  await client.poll('cls_9')
  assert.equal(calls[0].url, 'http://127.0.0.1:8787/auth/poll')
  assert.equal(calls[0].options.method, 'POST')
  assert.deepEqual(JSON.parse(calls[0].options.body), {loginSessionId: 'cls_9'})
})

test('backend client fetchMe returns null on 401', async () => {
  const fetchImpl = async () => new Response('{"error":"unauthorized"}', {status: 401})
  const client = createBackendClient({backendUrl: 'http://127.0.0.1:8787', fetchImpl})
  assert.equal(await client.fetchMe('token'), null)
})

test('backend client reports an unreachable backend', async () => {
  const fetchImpl = async () => { throw new Error('ECONNREFUSED') }
  const client = createBackendClient({backendUrl: 'http://127.0.0.1:8787', fetchImpl})
  await expectCliError(client.start(), 'BACKEND_UNREACHABLE')
})

// ---- poll interpretation ----

test('interpretPoll maps backend statuses to CLI outcomes', () => {
  assert.deepEqual(interpretPoll({status: 'pending'}), {status: 'pending'})
  assert.deepEqual(
    interpretPoll({status: 'authorized', sessionToken: 'sess', user: {name: 'A', openId: 'o', unionId: 'u'}}),
    {status: 'authorized', sessionToken: 'sess', user: {name: 'A', openId: 'o', unionId: 'u'}},
  )
  assert.throws(() => interpretPoll({status: 'denied'}), (error) => error.code === 'AUTHORIZATION_DENIED')
  assert.throws(() => interpretPoll({status: 'expired'}), (error) => error.code === 'AUTHORIZATION_TIMEOUT')
})

// ---- login orchestration ----

function scriptedBackend(pollScript) {
  let index = 0
  return {
    start: async () => ({
      loginSessionId: 'cls_9',
      verificationUrl: 'https://feishu/auth?state=x',
      pollIntervalSeconds: 1,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }),
    poll: async () => pollScript[Math.min(index++, pollScript.length - 1)],
    cancel: async () => ({status: 'cancelled'}),
    fetchMe: async () => ({name: 'A', openId: 'o', unionId: 'u'}),
  }
}

test('login starts, opens the browser, polls, and returns the session token', async () => {
  const events = []
  const backend = scriptedBackend([
    {status: 'pending'},
    {status: 'authorized', sessionToken: 'sess-abc', user: {name: 'A', openId: 'o', unionId: 'u'}},
  ])
  const result = await login({
    backend,
    spawnImpl: (command, args) => {
      events.push(`open:${args[0]}`)
      return createChildProcess()
    },
    platform: 'darwin',
    stderr: memoryStream(),
    sleep: async () => {},
  })
  assert.deepEqual(result, {sessionToken: 'sess-abc', user: {name: 'A', openId: 'o', unionId: 'u'}})
  assert.equal(events[0], 'open:https://feishu/auth?state=x')
})

test('login surfaces a denied authorization', async () => {
  const backend = scriptedBackend([{status: 'denied'}])
  await expectCliError(
    login({
      backend,
      spawnImpl: () => createChildProcess(),
      platform: 'darwin',
      stderr: memoryStream(),
      sleep: async () => {},
    }),
    'AUTHORIZATION_DENIED',
  )
})

test('waitForLogin cancels and aborts when the signal fires', async () => {
  const controller = new AbortController()
  controller.abort()
  let cancelled = false
  const backend = {
    poll: async () => ({status: 'pending'}),
    cancel: async () => { cancelled = true; return {status: 'cancelled'} },
  }
  await expectCliError(
    waitForLogin({
      backend,
      started: {loginSessionId: 'cls_9', pollIntervalSeconds: 1, expiresAt: new Date(Date.now() + 60_000).toISOString()},
      sleep: async () => {},
      signal: controller.signal,
    }),
    'AUTHORIZATION_CANCELLED',
  )
  assert.equal(cancelled, true)
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


test('browser launch waits for the opener process to close before resolving', async () => {
  const child = createNeverClosingChildProcess()
  let settled = false
  const pending = openBrowser('https://example.com/login', {
    platform: 'darwin',
    spawnImpl: () => child,
  }).then(() => { settled = true })

  await Promise.resolve()
  assert.equal(settled, false)

  child.emit('close', 0)
  await pending
  assert.equal(settled, true)
})


test('browser launch continues after a stuck opener timeout', async () => {
  const child = createNeverClosingChildProcess()
  let unrefCalled = false
  child.unref = () => { unrefCalled = true }

  await openBrowser('https://example.com/login', {
    platform: 'darwin',
    spawnImpl: () => child,
    timeoutMs: 1,
  })

  assert.equal(unrefCalled, true)
})

// ---- CLI lifecycle ----

function fakeBackend({
  user = {name: 'Alice', openId: 'ou_alice', unionId: 'on_alice'},
  pollScript,
} = {}) {
  let index = 0
  return {
    start: async () => ({
      loginSessionId: 'cls_test',
      verificationUrl: 'https://feishu/auth?state=x',
      pollIntervalSeconds: 1,
      expiresAt: new Date('2026-10-08T01:05:00.000Z').toISOString(),
    }),
    poll: async () => (pollScript
      ? pollScript[Math.min(index++, pollScript.length - 1)]
      : {status: 'authorized', sessionToken: 'sess-token', user}),
    cancel: async () => ({status: 'cancelled'}),
    fetchMe: async (token) => (token ? user : null),
  }
}

async function createCliHarness({backend = fakeBackend()} = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'doubao-cli-demo-'))
  const stdout = memoryStream()
  const stderr = memoryStream()
  return {
    directory,
    stdout,
    stderr,
    dependencies: {
      version: '0.1.1',
      stdout,
      stderr,
      environment: {DOUBAO_CLI_DEMO_BACKEND_URL: 'http://127.0.0.1:8787'},
      sessionStore: createSessionStore({directory}),
      configStore: createConfigStore({directory}),
      createBackend: () => backend,
      spawnImpl: () => createChildProcess(),
      platform: 'darwin',
      now: () => new Date('2026-10-08T01:00:00.000Z'),
    },
  }
}

test('installed bin symlink runs the CLI entrypoint', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'doubao-cli-bin-'))
  const executable = join(directory, 'doubao-cli-demo')
  await symlink(fileURLToPath(new URL('../src/cli.mjs', import.meta.url)), executable)
  const result = spawnSync(executable, ['--version'], {encoding: 'utf8'})
  assert.equal(result.status, 0)
  assert.equal(result.stdout, '0.1.1\n')
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

test('auth login --no-wait then auth poll completes the login', async () => {
  const backend = fakeBackend({pollScript: [
    {status: 'pending'},
    {status: 'authorized', sessionToken: 'sess-token', user: {name: 'Alice', openId: 'ou_alice', unionId: 'on_alice'}},
  ]})
  const harness = await createCliHarness({backend})

  assert.equal(await runCli(['auth', 'login', '--no-wait'], harness.dependencies), 0)
  assert.match(harness.stderr.text(), /cls_test/)

  // First poll is still pending -> exit 1, nothing persisted.
  const pendingOut = memoryStream()
  assert.equal(await runCli(['auth', 'poll', 'cls_test'], {...harness.dependencies, stdout: pendingOut}), 1)

  // Second poll authorizes -> logged in.
  const doneOut = memoryStream()
  assert.equal(await runCli(['auth', 'poll', 'cls_test'], {...harness.dependencies, stdout: doneOut}), 0)
  assert.equal(doneOut.text(), 'Logged in as Alice\n')
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

test('config host set/get/unset persists the default backend URL', async () => {
  const harness = await createCliHarness()

  assert.equal(await runCli(['config', 'host', 'set', 'https://demo.example.com/path'], harness.dependencies), 0)
  assert.equal(harness.stdout.text(), 'Configured backend URL: https://demo.example.com\n')

  const getOutput = memoryStream()
  assert.equal(await runCli(['config', 'host', 'get'], {...harness.dependencies, stdout: getOutput}), 0)
  assert.equal(getOutput.text(), 'https://demo.example.com\n')

  const unsetOutput = memoryStream()
  assert.equal(await runCli(['config', 'host', 'unset'], {...harness.dependencies, stdout: unsetOutput}), 0)
  assert.equal(unsetOutput.text(), 'Cleared backend URL\n')

  const afterUnset = memoryStream()
  assert.equal(await runCli(['config', 'host', 'get', '--json'], {...harness.dependencies, stdout: afterUnset}), 0)
  assert.deepEqual(JSON.parse(afterUnset.text()), {backendUrl: null})
})

test('persisted host is used before the environment backend URL', async () => {
  const seen = []
  const harness = await createCliHarness()
  const dependencies = {
    ...harness.dependencies,
    createBackend: (config) => {
      seen.push(config.backendUrl)
      return fakeBackend()
    },
  }

  assert.equal(await runCli(['config', 'host', 'set', 'https://persisted.example.com'], dependencies), 0)
  assert.equal(await runCli(['auth', 'login'], {...dependencies, stdout: memoryStream()}), 0)
  assert.deepEqual(seen, ['https://persisted.example.com'])
})

test('--host overrides the persisted and environment backend URLs', async () => {
  const seen = []
  const harness = await createCliHarness()
  const dependencies = {
    ...harness.dependencies,
    createBackend: (config) => {
      seen.push(config.backendUrl)
      return fakeBackend()
    },
  }

  assert.equal(await runCli(['config', 'host', 'set', 'https://persisted.example.com'], dependencies), 0)
  assert.equal(await runCli(['auth', 'login', '--host', 'https://flag.example.com/path'], {...dependencies, stdout: memoryStream()}), 0)
  assert.deepEqual(seen, ['https://flag.example.com'])
})

test('login persists the backend URL with the session and whoami reuses it', async () => {
  const seen = []
  const harness = await createCliHarness()
  const dependencies = {
    ...harness.dependencies,
    createBackend: (config) => {
      seen.push(config.backendUrl)
      return fakeBackend()
    },
  }

  assert.equal(await runCli(['auth', 'login', '--host', 'https://login.example.com'], dependencies), 0)
  const session = await dependencies.sessionStore.read()
  assert.equal(session.backendUrl, 'https://login.example.com')

  const output = memoryStream()
  assert.equal(await runCli(['whoami', '--json'], {...dependencies, stdout: output}), 0)
  assert.deepEqual(seen, ['https://login.example.com', 'https://login.example.com'])
})
