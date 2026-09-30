import assert from 'node:assert/strict'
import test from 'node:test'

import {AuthHttpError} from '../src/auth-client.mjs'
import {AuthSessionError, createAuthSession} from '../src/auth-session.mjs'

const baseSession = {
  host: 'https://gateway.example.com', accessToken: 'secret-old-token', expiresAt: '2026-09-30T13:00:00Z',
  principalType: 'USER', userId: 'ou_1', displayName: 'Alice', refreshable: true,
  refreshableUntil: '2026-10-30T12:00:00Z',
}
const refreshed = {...baseSession, accessToken: 'secret-new-token', expiresAt: '2026-09-30T14:00:00Z'}
const identity = Object.fromEntries(Object.entries(refreshed).filter(([key]) => !['host', 'accessToken'].includes(key)))

function setup({session = baseSession, current, refresh} = {}) {
  const calls = []
  let stored = session
  const sessionStore = {
    read: async () => stored,
    write: async (value) => { calls.push(['write', value]); stored = value },
    clear: async () => { calls.push(['clear']); stored = null },
  }
  const authClient = {
    current: current ?? (async (input) => { calls.push(['current', input]); return identity }),
    refresh: refresh ?? (async (input) => { calls.push(['refresh', input]); return refreshed }),
  }
  return {auth: createAuthSession({authClient, sessionStore, now: () => new Date('2026-09-30T12:00:00Z')}), calls, sessionStore}
}

test('returns logged out without network calls when no session exists', async () => {
  const {auth, calls} = setup({session: null})
  assert.deepEqual(await auth.getIdentity(), {loggedIn: false})
  assert.deepEqual(calls, [])
})

test('validates a fresh session with current once and hides the token', async () => {
  const {auth, calls} = setup()
  const result = await auth.getIdentity()
  assert.deepEqual(result, {
    loggedIn: true, host: baseSession.host, user: {displayName: 'Alice', userId: 'ou_1'},
    expiresAt: refreshed.expiresAt, refreshable: true, refreshableUntil: refreshed.refreshableUntil,
  })
  assert.deepEqual(calls.map(([name]) => name), ['current'])
  assert.equal('accessToken' in result, false)
})

test('preemptively refreshes an expiring session, persists it, then validates current', async () => {
  const {auth, calls} = setup({session: {...baseSession, expiresAt: '2026-09-30T12:04:00Z'}})
  await auth.getIdentity()
  assert.deepEqual(calls.map(([name]) => name), ['refresh', 'write', 'current'])
  assert.equal(calls[2][1].accessToken, 'secret-new-token')
})

test('refreshes once after current returns 401 then retries current once', async () => {
  let attempts = 0
  const {auth, calls} = setup({
    current: async (input) => {
      calls.push(['current', input])
      if (attempts++ === 0) throw new AuthHttpError('server', 'Gateway request failed', {status: 401})
      return identity
    },
  })
  assert.equal((await auth.getIdentity()).loggedIn, true)
  assert.deepEqual(calls.map(([name]) => name), ['current', 'refresh', 'write', 'current'])
})

test('clears and reports logged out when refresh or second current is unauthorized', async () => {
  for (const mode of ['refresh', 'second-current']) {
    let currentAttempts = 0
    const {auth, calls} = setup({
      current: async () => {
        if (mode === 'second-current' || currentAttempts++ === 0) throw new AuthHttpError('server', 'Gateway request failed', {status: 401})
        return identity
      },
      refresh: async () => {
        if (mode === 'refresh') throw new AuthHttpError('server', 'Gateway request failed', {status: 401})
        return refreshed
      },
    })
    assert.deepEqual(await auth.getIdentity(), {loggedIn: false})
    assert.equal(calls.some(([name]) => name === 'clear'), true)
  }
})

test('keeps session and propagates operational current or refresh failures', async () => {
  for (const phase of ['current', 'refresh']) {
    const failure = new AuthHttpError('network', 'Gateway request failed')
    const {auth, calls} = setup({
      session: phase === 'refresh' ? {...baseSession, expiresAt: '2026-09-30T11:59:00Z'} : baseSession,
      current: async () => { throw failure },
      refresh: async () => { throw failure },
    })
    await assert.rejects(auth.getIdentity(), failure)
    assert.equal(calls.some(([name]) => name === 'clear'), false)
  }
})

test('clears invalid session metadata without exposing credentials', async () => {
  const {auth, calls} = setup({session: {...baseSession, expiresAt: 'invalid'}})
  await assert.rejects(auth.getIdentity(), (error) => error instanceof AuthSessionError && !error.message.includes('secret-old-token'))
  assert.equal(calls.some(([name]) => name === 'clear'), true)
})

test('logout clears local state', async () => {
  const {auth, calls} = setup()
  await auth.logout()
  assert.deepEqual(calls, [['clear']])
})
