#!/usr/bin/env node

import {spawn} from 'node:child_process'
import process from 'node:process'
import {fileURLToPath} from 'node:url'
import {realpath} from 'node:fs/promises'

import {createBackendClient} from './backend.mjs'
import {loadConfig} from './config.mjs'
import {CliError} from './errors.mjs'
import {loadDotEnv} from './env.mjs'
import {interpretPoll, startLogin, waitForLogin} from './login.mjs'
import {
  SessionStoreCorruptedError,
  createSessionStore,
  getDataDirectory,
} from './session-store.mjs'

const VERSION = '0.1.0'
const EXIT_OK = 0
const EXIT_NOT_LOGGED_IN = 1
const EXIT_OPERATIONAL = 2
const EXIT_AUTH = 3

export const ROOT_HELP = `Usage: doubao-cli-demo <command> [options]

Commands:
  auth login                 Sign in with Feishu via the backend and wait
  auth login --no-wait       Start a login and print the session id without waiting
  auth poll <login-session>  Check a pending login session once
  auth status [--json]       Check the saved login status (local)
  auth logout [--json]       Remove the saved login
  whoami [--json]            Ask the backend who you are (live /api/me)

Options:
  --help                     Show this help
  --version                  Show the version
`

const AUTH_HELP = `Usage: doubao-cli-demo auth <command>

Commands:
  login [--no-wait] [--login-session-id <id>]
  poll <login-session-id>
  status [--json]
  logout [--json]
`
const LOGIN_HELP = 'Usage: doubao-cli-demo auth login [--no-wait] [--login-session-id <id>]\n'
const POLL_HELP = 'Usage: doubao-cli-demo auth poll <login-session-id>\n'
const STATUS_HELP = 'Usage: doubao-cli-demo auth status [--json]\n'
const LOGOUT_HELP = 'Usage: doubao-cli-demo auth logout [--json]\n'
const WHOAMI_HELP = 'Usage: doubao-cli-demo whoami [--json]\n'

export function createRuntimeDependencies(overrides = {}) {
  const environment = overrides.environment ?? process.env
  const sessionStore = overrides.sessionStore ?? createSessionStore({
    directory: getDataDirectory({environment}),
  })
  const fetchImpl = overrides.fetchImpl ?? fetch
  return {
    version: overrides.version ?? VERSION,
    stdout: overrides.stdout ?? process.stdout,
    stderr: overrides.stderr ?? process.stderr,
    now: overrides.now ?? (() => new Date()),
    sessionStore,
    environment,
    fetchImpl,
    spawnImpl: overrides.spawnImpl ?? spawn,
    platform: overrides.platform ?? process.platform,
    signal: overrides.signal,
    createBackend: overrides.createBackend ?? ((config) =>
      createBackendClient({backendUrl: config.backendUrl, fetchImpl})),
  }
}

