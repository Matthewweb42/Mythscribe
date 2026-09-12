import type { SafeStorageLike } from './keyStore'

/** A safe storage that really transforms the text (reversed, then bytes) so the file round-trips. */
export function fakeSafeStorage(
  overrides: Partial<SafeStorageLike> = {}
): SafeStorageLike & { encrypted: string[] } {
  const encrypted: string[] = []
  return {
    encrypted,
    isEncryptionAvailable: () => true,
    encryptString(plain) {
      encrypted.push(plain)
      return Buffer.from(`v1:${[...plain].reverse().join('')}`)
    },
    decryptString(buffer) {
      const text = buffer.toString('utf8')
      if (!text.startsWith('v1:')) throw new Error('Decryption failed')
      return [...text.slice(3)].reverse().join('')
    },
    getSelectedStorageBackend: () => 'gnome_libsecret',
    ...overrides
  }
}
