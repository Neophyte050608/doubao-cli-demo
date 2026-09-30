import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import test from 'node:test'

import {CliError, EXIT_CODES} from '../src/errors.mjs'
import {runLogin, validateVerificationUrl} from '../src/login-flow.mjs'

const start = {
  loginSessionId: 'cls_1', verificationUrl: 'https://gateway.example.com/api/cli/auth/authorize?loginSessionId=cls_1',
  userCode: 'ABCD-EFGH', pollIntervalSeconds: 2, expiresAt: '2026-09-30T12:04:30Z',
}
const authorized = {
  status: 'authorized',
  session: {
    accessToken: 'secret-access-token', expiresAt: '2026-09-30T13:00:00Z', principalType: 'USER',
    userId: 'ou_1', displayName: 'Alice', refreshable: true, refreshableUntil: '2026-10-30T12:00:00Z',
  },
}

function signalSource() {
  const emitter = new EventEmitter()
  return {
    emitter,
    subscribe(handler) {
      emitter.on('signal', handler)
      return () => emitter.off('signal', handler)
    },
  }
}

function setup({pollResults = [{status: 'pending'}, authorized], openReject = false, startOverride = {}, write, cancel} = {}) {
  const calls = []
  const signals = signalSource()
  let tick = new Date('2026-09-30T12:00:00Z').getTime()
  const authClient = {
    start: async (input) => { calls.push(['start', input]); return {...start, ...startOverride} },
    poll: async (input) => { calls.push(['poll', input]); return pollResults.shift() },
    cancel: cancel ?? (async (input) => { calls.push(['cancel', input]); return {status: 'cancelled', loginSessionId: 'cls_1'} }),
  }
  const sessionStore = {
    write: write ?? (async (session) => { calls.push(['write', session]) }),
  }
  const result = runLogin({
    host: 'https://gateway.example.com', authClient, sessionStore,
    openBrowser: async (url) => { calls.push(['open', url]); if (openReject) throw new Error('browser unavailable') },
    sleep: async (ms) => { calls.push(['sleep', ms]); tick += ms },
    now: () => new Date(tick),
    onPending: async (value) => { calls.push(['pending', value]) },
    signalSource: signals,
  })
  return {result, calls, signals}
}

test('only accepts a same-origin Gateway auth verification URL', () => {
  assert.equal(validateVerificationUrl({host: 'https://gateway.example.com', verificationUrl: start.verificationUrl}), start.verificationUrl)
  for (const url of [
    'https://evil.example.com/api/cli/auth/authorize',
    'http://gateway.example.com/api/cli/auth/authorize',
    'https://user@gateway.example.com/api/cli/auth/authorize',
    'https://gateway.example.com/other/path',
    'javascript:alert(1)',
  ]) {
    assert.throws(() => validateVerificationUrl({host: 'https://gateway.example.com', verificationUrl: url}), /verification URL/)
  }
})

test('prints pending details before open and persists before returning success', async () => {
  const {result, calls} = setup()
  const identity = await result
  assert.deepEqual(identity, {displayName: 'Alice', userId: 'ou_1', host: 'https://gateway.example.com'})
  assert.deepEqual(calls.map(([name]) => name), ['start', 'pending', 'open', 'poll', 'sleep', 'poll', 'write'])
  assert.equal(calls.find(([name]) => name === 'sleep')[1], 2000)
  assert.equal(calls.find(([name]) => name === 'write')[1].host, 'https://gateway.example.com')
})

test('continues polling when browser launch fails', async () => {
  const {result, calls} = setup({openReject: true, pollResults: [authorized]})
  assert.equal((await result).displayName, 'Alice')
  assert.deepEqual(calls.map(([name]) => name), ['start', 'pending', 'open', 'poll', 'write'])
})

test('rejects unsafe timing metadata before polling', async () => {
  for (const startOverride of [
    {pollIntervalSeconds: 0},
    {pollIntervalSeconds: 31},
    {expiresAt: 'invalid'},
    {expiresAt: '2026-09-30T13:00:00Z'},
  ]) {
    const {result, calls} = setup({startOverride})
    await assert.rejects(result, (error) => error instanceof CliError && error.exitCode === EXIT_CODES.OPERATIONAL)
    assert.equal(calls.some(([name]) => name === 'poll'), false)
  }
})

test('maps every terminal login status to a stable auth failure', async () => {
  for (const status of ['denied', 'cancelled', 'expired', 'failed', 'consumed']) {
    const {result} = setup({pollResults: [{status, message: 'secret-access-token'}]})
    await assert.rejects(result, (error) => error instanceof CliError
      && error.exitCode === EXIT_CODES.AUTH
      && !error.message.includes('secret-access-token'))
  }
})

test('times out locally without an infinite poll loop', async () => {
  const {result, calls} = setup({pollResults: [{status: 'pending'}, {status: 'pending'}, {status: 'pending'}], startOverride: {expiresAt: '2026-09-30T12:00:03Z'}})
  await assert.rejects(result, (error) => error instanceof CliError && error.code === 'LOGIN_EXPIRED')
  assert.equal(calls.filter(([name]) => name === 'poll').length, 2)
})

test('cancels on a signal and never writes a session even if cancel fails', async () => {
  let releasePoll
  const pollWait = new Promise((resolve) => { releasePoll = resolve })
  const calls = []
  const signals = signalSource()
  const result = runLogin({
    host: 'https://gateway.example.com',
    authClient: {
      start: async () => start,
      poll: async () => { calls.push(['poll']); return pollWait },
      cancel: async (input) => { calls.push(['cancel', input]); throw new Error('cancel unavailable') },
    },
    sessionStore: {write: async () => { calls.push(['write']) }},
    openBrowser: async () => {}, sleep: async () => {}, now: () => new Date('2026-09-30T12:00:00Z'),
    onPending: async () => {}, signalSource: signals,
  })
  await new Promise((resolve) => setImmediate(resolve))
  signals.emitter.emit('signal', 'SIGINT')
  releasePoll({status: 'pending'})
  await assert.rejects(result, (error) => error instanceof CliError && error.code === 'LOGIN_CANCELLED')
  assert.equal(calls.some(([name]) => name === 'cancel'), true)
  assert.equal(calls.some(([name]) => name === 'write'), false)
})

test('does not report success when cancellation wins before persistence', async () => {
  let releaseWrite
  const writeStarted = new Promise((resolve) => {
    releaseWrite = resolve
  })
  const signals = signalSource()
  const calls = []
  let allowWrite
  const blockedWrite = new Promise((resolve) => { allowWrite = resolve })
  const result = runLogin({
    host: 'https://gateway.example.com',
    authClient: {
      start: async () => start,
      poll: async () => authorized,
      cancel: async () => { calls.push(['cancel']) },
    },
    sessionStore: {write: async () => { calls.push(['write-start']); releaseWrite(); await blockedWrite; calls.push(['write-end']) }},
    openBrowser: async () => {}, sleep: async () => {}, now: () => new Date('2026-09-30T12:00:00Z'),
    onPending: async () => {}, signalSource: signals,
  })
  await writeStarted
  signals.emitter.emit('signal', 'SIGTERM')
  allowWrite()
  await assert.rejects(result, (error) => error instanceof CliError && error.code === 'LOGIN_CANCELLED')
  assert.equal(calls.some(([name]) => name === 'write-end'), true)
})
