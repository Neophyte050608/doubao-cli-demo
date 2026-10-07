import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {EventEmitter} from 'node:events'
import {test} from 'node:test'

import {
  AUTHORIZATION_ENDPOINT,
  CONTACT_USER_ENDPOINT,
  TENANT_ACCESS_TOKEN_ENDPOINT,
  TOKEN_ENDPOINT,
  USER_INFO_ENDPOINT,
  buildAuthorizationUrl,
  createOAuthCallbackServer,
  exchangeCodeForUser,
  loadConfig,
  openBrowser,
} from '../src/cli.mjs'

const validConfig = {
  appId: 'cli_demo',
  appSecret: 'app-secret-value',
  redirectUri: 'http://127.0.0.1:8787/callback',
}

function createChildProcess(exitCode = 0) {
  const child = new EventEmitter()
  child.unrefCalled = false
  child.unref = () => {
    child.unrefCalled = true
  }
  queueMicrotask(() => child.emit('close', exitCode))
  return child
}

async function expectCliError(promise, expectedCode) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, expectedCode)
    return true
  })
}

test('authorization URL uses the official endpoint and required parameters', () => {
  const url = new URL(
    buildAuthorizationUrl({
      appId: 'cli_demo',
      redirectUri: 'http://127.0.0.1:8787/callback',
      state: 'unpredictable-state',
    }),
  )

  assert.equal(url.origin + url.pathname, AUTHORIZATION_ENDPOINT)
  assert.deepEqual([...url.searchParams.keys()].sort(), [
    'client_id',
    'redirect_uri',
    'response_type',
    'state',
  ])
  assert.equal(url.searchParams.get('client_id'), 'cli_demo')
  assert.equal(url.searchParams.get('response_type'), 'code')
  assert.equal(
    url.searchParams.get('redirect_uri'),
    'http://127.0.0.1:8787/callback',
  )
  assert.equal(url.searchParams.get('state'), 'unpredictable-state')
  assert.equal(url.searchParams.has('scope'), false)
})

test('token exchange uses OAuth v3 and form-urlencoded', async () => {
  const requests = []
  const fetchImpl = async (url, options = {}) => {
    requests.push({url, options})
    if (url === TOKEN_ENDPOINT) {
      return Response.json({
        access_token: 'user-access-token',
        expires_in: 7200,
        token_type: 'Bearer',
      })
    }
    if (url === USER_INFO_ENDPOINT) {
      return Response.json({
        code: 0,
        data: {name: '示例用户', open_id: 'ou_demo', union_id: 'on_ignored'},
      })
    }
    if (url === TENANT_ACCESS_TOKEN_ENDPOINT) {
      return Response.json({code: 0, tenant_access_token: 'tenant-access-token'})
    }
    return Response.json({
      code: 0,
      data: {user: {open_id: 'ou_demo', user_id: 'employee-001'}},
    })
  }

  await exchangeCodeForUser(validConfig, 'one-time-code', fetchImpl)

  assert.equal(requests[0].url, TOKEN_ENDPOINT)
  assert.equal(requests[0].options.method, 'POST')
  assert.equal(
    requests[0].options.headers['Content-Type'],
    'application/x-www-form-urlencoded',
  )
  const form = new URLSearchParams(requests[0].options.body)
  assert.deepEqual(Object.fromEntries(form), {
    grant_type: 'authorization_code',
    client_id: 'cli_demo',
    client_secret: 'app-secret-value',
    code: 'one-time-code',
    redirect_uri: 'http://127.0.0.1:8787/callback',
  })
  assert.equal(form.has('scope'), false)
})

