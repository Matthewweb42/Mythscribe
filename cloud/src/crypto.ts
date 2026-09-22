/**
 * Token and digest helpers for the account routes (F-15.2), the webhook HMAC (F-15.3), and the
 * Supporter license signature (F-15.9). Web Crypto only, so the same code runs in the Worker
 * runtime and under Node in the unit tests.
 */

const encoder = new TextEncoder()

function base64url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** A URL-safe random token with `bytes` bytes of entropy (attempt ids, secrets, session tokens). */
export function randomToken(bytes: number): string {
  const buffer = new Uint8Array(bytes)
  crypto.getRandomValues(buffer)
  return base64url(buffer)
}

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** Lower-case hex SHA-256; every secret is stored as this digest, never in the clear. */
export async function sha256Hex(value: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', encoder.encode(value)))
}

/**
 * Lower-case hex HMAC-SHA256 (F-15.3): how Lemon Squeezy signs a webhook body with the shared
 * secret. Compare the result with `timingSafeEqualHex`, never with `===`.
 */
export async function hmacSha256Hex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  return hex(await crypto.subtle.sign('HMAC', key, encoder.encode(body)))
}

/**
 * The Supporter license signing key (F-15.9): the private half of the Ed25519 pair, exactly as the
 * `LICENSE_SIGNING_KEY` secret carries it. `crypto.subtle` speaks Ed25519 in the Worker runtime and
 * under Node in the tests, so signing a license needs no library. Not extractable: the Worker only
 * ever signs with it.
 */
export function importSigningKey(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey('jwk', jwk, { name: 'Ed25519' }, false, ['sign'])
}

/**
 * The Ed25519 signature over exactly `bytes` (the token's payload segment). The caller pairs it
 * with the payload through `formatLicenseToken`, so the app verifies the same bytes.
 */
export async function signEd25519(key: CryptoKey, bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.sign('Ed25519', key, bytes))
}

/** Constant-time comparison of two hex digests; false as soon as the lengths differ. */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}
