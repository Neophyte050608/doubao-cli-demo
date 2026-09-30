import assert from 'node:assert/strict'
import {chmod, mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {spawn} from 'node:child_process'
import test from 'node:test'

import {startFakeGateway} from './support/fake-gateway.mjs'

const projectDirectory = new URL('..', import.meta.url).pathname
const forbiddenOutput = /fake-access-token|fake-refresh-token|Authorization:\s*Bearer/i

test('packed CLI installs on PATH and supports offline help, version, and status', async (t) => {
  const fixture = await installPackedCli(t)
  const env = isolatedEnvironment(fixture)

  const version = await run(fixture.executable, ['--version'], {env})
  assert.equal(version.code, 0)
  assert.equal(version.stdout, '0.1.0\n')

  const help = await run(fixture.executable, ['--help'], {env})
  assert.equal(help.code, 0)
  assert.match(help.stdout, /auth login/)
  assert.match(help.stdout, /auth status/)
  assert.match(help.stdout, /auth logout/)
  assert.match(help.stdout, /whoami/)

  const status = await run(fixture.executable, ['auth', 'status'], {env})
  assert.equal(status.code, 1)
  assert.equal(status.stdout, 'Not logged in\n')
  assert.equal(status.stderr, '')

  const names = fixture.packageFiles.map(({path}) => path)
  for (const pattern of [/(^|\/)test\//, /(^|\/)\.git\//, /session\.(?:json\.enc|key)$/, /\.tmp$/, /(^|\/)\.env(?:\.|$)/]) {
    assert.equal(names.some((name) => pattern.test(name)), false, `tarball contains forbidden file matching ${pattern}`)
  }
})

test('installed CLI completes login, identity, and logout against a fake Gateway', async (t) => {
  const fixture = await installPackedCli(t)
  const gateway = await startFakeGateway()
  t.after(() => gateway.close())
  const env = isolatedEnvironment(fixture)

  const login = await run(fixture.executable, ['auth', 'login', '--host', gateway.host], {env, timeoutMs: 10_000})
  assert.equal(login.code, 0)
  assert.match(login.stdout, /^Authorization pending\n/)
  assert.match(login.stdout, /Logged in as Alice\n$/)

  const status = await run(fixture.executable, ['auth', 'status'], {env})
  assert.equal(status.code, 0)
  assert.equal(status.stdout.split('\n')[0], 'Logged in')
  assert.match(status.stdout, /Name: Alice/)

  const whoami = await run(fixture.executable, ['whoami', '--json'], {env})
  assert.equal(whoami.code, 0)
  assert.deepEqual(JSON.parse(whoami.stdout), {
    displayName: 'Alice',
    userId: 'ou_fake_alice',
    host: gateway.host,
  })

  const logout = await run(fixture.executable, ['auth', 'logout'], {env})
  assert.equal(logout.code, 0)
  assert.equal(logout.stdout, 'Logged out\n')

  const loggedOut = await run(fixture.executable, ['auth', 'status'], {env})
  assert.equal(loggedOut.code, 1)
  assert.equal(loggedOut.stdout, 'Not logged in\n')

  const combined = [login, status, whoami, logout, loggedOut]
    .map(({stdout, stderr}) => stdout + stderr)
    .join('\n')
  assert.doesNotMatch(combined, forbiddenOutput)
  assert.deepEqual(gateway.requests.map(({path}) => path), [
    '/api/cli/auth/start',
    '/api/cli/auth/poll',
    '/api/cli/auth/poll',
    '/api/cli/auth/current',
    '/api/cli/auth/current',
  ])
})

async function installPackedCli(t) {
  const root = await mkdtemp(join(tmpdir(), 'doubao-login-demo-package-'))
  t.after(async () => {
    const {rm} = await import('node:fs/promises')
    await rm(root, {recursive: true, force: true})
  })
  const packed = await run('npm', ['pack', '--json', '--pack-destination', root], {
    cwd: projectDirectory,
    timeoutMs: 30_000,
  })
  assert.equal(packed.code, 0, packed.stderr)
  const [metadata] = JSON.parse(packed.stdout)
  const tarball = join(root, metadata.filename)
  const prefix = join(root, 'install')
  const installed = await run('npm', ['install', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund', tarball], {
    cwd: root,
    timeoutMs: 30_000,
  })
  assert.equal(installed.code, 0, installed.stderr)
  return {
    root,
    prefix,
    packageFiles: metadata.files,
    executable: join(prefix, 'node_modules', '.bin', 'doubao-login-demo'),
  }
}

function isolatedEnvironment({root}) {
  const home = join(root, 'home')
  const config = join(root, 'config')
  const fakeBin = join(root, 'fake-bin')
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: config,
    APPDATA: join(root, 'appdata'),
    PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
  }
}

async function prepareBrowserStub(root) {
  const fakeBin = join(root, 'fake-bin')
  await mkdir(fakeBin, {recursive: true})
  for (const command of ['open', 'xdg-open', 'explorer.exe']) {
    const path = join(fakeBin, command)
    await writeFile(path, '#!/bin/sh\nexit 0\n')
    await chmod(path, 0o755)
  }
}

async function run(command, args, {cwd, env, timeoutMs = 10_000} = {}) {
  if (env?.PATH && env.XDG_CONFIG_HOME) {
    const root = join(env.XDG_CONFIG_HOME, '..')
    await prepareBrowserStub(root)
  }
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {cwd, env, shell: false, stdio: ['ignore', 'pipe', 'pipe']})
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`Command timed out: ${command} ${args.join(' ')}`))
    }, timeoutMs)
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      resolve({code: code ?? (signal ? 128 : 2), stdout, stderr})
    })
  })
}
