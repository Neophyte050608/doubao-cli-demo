import {AuthHttpError} from './auth-client.mjs'

const REFRESH_WINDOW_MS = 5 * 60 * 1000

export class AuthSessionError extends Error {
  constructor(message) {
    super(message)
    this.name = 'AuthSessionError'
  }
}

export function createAuthSession({authClient, sessionStore, now}) {
  return {
    async getIdentity() {
      let session = await sessionStore.read()
      if (!session) return {loggedIn: false}
      if (!hasValidMetadata(session)) {
        await sessionStore.clear()
        throw new AuthSessionError('Local session metadata is invalid')
      }

      let refreshed = false
      if (new Date(session.expiresAt).getTime() - now().getTime() <= REFRESH_WINDOW_MS) {
        const outcome = await refreshOnce({authClient, sessionStore, session})
        if (!outcome) return {loggedIn: false}
        session = outcome
        refreshed = true
      }

      try {
        const identity = await authClient.current({host: session.host, accessToken: session.accessToken})
        return publicIdentity(session.host, identity)
      } catch (error) {
        if (!isUnauthorized(error)) throw error
        if (refreshed) {
          await sessionStore.clear()
          return {loggedIn: false}
        }
      }

      const next = await refreshOnce({authClient, sessionStore, session})
      if (!next) return {loggedIn: false}
      try {
        const identity = await authClient.current({host: next.host, accessToken: next.accessToken})
        return publicIdentity(next.host, identity)
      } catch (error) {
        if (!isUnauthorized(error)) throw error
        await sessionStore.clear()
        return {loggedIn: false}
      }
    },
    async logout() {
      await sessionStore.clear()
    },
  }
}

async function refreshOnce({authClient, sessionStore, session}) {
  let result
  try {
    result = await authClient.refresh({host: session.host, accessToken: session.accessToken})
  } catch (error) {
    if (!isUnauthorized(error)) throw error
    await sessionStore.clear()
    return null
  }
  const next = {host: session.host, ...result}
  if (!hasValidMetadata(next)) {
    await sessionStore.clear()
    throw new AuthSessionError('Gateway returned invalid session metadata')
  }
  await sessionStore.write(next)
  return next
}

function publicIdentity(host, identity) {
  return {
    loggedIn: true,
    host,
    user: {displayName: identity.displayName, userId: identity.userId},
    expiresAt: identity.expiresAt,
    refreshable: identity.refreshable,
    refreshableUntil: identity.refreshableUntil,
  }
}

function hasValidMetadata(session) {
  return typeof session?.host === 'string' && session.host.length > 0
    && typeof session.accessToken === 'string' && session.accessToken.length > 0
    && Number.isFinite(new Date(session.expiresAt).getTime())
    && session.principalType === 'USER'
    && typeof session.userId === 'string' && session.userId.length > 0
    && typeof session.displayName === 'string' && session.displayName.length > 0
    && typeof session.refreshable === 'boolean'
    && Number.isFinite(new Date(session.refreshableUntil).getTime())
}

function isUnauthorized(error) {
  return error instanceof AuthHttpError && error.status === 401
}
