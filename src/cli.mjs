#!/usr/bin/env node

import {spawn} from 'node:child_process'
import {createCipheriv, createDecipheriv, randomBytes} from 'node:crypto'
import {chmod, mkdir, readFile, realpath, rename, rm, stat, writeFile} from 'node:fs/promises'
import {createServer} from 'node:http'
import {homedir} from 'node:os'
import {join} from 'node:path'
import process from 'node:process'
import {fileURLToPath} from 'node:url'

export const AUTHORIZATION_ENDPOINT =
  'https://accounts.feishu.cn/open-apis/authen/v1/authorize'
export const TOKEN_ENDPOINT = 'https://accounts.feishu.cn/oauth/v3/token'
export const USER_INFO_ENDPOINT =
  'https://open.feishu.cn/open-apis/authen/v1/user_info'
export const TENANT_ACCESS_TOKEN_ENDPOINT =
  'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal'
export const CONTACT_USER_ENDPOINT =
  'https://open.feishu.cn/open-apis/contact/v3/users'

const DEFAULT_REDIRECT_URI = 'http://127.0.0.1:8787/callback'
const AUTHORIZATION_TIMEOUT_MS = 5 * 60 * 1000

export class CliError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'CliError'
    this.code = code
  }
}

function requiredEnvironmentValue(environment, name) {
  const value = environment[name]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new CliError('INVALID_CONFIGURATION', `Missing environment variable: ${name}`)
  }
  return value
}

export function validateRedirectUri(value) {
  let redirectUri
  try {
    redirectUri = new URL(value)
  } catch {
    throw new CliError(
      'INVALID_REDIRECT_URI',
      'FEISHU_REDIRECT_URI must be a valid loopback URL.',
    )
  }

  const isIpv4Loopback = redirectUri.hostname === '127.0.0.1'
  const isIpv6Loopback = redirectUri.hostname === '[::1]'
  const isValid =
    redirectUri.protocol === 'http:' &&
    (isIpv4Loopback || isIpv6Loopback) &&
    redirectUri.port !== '' &&
    redirectUri.username === '' &&
    redirectUri.password === '' &&
    redirectUri.search === '' &&
    redirectUri.hash === ''

  if (!isValid) {
    throw new CliError(
      'INVALID_REDIRECT_URI',
      'FEISHU_REDIRECT_URI must use HTTP, an explicit loopback address and port, and contain no credentials, query, or fragment.',
    )
  }

  return redirectUri
}

export function loadConfig(environment = process.env) {
  const appId = requiredEnvironmentValue(environment, 'FEISHU_APP_ID')
  const appSecret = requiredEnvironmentValue(environment, 'FEISHU_APP_SECRET')
  const redirectUri =
    environment.FEISHU_REDIRECT_URI?.trim() || DEFAULT_REDIRECT_URI
  validateRedirectUri(redirectUri)

  return {appId, appSecret, redirectUri}
}

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

export class SessionStoreCorruptedError extends Error {
  constructor(message = 'Local session storage is corrupted; run `auth logout` and login again.') {
    super(message)
    this.name = 'SessionStoreCorruptedError'
  }
}

export function getDataDirectory({
  environment = process.env,
  platform = process.platform,
  homeDirectory = homedir(),
} = {}) {
  if (environment.DOUBAO_LOGIN_DEMO_HOME?.trim()) {
    return environment.DOUBAO_LOGIN_DEMO_HOME.trim()
  }
  if (platform === 'win32') {
    return join(environment.APPDATA || homeDirectory, 'doubao-login-demo')
  }
  return join(environment.XDG_CONFIG_HOME || join(homeDirectory, '.config'), 'doubao-login-demo')
}

export function createSessionStore({directory, replaceFile = rename}) {
  const sessionPath = join(directory, 'session.json.enc')
  const keyPath = join(directory, 'session.key')

  return {
    paths: {sessionPath, keyPath},
    async read() {
      const [hasSession, hasKey] = await Promise.all([exists(sessionPath), exists(keyPath)])
      if (!hasSession && !hasKey) return null
      if (!hasSession || !hasKey) throw new SessionStoreCorruptedError()
      try {
        const [serialized, encodedKey] = await Promise.all([
          readFile(sessionPath, 'utf8'),
          readFile(keyPath, 'utf8'),
        ])
        const payload = JSON.parse(serialized)
        if (!isEncryptedPayload(payload)) throw new Error('invalid payload')
        const key = decodeBase64(encodedKey.trim(), 32)
        const decipher = createDecipheriv('aes-256-gcm', key, decodeBase64(payload.iv, 12))
        decipher.setAuthTag(decodeBase64(payload.tag, 16))
        const plaintext = Buffer.concat([
          decipher.update(decodeBase64(payload.ciphertext)),
          decipher.final(),
        ]).toString('utf8')
        const session = JSON.parse(plaintext)
        if (!isStoredSession(session)) throw new Error('invalid session')
        return session
      } catch (error) {
        if (error instanceof SessionStoreCorruptedError) throw error
        throw new SessionStoreCorruptedError()
      }
    },
    async write(session) {
      if (!isStoredSession(session)) {
        throw new SessionStoreCorruptedError('Refusing to store an invalid session.')
      }
      await mkdir(directory, {recursive: true, mode: 0o700})
      const key = await ensureKey(keyPath)
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', key, iv)
      const ciphertext = Buffer.concat([
        cipher.update(JSON.stringify(session), 'utf8'),
        cipher.final(),
      ])
      const payload = JSON.stringify({
        version: 1,
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        ciphertext: ciphertext.toString('base64'),
      })
      const temporaryPath = join(directory, `.session.${process.pid}.${randomBytes(6).toString('hex')}.tmp`)
      try {
        await writeFile(temporaryPath, `${payload}\n`, {encoding: 'utf8', mode: 0o600})
        await chmod(temporaryPath, 0o600)
        await replaceFile(temporaryPath, sessionPath)
      } catch (error) {
        await rm(temporaryPath, {force: true})
        throw error
      }
    },
    async clear() {
      await Promise.all([rm(sessionPath, {force: true}), rm(keyPath, {force: true})])
    },
  }
}