test('login resolves the OAuth user to an enterprise employee identity', async () => {
  const requests = []
  const fetchImpl = async (url, options = {}) => {
    requests.push({url, options})
    if (url === TOKEN_ENDPOINT) {
      return Response.json({access_token: 'user-access-token'})
    }
    if (url === USER_INFO_ENDPOINT) {
      return Response.json({
        code: 0,
        data: {
          avatar_url: 'https://example.invalid/avatar.png',
          name: '示例用户',
          open_id: 'ou_demo',
          tenant_key: 'tenant-ignored',
        },
      })
    }
    if (url === TENANT_ACCESS_TOKEN_ENDPOINT) {
      return Response.json({code: 0, tenant_access_token: 'tenant-access-token'})
    }
    return Response.json({
      code: 0,
      data: {user: {open_id: 'ou_demo', user_id: 'employee-001', name: '示例用户'}},
    })
  }

  const user = await exchangeCodeForUser(
    validConfig,
    'one-time-code',
    fetchImpl,
  )

  assert.equal(requests[1].url, USER_INFO_ENDPOINT)
  assert.equal(requests[1].options.method, 'GET')
  assert.equal(requests[1].options.headers.Authorization, 'Bearer user-access-token')

  assert.equal(requests[2].url, TENANT_ACCESS_TOKEN_ENDPOINT)
  assert.equal(requests[2].options.method, 'POST')
  assert.equal(requests[2].options.headers['Content-Type'], 'application/json')
  assert.deepEqual(JSON.parse(requests[2].options.body), {
    app_id: 'cli_demo',
    app_secret: 'app-secret-value',
  })

  assert.equal(
    requests[3].url,
    `${CONTACT_USER_ENDPOINT}/ou_demo?user_id_type=open_id&department_id_type=open_department_id`,
  )
  assert.equal(requests[3].options.method, 'GET')
  assert.equal(requests[3].options.headers.Authorization, 'Bearer tenant-access-token')
  assert.deepEqual(user, {
    name: '示例用户',
    openId: 'ou_demo',
    employeeId: 'employee-001',
  })
  assert.doesNotMatch(JSON.stringify(user), /user-access-token|tenant-access-token/)
})

test('callback rejects a mismatched state and closes the server', async () => {
  const callback = await createOAuthCallbackServer({
    redirectUri: 'http://127.0.0.1:0/callback',
    state: 'expected-state',
    timeoutMs: 1_000,
  })
  const rejected = expectCliError(callback.waitForCode, 'STATE_MISMATCH')
  const response = await fetch(
    `http://127.0.0.1:${callback.port}/callback?state=wrong-state&code=private-code`,
  )

  assert.equal(response.status, 400)
  assert.doesNotMatch(await response.text(), /private-code|wrong-state/)
  await rejected
  await callback.waitForClose
})

test('callback handles access_denied as a controlled failure', async () => {
  const callback = await createOAuthCallbackServer({
    redirectUri: 'http://127.0.0.1:0/callback',
    state: 'expected-state',
    timeoutMs: 1_000,
  })
  const rejected = expectCliError(
    callback.waitForCode,
    'AUTHORIZATION_DENIED',
  )
  const response = await fetch(
    `http://127.0.0.1:${callback.port}/callback?state=expected-state&error=access_denied&error_description=private-description`,
  )

  assert.equal(response.status, 403)
  assert.doesNotMatch(await response.text(), /private-description|access_denied/)
  await rejected
  await callback.waitForClose
})

test('callback consumes one OAuth code and stops accepting callbacks', async () => {
  const callback = await createOAuthCallbackServer({
    redirectUri: 'http://127.0.0.1:0/callback',
    state: 'expected-state',
    timeoutMs: 1_000,
  })

  const response = await fetch(
    `http://127.0.0.1:${callback.port}/callback?state=expected-state&code=first-code`,
  )
  assert.equal(response.status, 200)
  assert.equal(await callback.waitForCode, 'first-code')
  await callback.waitForClose

  await assert.rejects(
    fetch(
      `http://127.0.0.1:${callback.port}/callback?state=expected-state&code=second-code`,
    ),
  )
})

test('redirect URI rejects credentials, query, and fragment', async (t) => {
  const invalidUris = [
    'http://user:password@127.0.0.1:8787/callback',
    'http://127.0.0.1:8787/callback?source=cli',
    'http://127.0.0.1:8787/callback#fragment',
  ]

  for (const redirectUri of invalidUris) {
    await t.test(redirectUri, () => {
      assert.throws(
        () =>
          loadConfig({
            FEISHU_APP_ID: 'cli_demo',
            FEISHU_APP_SECRET: 'app-secret-value',
            FEISHU_REDIRECT_URI: redirectUri,
          }),
        (error) => error.code === 'INVALID_REDIRECT_URI',
      )
    })
  }
})

