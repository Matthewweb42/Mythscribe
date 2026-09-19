import { describe, expect, it } from 'vitest'
import { randomToken, sha256Hex, timingSafeEqualHex } from './crypto'

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
