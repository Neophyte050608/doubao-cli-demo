import assert from 'node:assert/strict'
import {mkdtemp, readFile, rm, stat, unlink, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import test from 'node:test'

import {createSessionStore, SessionStoreCorruptedError} from '../src/session-store.mjs'

const session = {
  host: 'https://gateway.example.com', accessToken: 'secret-access-token', expiresAt: '2026-09-30T12:00:00Z',
  principalType: 'USER', userId: 'ou_1', displayName: 'Alice', refreshable: true,
  refreshableUntil: '2026-10-30T12:00:00Z',
}

async function temporaryStore(options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'doubao-session-'))
  return {directory, store: createSessionStore({directory, ...options})}
}

test('encrypts and restores a v3 session with private file modes', async (t) => {
  const {directory, store} = await temporaryStore()
  t.after(() => rm(directory, {recursive: true, force: true}))
  await store.write(session)
  assert.deepEqual(await store.read(), session)
  assert.doesNotMatch(await readFile(store.paths.sessionPath, 'utf8'), /secret-access-token/)
  if (process.platform !== 'win32') {
    assert.equal((await stat(store.paths.sessionPath)).mode & 0o777, 0o600)
    assert.equal((await stat(store.paths.keyPath)).mode & 0o777, 0o600)
  }
})

test('only treats both missing files as logged out', async (t) => {
  const {directory, store} = await temporaryStore()
  t.after(() => rm(directory, {recursive: true, force: true}))
  assert.equal(await store.read(), null)
  await store.write(session)
  await unlink(store.paths.keyPath)
  await assert.rejects(store.read(), SessionStoreCorruptedError)
  await store.clear()
  await store.write(session)
  await unlink(store.paths.sessionPath)
  await assert.rejects(store.read(), SessionStoreCorruptedError)
})

test('detects ciphertext and schema tampering', async (t) => {
  const {directory, store} = await temporaryStore()
  t.after(() => rm(directory, {recursive: true, force: true}))
  await store.write(session)
  const payload = JSON.parse(await readFile(store.paths.sessionPath, 'utf8'))
  payload.ciphertext = Buffer.from('tampered').toString('base64')
  await writeFile(store.paths.sessionPath, JSON.stringify(payload))
  await assert.rejects(store.read(), SessionStoreCorruptedError)

  await store.write(session)
  const key = await readFile(store.paths.keyPath, 'utf8')
  await writeFile(store.paths.keyPath, key.slice(1))
  await assert.rejects(store.read(), SessionStoreCorruptedError)
})

test('clear removes session and key idempotently', async (t) => {
  const {directory, store} = await temporaryStore()
  t.after(() => rm(directory, {recursive: true, force: true}))
  await store.write(session)
  await store.clear()
  await store.clear()
  assert.equal(await store.read(), null)
})

test('rename failure keeps the previous valid session and removes temporary files', async (t) => {
  let shouldFail = false
  const {directory, store} = await temporaryStore({
    replaceFile: async (source, destination) => {
      if (shouldFail) throw new Error('rename failed')
      const {rename} = await import('node:fs/promises')
      await rename(source, destination)
    },
  })
  t.after(() => rm(directory, {recursive: true, force: true}))
  await store.write(session)
  shouldFail = true
  await assert.rejects(store.write({...session, displayName: 'Bob'}), /rename failed/)
  assert.deepEqual(await store.read(), session)
  const {readdir} = await import('node:fs/promises')
  assert.equal((await readdir(directory)).some((name) => name.endsWith('.tmp')), false)
})
