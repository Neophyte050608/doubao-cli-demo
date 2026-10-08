import {readFile} from 'node:fs/promises'
import {join} from 'node:path'
import process from 'node:process'

// Loads KEY=VALUE pairs from a .env file into process.env without overriding
// variables that are already set in the real environment. Missing files are
// ignored so the CLI still works when everything is exported manually.
export async function loadDotEnv({
  directory = process.cwd(),
  environment = process.env,
} = {}) {
  let contents
  try {
    contents = await readFile(join(directory, '.env'), 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return
    throw error
  }

  for (const rawLine of contents.split('\n')) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    const separator = line.indexOf('=')
    if (separator === -1) continue
    const key = line.slice(0, separator).trim()
    if (key === '') continue
    let value = line.slice(separator + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (environment[key] === undefined) {
      environment[key] = value
    }
  }
}
