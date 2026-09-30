import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import test from 'node:test'

const requiredSnippets = [
  'doubao-login-demo --version',
  'doubao-login-demo --help',
  'doubao-login-demo auth login --host https://<gateway-public-host>',
  'doubao-login-demo auth status',
  '^Logged in$',
  'doubao-login-demo auth logout',
  'doubao-login-demo whoami',
]

const forbiddenPatterns = [
  /FEISHU_APP_SECRET=/,
  /\/private\/tmp\/feishu-cli-demo/,
  /accounts\.feishu\.cn.*token/i,
  /Bearer\s+(?:fake|test|example|secret)[-_A-Za-z0-9]*/i,
]

test('README and connector guide document the stable Doubao CLI contract safely', async () => {
  const paths = ['README.md', 'docs/doubao-connector.md']
  const documents = await Promise.all(paths.map((path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')))
  const combined = documents.join('\n')

  for (const snippet of requiredSnippets) assert.match(combined, new RegExp(escapeRegExp(snippet)))
  for (const pattern of forbiddenPatterns) assert.doesNotMatch(combined, pattern)
})

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
