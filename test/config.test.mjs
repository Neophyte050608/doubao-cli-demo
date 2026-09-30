import assert from 'node:assert/strict'
import test from 'node:test'
import {getDataDirectory, normalizeHost} from '../src/config.mjs'

test('normalizes secure gateway hosts', () => {
  assert.equal(normalizeHost('https://gateway.example.com/'), 'https://gateway.example.com')
})

test('allows loopback HTTP with an explicit port', () => {
  assert.equal(normalizeHost('http://127.0.0.1:8080'), 'http://127.0.0.1:8080')
  assert.equal(normalizeHost('http://[::1]:8080/'), 'http://[::1]:8080')
})

test('rejects insecure or malformed origins', () => {
  assert.throws(() => normalizeHost('http://gateway.example.com'), /HTTPS/)
  assert.throws(() => normalizeHost('http://127.0.0.1'), /explicit port/)
  assert.throws(() => normalizeHost('https://user:pass@gateway.example.com'), /credentials/)
  assert.throws(() => normalizeHost('https://gateway.example.com/api'), /origin only/)
  assert.throws(() => normalizeHost('https://gateway.example.com?q=1'), /origin only/)
  assert.throws(() => normalizeHost('https://gateway.example.com/#x'), /origin only/)
})

test('chooses platform-native data directories', () => {
  assert.equal(getDataDirectory({env: {XDG_CONFIG_HOME: '/xdg'}, platform: 'linux', homeDir: '/home/alice'}), '/xdg/doubao-login-demo')
  assert.equal(getDataDirectory({env: {}, platform: 'darwin', homeDir: '/Users/alice'}), '/Users/alice/.config/doubao-login-demo')
  assert.equal(getDataDirectory({env: {APPDATA: 'C:\\Users\\Alice\\AppData\\Roaming'}, platform: 'win32', homeDir: 'C:\\Users\\Alice'}), 'C:\\Users\\Alice\\AppData\\Roaming/doubao-login-demo')
})
