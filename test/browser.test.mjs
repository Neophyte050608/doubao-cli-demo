import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import test from 'node:test'

import {openBrowser} from '../src/browser.mjs'

for (const [platform, expectedCommand] of [['darwin', 'open'], ['win32', 'explorer.exe'], ['linux', 'xdg-open']]) {
  test(`opens URLs safely on ${platform}`, async () => {
    const calls = []
    const child = new EventEmitter()
    child.unref = () => calls.push(['unref'])
    const spawnImpl = (command, args, options) => {
      calls.push([command, args, options])
      queueMicrotask(() => child.emit('spawn'))
      return child
    }
    await openBrowser('https://gateway.example.com/api/cli/auth/authorize?id=1', {platform, spawnImpl})
    assert.deepEqual(calls[0], [expectedCommand, ['https://gateway.example.com/api/cli/auth/authorize?id=1'], {
      detached: true, stdio: 'ignore', shell: false,
    }])
    assert.deepEqual(calls[1], ['unref'])
  })
}

test('rejects unsupported platforms', async () => {
  await assert.rejects(openBrowser('https://gateway.example.com', {platform: 'aix', spawnImpl: () => {}}), /Unsupported platform/)
})

test('rejects browser spawn failures', async () => {
  const child = new EventEmitter()
  child.unref = () => {}
  const promise = openBrowser('https://gateway.example.com', {
    platform: 'linux',
    spawnImpl: () => {
      queueMicrotask(() => child.emit('error', new Error('not installed')))
      return child
    },
  })
  await assert.rejects(promise, /Unable to open browser/)
})
