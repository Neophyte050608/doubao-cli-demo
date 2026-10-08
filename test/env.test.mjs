import assert from 'node:assert/strict'
import {mkdtemp, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {loadDotEnv} from '../src/env.mjs'

test('loadDotEnv fills missing values without overriding the real environment', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'doubao-login-env-'))
  await writeFile(
    join(directory, '.env'),
    [
      '# comment',
      'FEISHU_APP_ID=cli_from_file',
      'FEISHU_APP_SECRET="secret_from_file"',
      "FEISHU_REDIRECT_URI='http://127.0.0.1:8787/callback'",
      '',
    ].join('\n'),
  )

  const environment = {FEISHU_APP_ID: 'cli_from_shell'}
  await loadDotEnv({directory, environment})

  assert.equal(environment.FEISHU_APP_ID, 'cli_from_shell')
  assert.equal(environment.FEISHU_APP_SECRET, 'secret_from_file')
  assert.equal(environment.FEISHU_REDIRECT_URI, 'http://127.0.0.1:8787/callback')
})

test('loadDotEnv ignores a missing .env file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'doubao-login-env-'))
  const environment = {}
  await loadDotEnv({directory, environment})
  assert.deepEqual(environment, {})
})
