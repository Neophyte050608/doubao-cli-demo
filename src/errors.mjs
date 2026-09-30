export const EXIT_CODES = Object.freeze({
  OK: 0,
  NOT_LOGGED_IN: 1,
  OPERATIONAL: 2,
  AUTH: 3,
})

export class CliError extends Error {
  constructor(code, message, exitCode = EXIT_CODES.OPERATIONAL, options) {
    super(message, options)
    this.name = 'CliError'
    this.code = code
    this.exitCode = exitCode
  }
}
