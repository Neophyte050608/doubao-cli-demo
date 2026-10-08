#!/usr/bin/env node

import {spawn} from 'node:child_process'
import process from 'node:process'
import {fileURLToPath} from 'node:url'
import {realpath} from 'node:fs/promises'

import {createBackendClient} from './backend.mjs'
import {loadConfig} from './config.mjs'
import {CliError} from './errors.mjs'
import {loadDotEnv} from './env.mjs'
import {login} from './login.mjs'
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

export const ROOT_HELP = `Usage: doubao-login-demo <command> [options]

Commands:
  auth login             Sign in with Feishu via the backend
  auth status [--json]   Check the saved login status (local)
  auth logout [--json]   Remove the saved login
  whoami [--json]        Ask the backend who you are (live /api/me)

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
  const fetchImpl = overrides.fetchImpl ?? fetch
  return {
    version: overrides.version ?? VERSION,
    stdout: overrides.stdout ?? process.stdout,
    stderr: overrides.stderr ?? process.stderr,
    now: overrides.now ?? (() => new Date()),
    sessionStore,
    environment,
    fetchImpl,
    login: overrides.login ?? (() => login({
      environment,
      fetchImpl,
      spawnImpl: overrides.spawnImpl ?? spawn,
      platform: overrides.platform ?? process.platform,
      stderr: overrides.stderr ?? process.stderr,
    })),
    createBackend: overrides.createBackend ?? ((config) =>
      createBackendClient({backendUrl: config.backendUrl, fetchImpl})),
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
      const {sessionToken} = await dependencies.login()
      const config = loadConfig(dependencies.environment)
      const backend = dependencies.createBackend(config)
      const user = await backend.fetchMe(sessionToken)
      if (!user) {
        throw new CliError('LOGIN_FAILED', 'The backend rejected the new session token.')
      }
      await sessionStore.write({
        version: 1,
        sessionToken,
        name: user.name,
        openId: user.openId,
        unionId: user.unionId,
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
      const config = loadConfig(dependencies.environment)
      const backend = dependencies.createBackend(config)
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
  process.exitCode = await run()
}