async function persistSession(dependencies, sessionToken, user) {
  await dependencies.sessionStore.write({
    version: 1,
    sessionToken,
    name: user.name,
    openId: user.openId,
    unionId: user.unionId,
    authenticatedAt: dependencies.now().toISOString(),
  })
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
    if (sameArgs(argv, ['auth', 'poll', '--help'])) {
      stdout.write(POLL_HELP)
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

    if (argv[0] === 'auth' && argv[1] === 'login') {
      return await handleLogin(argv.slice(2), dependencies)
    }

    if (argv[0] === 'auth' && argv[1] === 'poll') {
      return await handlePoll(argv.slice(2), dependencies)
    }

    if (argv[0] === 'auth' && argv[1] === 'status') {
      const json = parseOptionalJson(argv.slice(2))
      const session = await sessionStore.read()
      if (!session) {
        stdout.write(json ? '{"loggedIn":false}\n' : 'Not logged in\n')
        return EXIT_NOT_LOGGED_IN
      }
      if (json) {
        stdout.write(`${JSON.stringify({loggedIn: true, user: {name: session.name, openId: session.openId, unionId: session.unionId}, authenticatedAt: session.authenticatedAt})}\n`)
      } else {
        stdout.write(`Logged in\nName: ${session.name}\nOpen ID: ${session.openId}\nUnion ID: ${session.unionId}\n`)
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
      const backend = dependencies.createBackend(loadConfig(dependencies.environment))
      const user = await backend.fetchMe(session.sessionToken)
      if (!user) {
        await sessionStore.clear()
        stdout.write(json ? '{"loggedIn":false}\n' : 'Not logged in\n')
        return EXIT_NOT_LOGGED_IN
      }
      if (json) {
        stdout.write(`${JSON.stringify({name: user.name, openId: user.openId, unionId: user.unionId})}\n`)
      } else {
        stdout.write(`Name: ${user.name}\nOpen ID: ${user.openId}\nUnion ID: ${user.unionId}\n`)
      }
      return EXIT_OK
    }

    throw new CliError('UNKNOWN_COMMAND', `Unknown command: ${argv.join(' ')}`)
  } catch (error) {
    stderr.write(`${renderCliError(error)}\n`)
    return isAuthenticationFailure(error) ? EXIT_AUTH : EXIT_OPERATIONAL
  }
}

// auth login [--no-wait] [--login-session-id <id>]
async function handleLogin(args, dependencies) {
  const {stdout, stderr, sessionStore} = dependencies
  const {noWait, loginSessionId} = parseLoginArgs(args)
  const backend = dependencies.createBackend(loadConfig(dependencies.environment))

  // Complete a previously started session (single check, like `auth poll`).
  if (loginSessionId !== undefined) {
    const outcome = interpretPoll(await backend.poll(loginSessionId))
    if (outcome.status === 'pending') {
      stderr.write(`Login session ${loginSessionId} is still pending; this command checks once.\n`)
      return EXIT_NOT_LOGGED_IN
    }
    await persistSession(dependencies, outcome.sessionToken, outcome.user)
    stdout.write(`Logged in as ${outcome.user.name}\n`)
    return EXIT_OK
  }

  const started = await startLogin({
    backend,
    stderr,
    open: !noWait,
    spawnImpl: dependencies.spawnImpl,
    platform: dependencies.platform,
  })

  if (noWait) {
    stderr.write(`Run \`doubao-cli-demo auth poll ${started.loginSessionId}\` to finish signing in.\n`)
    return EXIT_OK
  }

  const {sessionToken, user} = await waitForLogin({
    backend,
    started,
    now: () => dependencies.now().getTime(),
    signal: dependencies.signal,
  })
  await persistSession(dependencies, sessionToken, user)
  stdout.write(`Logged in as ${user.name}\n`)
  return EXIT_OK
}

// auth poll <login-session-id>
async function handlePoll(args, dependencies) {
  const {stdout, stderr} = dependencies
  const loginSessionId = args[0]
  if (!loginSessionId || loginSessionId.startsWith('-')) {
    throw new CliError('USAGE', 'auth poll requires a login session id.')
  }
  const backend = dependencies.createBackend(loadConfig(dependencies.environment))
  const outcome = interpretPoll(await backend.poll(loginSessionId))
  if (outcome.status === 'pending') {
    stderr.write(`Login session ${loginSessionId} is still pending; this command checks once.\n`)
    return EXIT_NOT_LOGGED_IN
  }
  await persistSession(dependencies, outcome.sessionToken, outcome.user)
  stdout.write(`Logged in as ${outcome.user.name}\n`)
  return EXIT_OK
}

function parseLoginArgs(args) {
  let noWait = false
  let loginSessionId
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--no-wait') {
      noWait = true
    } else if (arg === '--login-session-id') {
      loginSessionId = args[index + 1]
      index += 1
      if (!loginSessionId || loginSessionId.startsWith('-')) {
        throw new CliError('USAGE', '--login-session-id requires a value.')
      }
    } else if (arg.startsWith('--login-session-id=')) {
      loginSessionId = arg.slice('--login-session-id='.length)
      if (!loginSessionId) {
        throw new CliError('USAGE', '--login-session-id requires a value.')
      }
    } else {
      throw new CliError('UNKNOWN_OPTION', `Unknown option: ${arg}`)
    }
  }
  if (noWait && loginSessionId !== undefined) {
    throw new CliError('USAGE', '--no-wait cannot be combined with --login-session-id.')
  }
  return {noWait, loginSessionId}
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
    'AUTHORIZATION_CANCELLED',
    'AUTHORIZATION_FAILED',
    'AUTHORIZATION_TIMEOUT',
    'AUTHORIZATION_CONSUMED',
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
  await loadDotEnv()
  // Allow Ctrl+C to cancel a pending login cleanly (cancels on the backend too).
  const controller = new AbortController()
  const onSigint = () => controller.abort()
  process.once('SIGINT', onSigint)
  try {
    process.exitCode = await run(process.argv.slice(2), createRuntimeDependencies({signal: controller.signal}))
  } finally {
    process.off('SIGINT', onSigint)
  }
}
