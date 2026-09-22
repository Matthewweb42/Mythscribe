import { createPublicKey, verify, type KeyObject } from 'node:crypto'
import { parseLicenseToken, type LicenseClaims, type LicensePublicKeyJwk } from '@shared/license'

/**
 * Verifies a Supporter license token (F-15.9) against the Worker's public key. The only place in
 * the app that decides whether a license is real: everything else reads the claims this answers.
 *
 * Nothing here reaches the network or the disk, so the extras keep working offline for as long as
 * the token says they may (`exp`, 14 days from the last refresh). A token that is malformed,
 * signed with another key, or past its expiry is null — there is no partial trust.
 */
export function verifyLicenseToken(
  token: string,
  publicJwk: LicensePublicKeyJwk,
  now: number
): LicenseClaims | null {
  const parsed = parseLicenseToken(token)
  if (parsed === null) return null
  // Checked before the signature: an expired token is worth nothing however well it is signed.
  if (parsed.claims.exp <= now) return null
  const key = publicKeyOf(publicJwk)
  if (key === null) return null
  try {
    return verify(null, parsed.payload, key, parsed.signature) ? parsed.claims : null
  } catch {
    // A key of the wrong type for Ed25519, or a signature of the wrong length.
    return null
  }
}

/**
 * The JWK as a key object, or null when it is not usable — which is what a build carrying the
 * placeholder key in `license.ts` has, so such a build simply never sees a license.
 */
function publicKeyOf(publicJwk: LicensePublicKeyJwk): KeyObject | null {
  try {
    return createPublicKey({ key: publicJwk, format: 'jwk' })
  } catch {
    return null
  }
}