test('redirect URI only accepts an explicit loopback HTTP address and port', () => {
  for (const redirectUri of [
    'https://127.0.0.1:8787/callback',
    'http://localhost:8787/callback',
    'http://0.0.0.0:8787/callback',
    'http://127.0.0.1/callback',
  ]) {
    assert.throws(
      () =>
        loadConfig({
          FEISHU_APP_ID: 'cli_demo',
          FEISHU_APP_SECRET: 'app-secret-value',
          FEISHU_REDIRECT_URI: redirectUri,
        }),
      (error) => error.code === 'INVALID_REDIRECT_URI',
    )
  }
})

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

test('Windows browser launch uses explorer.exe', async () => {
  let commandUsed
  await openBrowser('https://example.com/login', {
    platform: 'win32',
    spawnImpl(command) {
      commandUsed = command
      return createChildProcess()
    },
  })

  assert.equal(commandUsed, 'explorer.exe')
})


test('browser launch rejects when the platform command exits unsuccessfully', async () => {
  await expectCliError(
    openBrowser('https://example.com/login', {
      platform: 'linux',
      spawnImpl() {
        return createChildProcess(1)
      },
    }),
    'BROWSER_OPEN_FAILED',
  )
})

test('Feishu failures expose only stable messages and never secrets', async (t) => {
  const sensitiveValues = [
    validConfig.appSecret,
    'one-time-sensitive-code',
    'upstream-sensitive-token',
  ]

  await t.test('token endpoint failure', async () => {
    const fetchImpl = async () =>
      Response.json(
        {
          error: 'invalid_grant',
          error_description: sensitiveValues.join(' '),
        },
        {status: 400},
      )

    await assert.rejects(
      exchangeCodeForUser(validConfig, sensitiveValues[1], fetchImpl),
      (error) => {
        const rendered = `${error.code} ${error.message} ${error.stack}`
        assert.equal(error.code, 'TOKEN_EXCHANGE_FAILED')
        for (const value of sensitiveValues) {
          assert.equal(rendered.includes(value), false)
        }
        return true
      },
    )
  })

  await t.test('user info endpoint failure', async () => {
    let requestCount = 0
    const fetchImpl = async () => {
      requestCount += 1
      if (requestCount === 1) {
        return Response.json({access_token: sensitiveValues[2]})
      }
      return Response.json(
        {code: 999, msg: sensitiveValues.join(' ')},
        {status: 403},
      )
    }

    await assert.rejects(
      exchangeCodeForUser(validConfig, sensitiveValues[1], fetchImpl),
      (error) => {
        const rendered = `${error.code} ${error.message} ${error.stack}`
        assert.equal(error.code, 'USER_INFO_FAILED')
        for (const value of sensitiveValues) {
          assert.equal(rendered.includes(value), false)
        }
        return true
      },
    )
  })


  await t.test('tenant token endpoint failure', async () => {
    let requestCount = 0
    const fetchImpl = async () => {
      requestCount += 1
      if (requestCount === 1) return Response.json({access_token: sensitiveValues[2]})
      if (requestCount === 2) {
        return Response.json({code: 0, data: {name: 'Alice', open_id: 'ou_alice'}})
      }
      return Response.json(
        {code: 999, msg: sensitiveValues.join(' ')},
        {status: 403},
      )
    }

    await assert.rejects(
      exchangeCodeForUser(validConfig, sensitiveValues[1], fetchImpl),
      (error) => {
        const rendered = `${error.code} ${error.message} ${error.stack}`
        assert.equal(error.code, 'ENTERPRISE_IDENTITY_FAILED')
        for (const value of sensitiveValues) assert.equal(rendered.includes(value), false)
        return true
      },
    )
  })

  await t.test('contact user endpoint failure', async () => {
    let requestCount = 0
    const fetchImpl = async () => {
      requestCount += 1
      if (requestCount === 1) return Response.json({access_token: sensitiveValues[2]})
      if (requestCount === 2) {
        return Response.json({code: 0, data: {name: 'Alice', open_id: 'ou_alice'}})
      }
      if (requestCount === 3) {
        return Response.json({code: 0, tenant_access_token: sensitiveValues[2]})
      }
      return Response.json(
        {code: 999, msg: sensitiveValues.join(' ')},
        {status: 403},
      )
    }

    await assert.rejects(
      exchangeCodeForUser(validConfig, sensitiveValues[1], fetchImpl),
      (error) => {
        const rendered = `${error.code} ${error.message} ${error.stack}`
        assert.equal(error.code, 'ENTERPRISE_IDENTITY_FAILED')
        for (const value of sensitiveValues) assert.equal(rendered.includes(value), false)
        return true
      },
    )
  })
})

