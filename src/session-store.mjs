import {createCipheriv, createDecipheriv, randomBytes} from 'node:crypto'
import {chmod, mkdir, readFile, rename, rm, stat, writeFile} from 'node:fs/promises'
import {join} from 'node:path'

export class SessionStoreCorruptedError extends Error {
  constructor(message = 'Local session storage is corrupted') {
    super(message)
    this.name = 'SessionStoreCorruptedError'
  }
}

export function createSessionStore({directory, replaceFile = rename}) {
  const sessionPath = join(directory, 'session.json.enc')
  const keyPath = join(directory, 'session.key')

  return {
    paths: {sessionPath, keyPath},
    async read() {
      const [hasSession, hasKey] = await Promise.all([exists(sessionPath), exists(keyPath)])
      if (!hasSession && !hasKey) return null
      if (!hasSession || !hasKey) throw new SessionStoreCorruptedError()
      try {
        const [serialized, encodedKey] = await Promise.all([
          readFile(sessionPath, 'utf8'),
          readFile(keyPath, 'utf8'),
        ])
        const payload = JSON.parse(serialized)
        if (!isEncryptedPayload(payload)) throw new Error('invalid payload')
        const key = decodeBase64(encodedKey.trim(), 32)
        const iv = decodeBase64(payload.iv, 12)
        const tag = decodeBase64(payload.tag, 16)
        const ciphertext = decodeBase64(payload.ciphertext)
        const decipher = createDecipheriv('aes-256-gcm', key, iv)
        decipher.setAuthTag(tag)
        const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
        const session = JSON.parse(plaintext)
        if (!isStoredSession(session)) throw new Error('invalid session')
        return session
      } catch (error) {
        if (error instanceof SessionStoreCorruptedError) throw error
        throw new SessionStoreCorruptedError()
      }
    },
    async write(session) {
      if (!isStoredSession(session)) throw new SessionStoreCorruptedError('Refusing to store an invalid session')
      await mkdir(directory, {recursive: true, mode: 0o700})
      const key = await ensureKey(keyPath)
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', key, iv)
      const ciphertext = Buffer.concat([cipher.update(JSON.stringify(session), 'utf8'), cipher.final()])
      const payload = JSON.stringify({
        version: 1,
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        ciphertext: ciphertext.toString('base64'),
      })
      const temporaryPath = join(directory, `.session.${process.pid}.${randomBytes(6).toString('hex')}.tmp`)
      try {
        await writeFile(temporaryPath, `${payload}\n`, {encoding: 'utf8', mode: 0o600})
        await chmod(temporaryPath, 0o600)
        await replaceFile(temporaryPath, sessionPath)
      } catch (error) {
        await rm(temporaryPath, {force: true})
        throw error
      }
    },
    async clear() {
      await Promise.all([rm(sessionPath, {force: true}), rm(keyPath, {force: true})])
    },
  }
}

async function ensureKey(keyPath) {
  if (await exists(keyPath)) {
    try {
      return decodeBase64((await readFile(keyPath, 'utf8')).trim(), 32)
    } catch {
      throw new SessionStoreCorruptedError()
    }
  }
  const key = randomBytes(32)
  await writeFile(keyPath, `${key.toString('base64')}\n`, {encoding: 'utf8', mode: 0o600, flag: 'wx'})
  await chmod(keyPath, 0o600)
  return key
}

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

function decodeBase64(value, expectedLength) {
  if (typeof value !== 'string' || value === '' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error('invalid base64')
  const decoded = Buffer.from(value, 'base64')
  if (decoded.toString('base64') !== value || (expectedLength !== undefined && decoded.length !== expectedLength)) throw new Error('invalid base64')
  return decoded
}

function isEncryptedPayload(value) {
  return isRecord(value) && value.version === 1 && typeof value.iv === 'string'
    && typeof value.tag === 'string' && typeof value.ciphertext === 'string'
}

function isStoredSession(value) {
  return isRecord(value) && typeof value.host === 'string' && value.host.length > 0
    && typeof value.accessToken === 'string' && value.accessToken.length > 0
    && typeof value.expiresAt === 'string' && value.expiresAt.length > 0
    && value.principalType === 'USER' && typeof value.userId === 'string' && value.userId.length > 0
    && typeof value.displayName === 'string' && value.displayName.length > 0
    && typeof value.refreshable === 'boolean'
    && typeof value.refreshableUntil === 'string' && value.refreshableUntil.length > 0
    && Object.keys(value).every((key) => ['host', 'accessToken', 'expiresAt', 'principalType', 'userId', 'displayName', 'refreshable', 'refreshableUntil'].includes(key))
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
