import {chmod, mkdir, readFile, rename, rm, writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import process from 'node:process'

import {CliError} from './errors.mjs'

export const DEFAULT_BACKEND_URL = 'http://127.0.0.1:8787'
const ENV_BACKEND_URL = 'DOUBAO_CLI_DEMO_BACKEND_URL'

// The CLI only needs to know where the backend lives. It never holds the
// Feishu app secret: all OAuth happens on the backend.
export function loadConfig(environment = process.env, options = {}) {
  const raw = options.host?.trim() || environment[ENV_BACKEND_URL]?.trim() || DEFAULT_BACKEND_URL
  return {backendUrl: normalizeBackendUrl(raw, options.source ?? ENV_BACKEND_URL)}
}

export async function resolveConfig({environment = process.env, configStore, host} = {}) {
  if (host?.trim()) {
    return {backendUrl: normalizeBackendUrl(host, '--host')}
  }

  const persistedConfig = configStore ? await configStore.read() : null
  if (persistedConfig?.backendUrl) {
    return {backendUrl: persistedConfig.backendUrl}
  }

  return loadConfig(environment)
}

export function createConfigStore({directory, replaceFile = rename}) {
  const configPath = join(directory, 'config.json')

  return {
    paths: {configPath},
    async read() {
      try {
        const parsed = JSON.parse(await readFile(configPath, 'utf8'))
        if (!isRecord(parsed) || typeof parsed.backendUrl !== 'string' || !parsed.backendUrl.trim()) {
          return null
        }
        return {backendUrl: normalizeBackendUrl(parsed.backendUrl, 'stored backend URL')}
      } catch (error) {
        if (error?.code === 'ENOENT') return null
        if (error instanceof CliError) throw error
        throw new CliError(
          'INVALID_CONFIGURATION',
          'Local backend configuration is invalid; run `doubao-cli-demo config host unset` and configure it again.',
        )
      }
    },
    async write(config) {
      const backendUrl = normalizeBackendUrl(config?.backendUrl, 'backend URL')
      await mkdir(directory, {recursive: true, mode: 0o700})
      const temporaryPath = join(directory, `.config.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`)
      try {
        await writeFile(
          temporaryPath,
          `${JSON.stringify({backendUrl}, null, 2)}\n`,
          {encoding: 'utf8', mode: 0o600},
        )
        await chmod(temporaryPath, 0o600)
        await replaceFile(temporaryPath, configPath)
      } catch (error) {
        await rm(temporaryPath, {force: true})
        throw error
      }
    },
    async clear() {
      await rm(configPath, {force: true})
    },
  }
}

export function normalizeBackendUrl(raw, source = 'backend URL') {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new CliError('INVALID_CONFIGURATION', `${source} must be a valid http(s) URL.`)
  }

  let backendUrl
  try {
    backendUrl = new URL(raw.trim())
  } catch {
    throw new CliError('INVALID_CONFIGURATION', `${source} must be a valid http(s) URL.`)
  }
  if (backendUrl.protocol !== 'http:' && backendUrl.protocol !== 'https:') {
    throw new CliError('INVALID_CONFIGURATION', `${source} must use http or https.`)
  }

  // Normalize to an origin string without a trailing slash/path. The CLI talks
  // to fixed backend paths such as /auth/start and /api/me.
  return backendUrl.origin
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
