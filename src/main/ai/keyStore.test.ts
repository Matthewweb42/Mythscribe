import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { maskKey } from '@shared/ai'
import { AppError } from '../ipc/errors'
import { AiKeyStore, NO_KEYCHAIN_MESSAGE, NO_KEYCHAIN_SESSION_MESSAGE } from './keyStore'
import { fakeSafeStorage } from './keyStoreFixture'

const KEY = 'sk-test-secret-1234abcd'

let tmp: string
let file: string

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-keys-'))
  file = path.join(tmp, 'userData', 'ai-keys.json')
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('AiKeyStore (F-5.1)', () => {
  it('reports no key before anything is saved and clearKey is then a no-op', () => {
    const store = new AiKeyStore(file, fakeSafeStorage())
    expect(store.hasKey('openai')).toBe(false)
    expect(store.getKey('openai')).toBeNull()
    expect(store.getHint('openai')).toBeNull()
    store.clearKey('openai')
    expect(fs.existsSync(file)).toBe(false)
  })

  it('round-trips a key through the file with only ciphertext on disk', () => {
    const store = new AiKeyStore(file, fakeSafeStorage())
    store.setKey('openai', KEY)
    expect(store.getKey('openai')).toBe(KEY)
    expect(store.hasKey('openai')).toBe(true)
    expect(store.getHint('openai')).toBe('sk-…abcd')

    const raw = fs.readFileSync(file, 'utf8')
    expect(raw).not.toContain(KEY)
    const parsed = JSON.parse(raw) as { version: number; keys: Record<string, unknown> }
    expect(parsed.version).toBe(1)
    expect(Object.keys(parsed.keys)).toEqual(['openai'])
    expect(typeof parsed.keys.openai).toBe('string')
    expect(fs.existsSync(`${file}.tmp`)).toBe(false)

    // A fresh store over the same file decrypts it again.
    expect(new AiKeyStore(file, fakeSafeStorage()).getKey('openai')).toBe(KEY)
  })

  it('replaces the key on a second save and forgets it on clear', () => {
    const store = new AiKeyStore(file, fakeSafeStorage())
    store.setKey('openai', KEY)
    store.setKey('openai', 'sk-other-key-9999wxyz')
    expect(store.getHint('openai')).toBe('sk-…wxyz')
    store.clearKey('openai')
    expect(store.hasKey('openai')).toBe(false)
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ version: 1, keys: {} })
  })

  it('refuses to store a key with IO and touches no file when safe storage is unavailable', () => {
    const safe = fakeSafeStorage({ isEncryptionAvailable: () => false })
    const store = new AiKeyStore(file, safe)
    expect(store.encryption()).toBe('none')
    expect(() => store.setKey('openai', KEY)).toThrow(AppError)
    try {
      store.setKey('openai', KEY)
    } catch (err) {
      expect(err).toBeInstanceOf(AppError)
      if (err instanceof AppError) {
        expect(err.code).toBe('IO')
        expect(err.message).not.toContain(KEY)
      }
    }
    expect(safe.encrypted).toEqual([])
    expect(fs.existsSync(file)).toBe(false)
  })

  it('reports plain on a keyring-less Linux box and os anywhere else', () => {
    const basic = fakeSafeStorage({ getSelectedStorageBackend: () => 'basic_text' })
    expect(new AiKeyStore(file, basic, 'linux').encryption()).toBe('plain')
    expect(new AiKeyStore(file, basic, 'win32').encryption()).toBe('os')
    expect(new AiKeyStore(file, fakeSafeStorage(), 'linux').encryption()).toBe('os')
  })

  it('refuses a provider key without the OS keychain (S2) but keeps the Cloud session', () => {
    const basic = fakeSafeStorage({ getSelectedStorageBackend: () => 'basic_text' })
    const store = new AiKeyStore(file, basic, 'linux')
    for (const id of ['openai', 'openrouter'] as const) {
      expect(() => store.setKey(id, KEY)).toThrow(NO_KEYCHAIN_MESSAGE)
      expect(store.hasKey(id)).toBe(false)
    }
    expect(fs.existsSync(file)).toBe(false)
    // Slice B3b: the account's refresh token is held to the same rule (S2, A5).
    expect(() => store.setKey('cloudSession', KEY)).toThrow(NO_KEYCHAIN_SESSION_MESSAGE)
    expect(store.hasKey('cloudSession')).toBe(false)
    expect(store.canStoreProviderKey()).toBe(false)
    expect(new AiKeyStore(file, fakeSafeStorage(), 'linux').canStoreProviderKey()).toBe(true)
    // The e2e's escape hatch (xvfb has no keyring): the fallback is allowed only when asked.
    const e2e = new AiKeyStore(file, basic, 'linux', true)
    expect(e2e.canStoreProviderKey()).toBe(true)
    e2e.setKey('openrouter', KEY)
    expect(e2e.getKey('openrouter')).toBe(KEY)
  })

  it('treats ciphertext that no longer decrypts as no key, naming only the provider', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(
      file,
      JSON.stringify({ version: 1, keys: { openai: Buffer.from('garbage').toString('base64') } })
    )
    const store = new AiKeyStore(file, fakeSafeStorage())
    expect(store.getKey('openai')).toBeNull()
    expect(store.hasKey('openai')).toBe(false)
    expect(store.getHint('openai')).toBeNull()
    expect(console.warn).toHaveBeenCalledWith(
      'Could not decrypt the stored openai key',
      expect.any(Error)
    )
  })

  it('treats an unreadable or malformed file as empty and can save over it', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, '{not json')
    const store = new AiKeyStore(file, fakeSafeStorage())
    expect(store.hasKey('openai')).toBe(false)
    store.setKey('openai', KEY)
    expect(store.getKey('openai')).toBe(KEY)

    fs.writeFileSync(file, JSON.stringify({ version: 2, keys: 'nope' }))
    expect(new AiKeyStore(file, fakeSafeStorage()).hasKey('openai')).toBe(false)
  })
})

describe('maskKey', () => {
  it('keeps the first three and last four characters', () => {
    expect(maskKey('sk-abcdefghijkl')).toBe('sk-…ijkl')
  })
})
