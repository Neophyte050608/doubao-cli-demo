import {homedir} from 'node:os'

import {createAuthClient, AuthHttpError} from './auth-client.mjs'
import {createAuthSession} from './auth-session.mjs'
import {openBrowser} from './browser.mjs'
import {getDataDirectory, normalizeHost} from './config.mjs'
import {CliError, EXIT_CODES} from './errors.mjs'
import {runLogin} from './login-flow.mjs'
import {
  renderLogout,
  renderPending,
  renderStatus,
  renderWhoami,
  ROOT_HELP,
} from './output.mjs'
import {createSessionStore, SessionStoreCorruptedError} from './session-store.mjs'

const DEFAULT_VERSION = '0.1.0'

function writeLine(stream, value) {
  stream.write(`${value}\n`)
}

export async function runCli(argv, dependencies) {
  const {stdout, stderr, version} = dependencies
  try {
    if (sameArgs(argv, ['--version'])) {
      writeLine(stdout, version)
      return EXIT_CODES.OK
    }
    if (sameArgs(argv, ['--help'])) {
      stdout.write(ROOT_HELP)
      return EXIT_CODES.OK
    }
    if (argv.length === 0) {
      stderr.write(ROOT_HELP)
      return EXIT_CODES.OPERATIONAL
    }

    if (argv[0] === 'auth' && argv[1] === 'login') {
      const host = parseLoginArgs(argv.slice(2))
      const identity = await dependencies.login({
        host,
        onPending: async (pending) => stdout.write(renderPending(pending)),
      })
      writeLine(stdout, `Logged in as ${identity.displayName}`)
      return EXIT_CODES.OK
    }

    if (argv[0] === 'auth' && argv[1] === 'status') {
      const json = parseOptionalJson(argv.slice(2))
      const identity = await dependencies.authSession.getIdentity()
      stdout.write(renderStatus(identity, {json}))
      return identity.loggedIn ? EXIT_CODES.OK : EXIT_CODES.NOT_LOGGED_IN
    }

    if (argv[0] === 'auth' && argv[1] === 'logout') {
      const json = parseOptionalJson(argv.slice(2))
      await dependencies.authSession.logout()
      stdout.write(renderLogout({json}))
      return EXIT_CODES.OK
    }

    if (argv[0] === 'whoami') {
      const json = parseOptionalJson(argv.slice(1))
      const identity = await dependencies.authSession.getIdentity()
      stdout.write(renderWhoami(identity, {json}))
      return identity.loggedIn ? EXIT_CODES.OK : EXIT_CODES.NOT_LOGGED_IN
    }

    throw new CliError('UNKNOWN_COMMAND', `Unknown command: ${argv.join(' ')}`, EXIT_CODES.OPERATIONAL)
  } catch (error) {
    if (error instanceof CliError) {
      writeLine(stderr, error.message)
      return error.exitCode
    }
    if (error instanceof AuthHttpError || error instanceof SessionStoreCorruptedError) {
      writeLine(stderr, error.message)
      return EXIT_CODES.OPERATIONAL
    }
    writeLine(stderr, 'Unexpected CLI failure')
    return EXIT_CODES.OPERATIONAL
  }
}

export function createRuntimeDependencies(overrides = {}) {
  const version = overrides.version ?? DEFAULT_VERSION
  const sessionStore = overrides.sessionStore ?? createSessionStore({
    directory: getDataDirectory({env: process.env, platform: process.platform, homeDir: homedir()}),
  })
  const authClient = overrides.authClient ?? createAuthClient({
    fetchImpl: globalThis.fetch,
    timeoutMs: 10_000,
    version,
  })
  const authSession = overrides.authSession ?? createAuthSession({
    authClient,
    sessionStore,
    now: () => new Date(),
  })
  const signalSource = overrides.signalSource ?? createProcessSignalSource()
  const login = overrides.login ?? (({host, onPending}) => runLogin({
    host,
    authClient,
    sessionStore,
    openBrowser: overrides.openBrowser ?? openBrowser,
    sleep: overrides.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))),
    now: overrides.now ?? (() => new Date()),
    onPending,
    signalSource,
  }))

  return {
    version,
    stdout: overrides.stdout ?? process.stdout,
    stderr: overrides.stderr ?? process.stderr,
    authSession,
    login,
  }
}

function parseLoginArgs(args) {
  if (args.length !== 2 || args[0] !== '--host') {
    throw new CliError('INVALID_LOGIN_OPTIONS', 'Usage: doubao-login-demo auth login --host <url>', EXIT_CODES.OPERATIONAL)
  }
  return normalizeHost(args[1])
}

function parseOptionalJson(args) {
  if (args.length === 0) return false
  if (sameArgs(args, ['--json'])) return true
  throw new CliError('UNKNOWN_OPTION', `Unknown option: ${args.join(' ')}`, EXIT_CODES.OPERATIONAL)
}

function sameArgs(actual, expected) {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index])
}

function createProcessSignalSource() {
  return {
    subscribe(handler) {
      const onSigint = () => handler('SIGINT')
      const onSigterm = () => handler('SIGTERM')
      process.once('SIGINT', onSigint)
      process.once('SIGTERM', onSigterm)
      return () => {
        process.off('SIGINT', onSigint)
        process.off('SIGTERM', onSigterm)
      }
    },
  }
}
