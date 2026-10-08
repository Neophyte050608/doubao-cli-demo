import {spawn} from 'node:child_process'
import process from 'node:process'

import {CliError} from './errors.mjs'

export function openBrowser(
  url,
  {platform = process.platform, spawnImpl = spawn, timeoutMs = 3000} = {},
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

    let timeout
    let finished = false
    const cleanup = () => {
      if (timeout) clearTimeout(timeout)
      child.off?.('error', fail)
      child.off?.('close', finish)
    }
    const fail = () => {
      if (finished) return
      finished = true
      cleanup()
      reject(new CliError('BROWSER_OPEN_FAILED', 'Could not open the browser.'))
    }
    const finish = (exitCode) => {
      if (finished) return
      if (exitCode === 0) {
        finished = true
        cleanup()
        resolve()
        return
      }
      fail()
    }
    const continueWithoutWaiting = () => {
      if (finished) return
      finished = true
      cleanup()
      // Opening a browser is best-effort. In restricted connector sandboxes the
      // platform opener may stay alive after handing off to the browser; do not
      // let that prevent the CLI from polling for OAuth completion.
      child.unref?.()
      resolve()
    }

    child.once('error', fail)
    child.once('close', finish)
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timeout = setTimeout(continueWithoutWaiting, timeoutMs)
    }
  })
}
