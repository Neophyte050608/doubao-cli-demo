import {spawn} from 'node:child_process'

const COMMANDS = Object.freeze({darwin: 'open', win32: 'explorer.exe', linux: 'xdg-open'})

export function openBrowser(url, {platform = process.platform, spawnImpl = spawn} = {}) {
  const command = COMMANDS[platform]
  if (!command) return Promise.reject(new Error(`Unsupported platform: ${platform}`))
  return new Promise((resolve, reject) => {
    const child = spawnImpl(command, [url], {detached: true, stdio: 'ignore', shell: false})
    const onError = () => reject(new Error('Unable to open browser'))
    child.once('error', onError)
    child.once('spawn', () => {
      child.off('error', onError)
      child.unref()
      resolve()
    })
  })
}