import {readFile, stat, symlink} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {mkdtemp} from 'node:fs/promises'

import {
  ROOT_HELP,
  createSessionStore,
  runCli,
} from '../src/cli.mjs'

function memoryStream() {
  let value = ''
  return {
    write(chunk) { value += String(chunk) },
    text() { return value },
  }
}

async function createCliHarness({login = async () => ({name: 'Alice', openId: 'ou_alice', employeeId: 'employee-alice'})} = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'doubao-login-demo-'))
  const stdout = memoryStream()
  const stderr = memoryStream()
  return {
    directory,
    stdout,
    stderr,
    sessionStore: createSessionStore({directory}),
    dependencies: {
      version: '0.1.0',
      stdout,
      stderr,
      sessionStore: createSessionStore({directory}),
      login,
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

test('complete CLI exposes help and version for connector discovery', async () => {
  const harness = await createCliHarness()

  assert.equal(await runCli(['--help'], harness.dependencies), 0)
  assert.equal(harness.stdout.text(), ROOT_HELP)
  assert.match(harness.stdout.text(), /auth login/)
  assert.match(harness.stdout.text(), /auth status/)
  assert.match(harness.stdout.text(), /auth logout/)
  assert.match(harness.stdout.text(), /whoami/)

  const versionOutput = memoryStream()
  assert.equal(await runCli(['--version'], {...harness.dependencies, stdout: versionOutput}), 0)
  assert.equal(versionOutput.text(), '0.1.0\n')
})

test('status reports not logged in before OAuth login', async () => {
  const harness = await createCliHarness()

  assert.equal(await runCli(['auth', 'status'], harness.dependencies), 1)
  assert.equal(harness.stdout.text(), 'Not logged in\n')
})

test('login, status, whoami and logout form a complete connector lifecycle', async () => {
  const harness = await createCliHarness()

  assert.equal(await runCli(['auth', 'login'], harness.dependencies), 0)
  assert.equal(harness.stdout.text(), 'Logged in as Alice\n')

  const statusOutput = memoryStream()
  assert.equal(await runCli(['auth', 'status'], {...harness.dependencies, stdout: statusOutput}), 0)
  assert.equal(statusOutput.text(), 'Logged in\nName: Alice\nOpen ID: ou_alice\nEmployee ID: employee-alice\n')

  const whoamiOutput = memoryStream()
  assert.equal(await runCli(['whoami', '--json'], {...harness.dependencies, stdout: whoamiOutput}), 0)
  assert.deepEqual(JSON.parse(whoamiOutput.text()), {name: 'Alice', openId: 'ou_alice', employeeId: 'employee-alice'})

  const encrypted = await readFile(join(harness.directory, 'session.json.enc'), 'utf8')
  assert.doesNotMatch(encrypted, /Alice|ou_alice|employee-alice/)
  assert.equal((await stat(join(harness.directory, 'session.json.enc'))).mode & 0o777, 0o600)
  assert.equal((await stat(join(harness.directory, 'session.key'))).mode & 0o777, 0o600)

  const logoutOutput = memoryStream()
  assert.equal(await runCli(['auth', 'logout'], {...harness.dependencies, stdout: logoutOutput}), 0)
  assert.equal(logoutOutput.text(), 'Logged out\n')

  const afterLogout = memoryStream()
  assert.equal(await runCli(['auth', 'status', '--json'], {...harness.dependencies, stdout: afterLogout}), 1)
  assert.deepEqual(JSON.parse(afterLogout.text()), {loggedIn: false})
})

test('status JSON is stable for enterprise connector detection', async () => {
  const harness = await createCliHarness()
  await runCli(['auth', 'login'], harness.dependencies)
  const output = memoryStream()

  assert.equal(await runCli(['auth', 'status', '--json'], {...harness.dependencies, stdout: output}), 0)
  assert.deepEqual(JSON.parse(output.text()), {
    loggedIn: true,
    user: {name: 'Alice', openId: 'ou_alice', employeeId: 'employee-alice'},
    authenticatedAt: '2026-10-08T01:00:00.000Z',
  })
})
