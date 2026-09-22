import { describe, expect, it } from 'vitest'
import {
  ACCENTS,
  ACCENT_IDS,
  base64urlDecode,
  base64urlEncode,
  encodeLicensePayload,
  formatLicenseToken,
  LICENSE_GRACE_MS,
  LICENSE_PUBLIC_KEY_JWK,
  type LicenseClaims,
  licensePublicKey,
  parseLicenseToken
} from './license'

const claims: LicenseClaims = { v: 1, sub: 'user-1', iat: 1_000, exp: 1_000 + LICENSE_GRACE_MS }

describe('base64url', () => {
  it('round-trips bytes without padding or URL-unsafe characters', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255])
    const text = base64urlEncode(bytes)
    expect(text).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(base64urlDecode(text)).toEqual(bytes)
  })

  it('refuses padding, standard base64 characters, and the empty string', () => {
    expect(base64urlDecode('')).toBeNull()
    expect(base64urlDecode('ab==')).toBeNull()
    expect(base64urlDecode('a+b/')).toBeNull()
  })
})

describe('parseLicenseToken', () => {
  it('decodes the claims and keeps the exact signed bytes', () => {
    const payload = encodeLicensePayload(claims)
    const signature = new Uint8Array([9, 8, 7])
    const parsed = parseLicenseToken(formatLicenseToken(payload, signature))
    expect(parsed).not.toBeNull()
    expect(parsed?.claims).toEqual(claims)
    expect(parsed?.payload).toEqual(payload)
    expect(parsed?.signature).toEqual(signature)
  })

  it('answers null for anything that is not two segments of well-formed claims', () => {
    const payload = encodeLicensePayload(claims)
    const good = formatLicenseToken(payload, new Uint8Array([1]))
    expect(parseLicenseToken('')).toBeNull()
    expect(parseLicenseToken('one')).toBeNull()
    expect(parseLicenseToken(`${good}.extra`)).toBeNull()
    expect(parseLicenseToken(`${base64urlEncode(new TextEncoder().encode('{'))}.AQ`)).toBeNull()
    const wrongVersion = encodeLicensePayload({ ...claims, v: 2 as unknown as 1 })
    expect(parseLicenseToken(formatLicenseToken(wrongVersion, new Uint8Array([1])))).toBeNull()
    const noSub = new TextEncoder().encode(JSON.stringify({ v: 1, iat: 1, exp: 2 }))
    expect(parseLicenseToken(formatLicenseToken(noSub, new Uint8Array([1])))).toBeNull()
  })
})

describe('licensePublicKey', () => {
  it('uses the embedded key unless the override is a readable Ed25519 JWK', () => {
    expect(licensePublicKey({})).toBe(LICENSE_PUBLIC_KEY_JWK)
    expect(licensePublicKey({ MYTHSCRIBE_LICENSE_PUBLIC_KEY: '  ' })).toBe(LICENSE_PUBLIC_KEY_JWK)
    expect(licensePublicKey({ MYTHSCRIBE_LICENSE_PUBLIC_KEY: '{not json' })).toBe(
      LICENSE_PUBLIC_KEY_JWK
    )
    expect(
      licensePublicKey({ MYTHSCRIBE_LICENSE_PUBLIC_KEY: JSON.stringify({ kty: 'RSA', n: 'x' }) })
    ).toBe(LICENSE_PUBLIC_KEY_JWK)
    const jwk = { kty: 'OKP', crv: 'Ed25519', x: 'abc' }
    expect(licensePublicKey({ MYTHSCRIBE_LICENSE_PUBLIC_KEY: JSON.stringify(jwk) })).toEqual(jwk)
  })
})

describe('ACCENTS', () => {
  it('has one preset per id, default first, each with three hex colours', () => {
    expect(ACCENTS.map((preset) => preset.id)).toEqual([...ACCENT_IDS])
    expect(ACCENTS[0]?.id).toBe('default')
    for (const preset of ACCENTS) {
      for (const colour of [preset.accent, preset.hover, preset.fg]) {
        expect(colour).toMatch(/^#[0-9a-f]{6}$/)
      }
    }
  })
})
