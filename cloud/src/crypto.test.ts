import { describe, expect, it } from 'vitest'
import { hmacSha256Hex, randomToken, sha256Hex, timingSafeEqualHex } from './crypto'

describe('randomToken', () => {
  it('is url-safe and different every time', () => {
    const first = randomToken(32)
    const second = randomToken(32)
    expect(first).not.toEqual(second)
    expect(first).toMatch(/^[A-Za-z0-9_-]+$/)
    // 32 bytes as unpadded base64: 43 characters.
    expect(first).toHaveLength(43)
  })
})

describe('sha256Hex', () => {
  it('matches the known digest of a known string', async () => {
    expect(await sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    )
  })

  it('is stable and differs per input', async () => {
    expect(await sha256Hex('token')).toBe(await sha256Hex('token'))
    expect(await sha256Hex('token')).not.toBe(await sha256Hex('token '))
    expect(await sha256Hex('token')).toHaveLength(64)
  })
})

describe('timingSafeEqualHex', () => {
  it('compares equal digests', async () => {
    const digest = await sha256Hex('secret')
    expect(timingSafeEqualHex(digest, digest)).toBe(true)
  })

  it('rejects a different digest and a different length', async () => {
    expect(timingSafeEqualHex(await sha256Hex('a'), await sha256Hex('b'))).toBe(false)
    expect(timingSafeEqualHex('abcd', 'abc')).toBe(false)
  })
})

describe('hmacSha256Hex', () => {
  it('matches the published HMAC-SHA256 test vector', async () => {
    expect(await hmacSha256Hex('key', 'The quick brown fox jumps over the lazy dog')).toBe(
      'f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8'
    )
  })

  it('changes with the secret and with the body', async () => {
    const signature = await hmacSha256Hex('secret', '{"a":1}')
    expect(await hmacSha256Hex('other', '{"a":1}')).not.toBe(signature)
    expect(await hmacSha256Hex('secret', '{"a":2}')).not.toBe(signature)
    expect(signature).toHaveLength(64)
  })
})
