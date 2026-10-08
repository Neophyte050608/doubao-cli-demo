import {createCipheriv, createDecipheriv, randomBytes} from 'node:crypto'
import {chmod, mkdir, readFile, rename, rm, stat, writeFile} from 'node:fs/promises'
import {homedir} from 'node:os'
import {join} from 'node:path'
import process from 'node:process'

export class SessionStoreCorruptedError extends Error {
  constructor(message = 'Local session storage is corrupted; run `auth logout` and login again.') {
    super(message)
    this.name = 'SessionStoreCorruptedError'
  }
}

export function getDataDirectory({
  environment = process.env,
  platform = process.platform,
  homeDirectory = homedir(),
} = {}) {
  if (environment.DOUBAO_CLI_DEMO_HOME?.trim()) {
    return environment.DOUBAO_CLI_DEMO_HOME.trim()
  }
  if (platform === 'win32') {
    return join(environment.APPDATA || homeDirectory, 'doubao-cli-demo')
  }
  return join(environment.XDG_CONFIG_HOME || join(homeDirectory, '.config'), 'doubao-cli-demo')
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
        const decipher = createDecipheriv('aes-256-gcm', key, decodeBase64(payload.iv, 12))
        decipher.setAuthTag(decodeBase64(payload.tag, 16))
        const plaintext = Buffer.concat([
          decipher.update(decodeBase64(payload.ciphertext)),
          decipher.final(),
        ]).toString('utf8')
        const session = JSON.parse(plaintext)
        if (!isStoredSession(session)) throw new Error('invalid session')
        return session
      } catch (error) {
        if (error instanceof SessionStoreCorruptedError) throw error
        throw new SessionStoreCorruptedError()
      }
    },
    async write(session) {
      if (!isStoredSession(session)) {
        throw new SessionStoreCorruptedError('Refusing to store an invalid session.')
      }
      await mkdir(directory, {recursive: true, mode: 0o700})
      const key = await ensureKey(keyPath)
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', key, iv)
      const ciphertext = Buffer.concat([
        cipher.update(JSON.stringify(session), 'utf8'),
        cipher.final(),
      ])
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
  if (typeof value !== 'string' || value === '' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new Error('invalid base64')
  }
  const decoded = Buffer.from(value, 'base64')
  if (decoded.toString('base64') !== value || (expectedLength !== undefined && decoded.length !== expectedLength)) {
    throw new Error('invalid base64')
  }
  return decoded
}

function isEncryptedPayload(value) {
  return isRecord(value) && value.version === 1 && typeof value.iv === 'string'
    && typeof value.tag === 'string' && typeof value.ciphertext === 'string'
}

function isStoredSession(value) {
  return isRecord(value) && value.version === 1
    && (value.backendUrl === undefined || (typeof value.backendUrl === 'string' && value.backendUrl.length > 0))
    && typeof value.sessionToken === 'string' && value.sessionToken.length > 0
    && typeof value.name === 'string' && value.name.length > 0
    && typeof value.openId === 'string' && value.openId.length > 0
    && typeof value.unionId === 'string' && value.unionId.length > 0
    && typeof value.authenticatedAt === 'string' && Number.isFinite(Date.parse(value.authenticatedAt))
    && Object.keys(value).every((key) => ['version', 'backendUrl', 'sessionToken', 'name', 'openId', 'unionId', 'authenticatedAt'].includes(key))
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
