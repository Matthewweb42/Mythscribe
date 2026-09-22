import fs from 'node:fs'
import path from 'node:path'
import { createPrivateKey, generateKeyPairSync, sign, type JsonWebKey } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  base64urlEncode,
  encodeLicensePayload,
  formatLicenseToken,
  LICENSE_GRACE_MS,
  LICENSE_PUBLIC_KEY_JWK,
  LicensePublicKeyJwk,
  type LicenseClaims
} from '@shared/license'
import { verifyLicenseToken } from './licenseVerifier'

/**
 * F-15.9: the only place that decides whether a license is real. One keypair is generated here
 * (the Worker's is a secret and the shipped public key is a placeholder until the operator runs
 * keygen), plus the throwaway fixture the e2e fake Worker signs with, so both halves of the real
 * arrangement are exercised.
 */

const NOW = Date.parse('2026-09-21T12:00:00.000Z')
const claimsAt = (iat: number, sub = 'user-1'): LicenseClaims => ({
  v: 1,
  sub,
  iat,
  exp: iat + LICENSE_GRACE_MS
})

const keys = (): { publicJwk: LicensePublicKeyJwk; signer: ReturnType<typeof signWith> } => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const jwk = LicensePublicKeyJwk.parse(publicKey.export({ format: 'jwk' }))
  return { publicJwk: jwk, signer: signWith(privateKey) }
}

/** Signs claims exactly as the Worker does: Ed25519 over the encoded payload, both base64url. */
function signWith(privateKey: Parameters<typeof sign>[2]): (claims: LicenseClaims) => string {
  return (claims) => {
    const payload = encodeLicensePayload(claims)
    return formatLicenseToken(payload, new Uint8Array(sign(null, payload, privateKey)))
  }
}

describe('verifyLicenseToken (F-15.9)', () => {
  it('answers the claims of a token signed with the matching key', () => {
    const { publicJwk, signer } = keys()
    const claims = claimsAt(NOW - 60_000)
    expect(verifyLicenseToken(signer(claims), publicJwk, NOW)).toEqual(claims)
  })

  it('refuses a token that is past its expiry, however well it is signed', () => {
    const { publicJwk, signer } = keys()
    const claims = claimsAt(NOW - LICENSE_GRACE_MS - 1)
    expect(claims.exp).toBeLessThan(NOW)
    expect(verifyLicenseToken(signer(claims), publicJwk, NOW)).toBeNull()
    // The last millisecond of the grace period is over: `exp` itself no longer counts.
    const edge = claimsAt(NOW - LICENSE_GRACE_MS)
    expect(edge.exp).toBe(NOW)
    expect(verifyLicenseToken(signer(edge), publicJwk, NOW)).toBeNull()
    expect(verifyLicenseToken(signer(edge), publicJwk, NOW - 1)).toEqual(edge)
  })

  it('refuses a token signed with another key', () => {
    const first = keys()
    const second = keys()
    const token = second.signer(claimsAt(NOW - 60_000))
    expect(verifyLicenseToken(token, first.publicJwk, NOW)).toBeNull()
  })

  it('refuses tampered claims, a tampered signature, and anything malformed', () => {
    const { publicJwk, signer } = keys()
    const claims = claimsAt(NOW - 60_000)
    const token = signer(claims)
    const [payload, signature] = token.split('.')
    if (payload === undefined || signature === undefined) throw new Error('token has two parts')

    // Re-encoded claims with a later expiry, carrying the original signature.
    const stretched = base64urlEncode(encodeLicensePayload({ ...claims, exp: claims.exp + 1 }))
    expect(verifyLicenseToken(`${stretched}.${signature}`, publicJwk, NOW)).toBeNull()
    // The signature of another account's token, over these claims.
    const other = signer(claimsAt(NOW - 60_000, 'user-2')).split('.')[1]
    expect(verifyLicenseToken(`${payload}.${other ?? ''}`, publicJwk, NOW)).toBeNull()

    for (const bad of ['', '.', payload, `${payload}.`, `${payload}.not base64`, 'a.b.c', '{}']) {
      expect(verifyLicenseToken(bad, publicJwk, NOW)).toBeNull()
    }
  })

  it('verifies a token signed with the e2e fixture keypair', () => {
    const fixture = JSON.parse(
      fs.readFileSync(path.join(__dirname, '../../../e2e/fixtures/license-test-key.json'), 'utf8')
    ) as { privateKey: JsonWebKey; publicKey: JsonWebKey }
    const publicJwk = LicensePublicKeyJwk.parse(fixture.publicKey)
    const privateKey = createPrivateKey({ key: fixture.privateKey, format: 'jwk' })
    const claims = claimsAt(NOW - 60_000, 'e2e-user-1')
    expect(verifyLicenseToken(signWith(privateKey)(claims), publicJwk, NOW)).toEqual(claims)
  })

  it('verifies nothing while the shipped public key is the placeholder', () => {
    const { signer } = keys()
    const token = signer(claimsAt(NOW - 60_000))
    expect(verifyLicenseToken(token, LICENSE_PUBLIC_KEY_JWK, NOW)).toBeNull()
  })
})
