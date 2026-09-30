import {normalizeHost} from './config.mjs'
import {CliError, EXIT_CODES} from './errors.mjs'

const MAX_LOGIN_WINDOW_MS = 10 * 60 * 1000
const CANCEL_TIMEOUT_MS = 2_000
const TERMINAL_STATUSES = new Set(['denied', 'cancelled', 'expired', 'failed', 'consumed'])

export function validateVerificationUrl({host, verificationUrl}) {
  const normalizedHost = normalizeHost(host)
  let url
  try {
    url = new URL(verificationUrl)
  } catch {
    throw invalidVerificationUrl()
  }
  if (url.origin !== normalizedHost || url.username || url.password || !url.pathname.startsWith('/api/cli/auth/')) {
    throw invalidVerificationUrl()
  }
  return url.toString()
}

export async function runLogin({host, authClient, sessionStore, openBrowser, sleep, now, onPending, signalSource}) {
  const normalizedHost = normalizeHost(host)
  const started = await authClient.start({host: normalizedHost})
  const verificationUrl = validateVerificationUrl({host: normalizedHost, verificationUrl: started.verificationUrl})
  validateTiming(started, now())

  let cancelled = false
  let cancellationResolve
  const cancellation = new Promise((resolve) => { cancellationResolve = resolve })
  const unsubscribe = signalSource?.subscribe((signal) => {
    if (cancelled) return
    cancelled = true
    void cancelWithin(authClient, normalizedHost, started.loginSessionId).finally(() => {
      cancellationResolve({cancelled: true, signal})
    })
  }) ?? (() => {})

  try {
    await onPending({
      verificationUrl,
      userCode: started.userCode,
      loginSessionId: started.loginSessionId,
      expiresAt: started.expiresAt,
      pollIntervalSeconds: started.pollIntervalSeconds,
    })
    await openBrowser(verificationUrl).catch(() => undefined)
    const expiresAt = new Date(started.expiresAt).getTime()

    while (true) {
      if (cancelled) throw cancelledError()
      if (now().getTime() >= expiresAt) {
        throw new CliError('LOGIN_EXPIRED', 'Login session expired', EXIT_CODES.AUTH)
      }
      const outcome = await Promise.race([
        authClient.poll({host: normalizedHost, loginSessionId: started.loginSessionId}),
        cancellation,
      ])
      if (outcome?.cancelled || cancelled) throw cancelledError()
      if (outcome.status === 'pending') {
        await Promise.race([sleep(started.pollIntervalSeconds * 1000), cancellation])
        if (cancelled) throw cancelledError()
        continue
      }
      if (TERMINAL_STATUSES.has(outcome.status)) {
        throw new CliError(`LOGIN_${outcome.status.toUpperCase()}`, `Login ${outcome.status}`, EXIT_CODES.AUTH)
      }
      if (outcome.status !== 'authorized') {
        throw new CliError('INVALID_LOGIN_RESPONSE', 'Gateway returned an invalid login result', EXIT_CODES.OPERATIONAL)
      }

      const storedSession = {host: normalizedHost, ...outcome.session}
      await sessionStore.write(storedSession)
      if (cancelled) {
        await sessionStore.clear?.()
        throw cancelledError()
      }
      return {displayName: outcome.session.displayName, userId: outcome.session.userId, host: normalizedHost}
    }
  } finally {
    unsubscribe()
  }
}

function validateTiming(started, current) {
  if (!Number.isInteger(started.pollIntervalSeconds) || started.pollIntervalSeconds < 1 || started.pollIntervalSeconds > 30) {
    throw new CliError('INVALID_LOGIN_RESPONSE', 'Gateway returned an invalid polling interval', EXIT_CODES.OPERATIONAL)
  }
  const expiresAt = new Date(started.expiresAt).getTime()
  const remaining = expiresAt - current.getTime()
  if (!Number.isFinite(expiresAt) || remaining <= 0 || remaining > MAX_LOGIN_WINDOW_MS) {
    throw new CliError('INVALID_LOGIN_RESPONSE', 'Gateway returned an invalid login expiry', EXIT_CODES.OPERATIONAL)
  }
}

async function cancelWithin(authClient, host, loginSessionId) {
  let timer
  const timeout = new Promise((resolve) => {
    timer = setTimeout(resolve, CANCEL_TIMEOUT_MS)
    timer.unref?.()
  })
  try {
    await Promise.race([
      Promise.resolve(authClient.cancel({host, loginSessionId})).catch(() => undefined),
      timeout,
    ])
  } finally {
    clearTimeout(timer)
  }
}

function invalidVerificationUrl() {
  return new CliError('INVALID_VERIFICATION_URL', 'Gateway returned an unsafe verification URL', EXIT_CODES.OPERATIONAL)
}

function cancelledError() {
  return new CliError('LOGIN_CANCELLED', 'Login cancelled', EXIT_CODES.AUTH)
}
