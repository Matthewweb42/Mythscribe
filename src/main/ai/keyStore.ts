import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { maskKey, type AiKeyEncryption, type AiProviderId } from '@shared/ai'
import { AppError } from '../ipc/errors'
/** What the store protects: a provider key (F-5.1) or the MythScribe Cloud session (F-15.2). */
export type SecretId = AiProviderId | 'cloudSession'

/** The parts of Electron's `safeStorage` the store uses; structural so tests inject a fake. */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(plainText: string): Buffer
  decryptString(encrypted: Buffer): string
  /** Linux only in Electron; `basic_text` means no keyring, so the key is obfuscated, not encrypted. */
  getSelectedStorageBackend(): string
}

/** The on-disk shape: a version and base64 ciphertext per provider id, nothing else. */
const KeyFile = z.object({
  version: z.literal(1),
  keys: z.record(z.string(), z.string())
})
type KeyFile = z.infer<typeof KeyFile>

const EMPTY: KeyFile = { version: 1, keys: {} }

export const NO_SAFE_STORAGE_MESSAGE =
  'This system has no safe storage available, so the key cannot be stored securely. ' +
  'On Linux, install and unlock a keyring (GNOME Keyring or KWallet), then try again.'

/**
 * The one owner of provider keys (F-5.1) and the Cloud session (F-15.2): `<userData>/ai-keys.json`, separate from
 * `app-state.json` so the layout file never carries even ciphertext. Read lazily and written
 * atomically like `AppStateStore`; an unreadable file or ciphertext warns (naming only the
 * provider, never the key) and reads as "no key", so nothing throws on the read path.
 */
export class AiKeyStore {
  private cache: KeyFile | null = null

  constructor(
    private readonly file: string,
    private readonly safeStorage: SafeStorageLike,
    private readonly platform: NodeJS.Platform = process.platform
  ) {}

  encryption(): AiKeyEncryption {
    if (!this.safeStorage.isEncryptionAvailable()) return 'none'
    if (this.platform === 'linux' && this.safeStorage.getSelectedStorageBackend() === 'basic_text')
      return 'plain'
    return 'os'
  }

  /** The decrypted key, or null when none is stored or the stored one cannot be decrypted. */
  getKey(id: SecretId): string | null {
    const cipher = this.read().keys[id]
    if (cipher === undefined) return null
    try {
      const key = this.safeStorage.decryptString(Buffer.from(cipher, 'base64'))
      return key.length > 0 ? key : null
    } catch (err) {
      console.warn(`Could not decrypt the stored ${id} key`, err)
      return null
    }
  }

  hasKey(id: SecretId): boolean {
    return this.getKey(id) !== null
  }

  getHint(id: SecretId): string | null {
    const key = this.getKey(id)
    return key === null ? null : maskKey(key)
  }

  /** Encrypts and stores the key; throws `AppError('IO')` before touching the file when it cannot be protected. */
  setKey(id: SecretId, key: string): void {
    if (this.encryption() === 'none') throw new AppError('IO', NO_SAFE_STORAGE_MESSAGE)
    const cipher = this.safeStorage.encryptString(key).toString('base64')
    const current = this.read()
    this.write({ ...current, keys: { ...current.keys, [id]: cipher } })
  }

  clearKey(id: SecretId): void {
    const current = this.read()
    if (!(id in current.keys)) return
    const { [id]: _removed, ...keys } = current.keys
    this.write({ ...current, keys })
  }

  private read(): KeyFile {
    if (this.cache) return this.cache
    this.cache = this.load()
    return this.cache
  }

  private load(): KeyFile {
    if (!fs.existsSync(this.file)) return EMPTY
    try {
      const parsed = KeyFile.safeParse(JSON.parse(fs.readFileSync(this.file, 'utf8')))
      if (parsed.success) return parsed.data
      console.warn(`Ignoring invalid key file at ${this.file}`)
    } catch (err) {
      console.warn(`Could not read key file at ${this.file}`, err)
    }
    return EMPTY
  }

  private write(next: KeyFile): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8')
    fs.renameSync(tmp, this.file)
    this.cache = next
  }
}