async function ensureKey(keyPath) {
  if (await exists(keyPath)) {
    try {
      return decodeBase64((await readFile(keyPath, 'utf8')).trim(), 32)
    } catch {
      throw new SessionStoreCorruptedError()
    }
  }
  const key = randomBytes(32)
  await writeFile(keyPath, `${key.toString('base64')}\n`, {encoding: 'utf8', mode: 0o600, flag: 'wx'})
  await chmod(keyPath, 0o600)
  return key
}

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

function decodeBase64(value, expectedLength) {
  if (typeof value !== 'string' || value === '' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new Error('invalid base64')
  }
  const decoded = Buffer.from(value, 'base64')
  if (decoded.toString('base64') !== value || (expectedLength !== undefined && decoded.length !== expectedLength)) {
    throw new Error('invalid base64')
  }
  return decoded
}

function isEncryptedPayload(value) {
  return isRecord(value) && value.version === 1 && typeof value.iv === 'string'
    && typeof value.tag === 'string' && typeof value.ciphertext === 'string'
}

function isStoredSession(value) {
  return isRecord(value) && value.version === 1
    && typeof value.name === 'string' && value.name.length > 0
    && typeof value.openId === 'string' && value.openId.length > 0
    && typeof value.employeeId === 'string' && value.employeeId.length > 0
    && typeof value.authenticatedAt === 'string' && Number.isFinite(Date.parse(value.authenticatedAt))
    && Object.keys(value).every((key) => ['version', 'name', 'openId', 'employeeId', 'authenticatedAt'].includes(key))
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export async function login({
  environment = process.env,
  fetchImpl = fetch,
  spawnImpl = spawn,
  platform = process.platform,
  stderr = process.stderr,
} = {}) {
  const config = loadConfig(environment)
  const state = randomBytes(32).toString('base64url')
  const callback = await createOAuthCallbackServer({
    redirectUri: config.redirectUri,
    state,
  })
  const authorizationUrl = buildAuthorizationUrl({
    appId: config.appId,
    redirectUri: config.redirectUri,
    state,
  })

  stderr.write('Waiting for Feishu authorization in your browser...\n')
  try {
    try {
      await openBrowser(authorizationUrl, {platform, spawnImpl})
    } catch {
      stderr.write(`Could not open a browser. Open this URL manually:\n${authorizationUrl}\n`)
    }

    const code = await callback.waitForCode
    return await exchangeCodeForUser(config, code, fetchImpl)
  } finally {
    await callback.close()
  }
}

const VERSION = '0.1.0'
const EXIT_OK = 0
const EXIT_NOT_LOGGED_IN = 1
const EXIT_OPERATIONAL = 2
const EXIT_AUTH = 3

export const ROOT_HELP = `Usage: doubao-login-demo <command> [options]

Commands:
  auth login             Sign in with Feishu OAuth
  auth status [--json]   Check the saved login status
  auth logout [--json]   Remove the saved login
  whoami [--json]        Show the signed-in Feishu user

Options:
  --help                 Show this help
  --version              Show the version
`

const AUTH_HELP = `Usage: doubao-login-demo auth <command>\n\nCommands:\n  login\n  status [--json]\n  logout [--json]\n`
const LOGIN_HELP = 'Usage: doubao-login-demo auth login\n'
const STATUS_HELP = 'Usage: doubao-login-demo auth status [--json]\n'
const LOGOUT_HELP = 'Usage: doubao-login-demo auth logout [--json]\n'
const WHOAMI_HELP = 'Usage: doubao-login-demo whoami [--json]\n'

export function createRuntimeDependencies(overrides = {}) {
  const environment = overrides.environment ?? process.env
  const sessionStore = overrides.sessionStore ?? createSessionStore({
    directory: getDataDirectory({environment}),
  })
  return {
    version: overrides.version ?? VERSION,
    stdout: overrides.stdout ?? process.stdout,
    stderr: overrides.stderr ?? process.stderr,
    now: overrides.now ?? (() => new Date()),
    sessionStore,
    login: overrides.login ?? (() => login({
      environment,
      fetchImpl: overrides.fetchImpl ?? fetch,
      spawnImpl: overrides.spawnImpl ?? spawn,
      platform: overrides.platform ?? process.platform,
      stderr: overrides.stderr ?? process.stderr,
    })),
  }
}

export async function runCli(argv, dependencies = createRuntimeDependencies()) {
  const {stdout, stderr, sessionStore} = dependencies
  try {
    if (sameArgs(argv, ['--version'])) {
      stdout.write(`${dependencies.version}\n`)
      return EXIT_OK
    }
    if (sameArgs(argv, ['--help']) || argv.length === 0) {
      stdout.write(ROOT_HELP)
      return EXIT_OK
    }
    if (sameArgs(argv, ['auth', '--help'])) {
      stdout.write(AUTH_HELP)
      return EXIT_OK
    }
    if (sameArgs(argv, ['auth', 'login', '--help'])) {
      stdout.write(LOGIN_HELP)
      return EXIT_OK
    }
    if (sameArgs(argv, ['auth', 'status', '--help'])) {
      stdout.write(STATUS_HELP)
      return EXIT_OK
    }
    if (sameArgs(argv, ['auth', 'logout', '--help'])) {
      stdout.write(LOGOUT_HELP)
      return EXIT_OK
    }
    if (sameArgs(argv, ['whoami', '--help'])) {
      stdout.write(WHOAMI_HELP)
      return EXIT_OK
    }

    if (sameArgs(argv, ['auth', 'login'])) {
      const user = await dependencies.login()
      await sessionStore.write({
        version: 1,
        name: user.name,
        openId: user.openId,
        employeeId: user.employeeId,
        authenticatedAt: dependencies.now().toISOString(),
      })
      stdout.write(`Logged in as ${user.name}\n`)
      return EXIT_OK
    }

    if (argv[0] === 'auth' && argv[1] === 'status') {
      const json = parseOptionalJson(argv.slice(2))
      const session = await sessionStore.read()
      if (!session) {
        stdout.write(json ? '{"loggedIn":false}\n' : 'Not logged in\n')
        return EXIT_NOT_LOGGED_IN
      }
      if (json) {
        stdout.write(`${JSON.stringify({loggedIn: true, user: {name: session.name, openId: session.openId, employeeId: session.employeeId}, authenticatedAt: session.authenticatedAt})}\n`)
      } else {
        stdout.write(`Logged in\nName: ${session.name}\nOpen ID: ${session.openId}\nEmployee ID: ${session.employeeId}\n`)
      }
      return EXIT_OK
    }

    if (argv[0] === 'auth' && argv[1] === 'logout') {
      const json = parseOptionalJson(argv.slice(2))
      await sessionStore.clear()
      stdout.write(json ? '{"loggedOut":true}\n' : 'Logged out\n')
      return EXIT_OK
    }

    if (argv[0] === 'whoami') {
      const json = parseOptionalJson(argv.slice(1))
      const session = await sessionStore.read()
      if (!session) {
        stdout.write(json ? '{"loggedIn":false}\n' : 'Not logged in\n')
        return EXIT_NOT_LOGGED_IN
      }
      if (json) {
        stdout.write(`${JSON.stringify({name: session.name, openId: session.openId, employeeId: session.employeeId})}\n`)
      } else {
        stdout.write(`Name: ${session.name}\nOpen ID: ${session.openId}\nEmployee ID: ${session.employeeId}\n`)
      }
      return EXIT_OK
    }

    throw new CliError('UNKNOWN_COMMAND', `Unknown command: ${argv.join(' ')}`)
  } catch (error) {
    stderr.write(`${renderCliError(error)}\n`)
    return isAuthenticationFailure(error) ? EXIT_AUTH : EXIT_OPERATIONAL
  }
}

function parseOptionalJson(args) {
  if (args.length === 0) return false
  if (sameArgs(args, ['--json'])) return true
  throw new CliError('UNKNOWN_OPTION', `Unknown option: ${args.join(' ')}`)
}

function sameArgs(actual, expected) {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index])
}

function isAuthenticationFailure(error) {
  return error instanceof CliError && [
    'AUTHORIZATION_DENIED',
    'AUTHORIZATION_FAILED',
    'AUTHORIZATION_TIMEOUT',
    'AUTHORIZATION_CANCELLED',
    'STATE_MISMATCH',
  ].includes(error.code)
}

function renderCliError(error) {
  if (error instanceof CliError || error instanceof SessionStoreCorruptedError) {
    return `${error.name === 'CliError' ? `${error.code}: ` : ''}${error.message}`
  }
  return 'UNEXPECTED_ERROR: The command could not be completed.'
}

export async function run(argv = process.argv.slice(2), dependencies) {
  return runCli(argv, dependencies ?? createRuntimeDependencies())
}

async function isMainModule() {
  if (!process.argv[1]) return false
  try {
    return await realpath(fileURLToPath(import.meta.url)) === await realpath(process.argv[1])
  } catch {
    return fileURLToPath(import.meta.url) === process.argv[1]
  }
}

if (await isMainModule()) {
  process.exitCode = await run()
}
