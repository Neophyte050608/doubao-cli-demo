import {CliError, EXIT_CODES} from './errors.mjs'
import {ROOT_HELP} from './output.mjs'

function writeLine(stream, value) {
  stream.write(`${value}\n`)
}

export async function runCli(argv, dependencies) {
  const {stdout, stderr, version} = dependencies
  try {
    if (argv.length === 1 && argv[0] === '--version') {
      writeLine(stdout, version)
      return EXIT_CODES.OK
    }
    if (argv.length === 1 && argv[0] === '--help') {
      stdout.write(ROOT_HELP)
      return EXIT_CODES.OK
    }
    if (argv.length === 0) {
      stderr.write(ROOT_HELP)
      return EXIT_CODES.OPERATIONAL
    }
    throw new CliError('UNKNOWN_COMMAND', `Unknown command: ${argv.join(' ')}`, EXIT_CODES.OPERATIONAL)
  } catch (error) {
    if (error instanceof CliError) {
      writeLine(stderr, error.message)
      return error.exitCode
    }
    writeLine(stderr, 'Unexpected CLI failure')
    return EXIT_CODES.OPERATIONAL
  }
}

export function createRuntimeDependencies(overrides = {}) {
  return {
    version: overrides.version ?? '0.1.0',
    stdout: overrides.stdout ?? process.stdout,
    stderr: overrides.stderr ?? process.stderr,
    ...overrides,
  }
}
