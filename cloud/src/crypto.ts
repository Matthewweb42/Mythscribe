/**
 * Token and digest helpers for the account routes (F-15.2). Web Crypto only, so the same code
 * runs in the Worker runtime and under Node in the unit tests.
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

/** Lower-case hex SHA-256; every secret is stored as this digest, never in the clear. */
export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** Constant-time comparison of two hex digests; false as soon as the lengths differ. */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}
