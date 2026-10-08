import {spawn} from 'node:child_process'
import process from 'node:process'

import {CliError} from './errors.mjs'

export function openBrowser(
  url,
  {platform = process.platform, spawnImpl = spawn} = {},
) {
  const command =
    platform === 'darwin'
      ? 'open'
      : platform === 'win32'
        ? 'explorer.exe'
        : 'xdg-open'

  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawnImpl(command, [url], {shell: false, stdio: 'ignore'})
    } catch {
      reject(new CliError('BROWSER_OPEN_FAILED', 'Could not open the browser.'))
      return
    }

    let finished = false
    const fail = () => {
      if (finished) return
      finished = true
      reject(new CliError('BROWSER_OPEN_FAILED', 'Could not open the browser.'))
    }
    const finish = (exitCode) => {
      if (finished) return
      if (exitCode === 0) {
        finished = true
        resolve()
        return
      }
      fail()
    }

    child.once('error', fail)
    child.once('close', finish)
    child.unref?.()
  })
}
