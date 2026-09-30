import assert from 'node:assert/strict'
import test from 'node:test'
import {invoke} from './support/run-cli.mjs'

test('prints a stable version', async () => {
  const result = await invoke(['--version'])
  assert.equal(result.code, 0)
  assert.match(result.stdout, /^0\.1\.0\n$/)
  assert.equal(result.stderr, '')
})

test('prints offline help without secrets', async () => {
  const result = await invoke(['--help'])
  assert.equal(result.code, 0)
  assert.match(result.stdout, /auth login/)
  assert.match(result.stdout, /auth status/)
  assert.match(result.stdout, /auth logout/)
  assert.match(result.stdout, /whoami/)
  assert.doesNotMatch(result.stdout, /App Secret|access token|FEISHU_APP_SECRET/i)
})

test('rejects unknown commands and missing commands', async () => {
  const unknown = await invoke(['unknown'])
  assert.equal(unknown.code, 2)
  assert.match(unknown.stderr, /Unknown command/)
  const missing = await invoke([])
  assert.equal(missing.code, 2)
  assert.match(missing.stderr, /Usage:/)
})
