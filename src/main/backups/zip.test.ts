import { describe, expect, it } from 'vitest'
import { ZipFormatError, readZip, readZipDirectory, zipBuffer } from './zip'

const text = Buffer.from('The ridge was empty when Mara reached it. '.repeat(50), 'utf8')
const image = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5])

describe('zip (F-8.4)', () => {
  it('round-trips deflated and stored entries with UTF-8 names', () => {
    const zip = zipBuffer([
      { name: 'project.db', data: text },
      { name: 'assets/backgrounds/Mära.png', data: image, store: true },
      { name: 'empty.txt', data: Buffer.alloc(0) }
    ])
    const entries = readZip(zip)
    expect(entries.map((e) => e.name)).toEqual([
      'project.db',
      'assets/backgrounds/Mära.png',
      'empty.txt'
    ])
    expect(entries[0]?.data.equals(text)).toBe(true)
    expect(entries[1]?.data.equals(image)).toBe(true)
    expect(entries[2]?.data.length).toBe(0)
  })

  it('deflates text and stores what it is told to store', () => {
    const directory = readZipDirectory(
      zipBuffer([
        { name: 'a.txt', data: text },
        { name: 'b.png', data: image, store: true }
      ])
    )
    expect(directory[0]?.method).toBe(8)
    expect(directory[0]?.compressedSize).toBeLessThan(text.length)
    expect(directory[1]?.method).toBe(0)
    expect(directory[1]?.compressedSize).toBe(image.length)
  })

  it('refuses something that is not a zip', () => {
    expect(() => readZip(Buffer.from('not a zip at all, just some words'))).toThrow(ZipFormatError)
    expect(() => readZip(Buffer.alloc(4))).toThrow(ZipFormatError)
  })

  it('refuses a truncated archive', () => {
    const zip = zipBuffer([{ name: 'a.txt', data: text }])
    expect(() => readZip(zip.subarray(0, zip.length - 10))).toThrow(ZipFormatError)
  })

  it('refuses an entry whose bytes fail the checksum', () => {
    const zip = zipBuffer([{ name: 'a.txt', data: Buffer.from('hello world'), store: true }])
    // The stored bytes start after the 30-byte local header and the 5-byte name.
    zip[35] = 'H'.charCodeAt(0)
    expect(() => readZip(zip)).toThrow(/checksum/)
  })

  it('refuses an entry that unpacks to more than its header says', () => {
    const zip = zipBuffer([{ name: 'a.txt', data: text }])
    const directory = readZipDirectory(zip)
    const centralStart = zip.length - 22 - (46 + 'a.txt'.length)
    expect(directory[0]?.size).toBe(text.length)
    zip.writeUInt32LE(10, centralStart + 24)
    expect(() => readZip(zip)).toThrow(ZipFormatError)
  })

  it('refuses an encrypted entry and an unknown method', () => {
    const encrypted = zipBuffer([{ name: 'a.txt', data: text }])
    const centralStart = encrypted.length - 22 - (46 + 'a.txt'.length)
    encrypted.writeUInt16LE(0x0801, centralStart + 8)
    expect(() => readZip(encrypted)).toThrow(/Encrypted/)
    const bzip = zipBuffer([{ name: 'a.txt', data: text }])
    bzip.writeUInt16LE(12, centralStart + 10)
    expect(() => readZip(bzip)).toThrow(/method 12/)
  })
})
