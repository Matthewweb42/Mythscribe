import fs from 'node:fs'
import zlib from 'node:zlib'

/**
 * A small zip writer and reader for backups (F-8.4), on `node:zlib` alone: stored (method 0) and
 * deflated (method 8) entries, UTF-8 names, no zip64, no encryption. That covers every archive
 * MythScribe writes, and the reader refuses anything else with a plain error rather than
 * guessing. Synchronous on purpose: the on-close backup has to finish before the database closes.
 */

export interface ZipEntryInput {
  /** Relative, `/`-separated. */
  name: string
  data: Buffer
  /** Store without compressing (an already-compressed image, say). */
  store?: boolean
}

export interface ZipEntry {
  name: string
  data: Buffer
}

export class ZipFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ZipFormatError'
  }
}

const LOCAL_SIG = 0x04034b50
const CENTRAL_SIG = 0x02014b50
const END_SIG = 0x06054b50
const END_SIZE = 22
const VERSION = 20
/** General-purpose flag bit 11: the name is UTF-8. */
const UTF8_FLAG = 0x0800
const ENCRYPTED_FLAG = 0x0001
const MAX_16 = 0xffff
const MAX_32 = 0xffffffff

/** MS-DOS date and time, local, 2-second resolution; dates before 1980 clamp to 1980. */
function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.max(1980, date.getFullYear())
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  }
}

/** The archive as bytes. Throws for more entries or bytes than a zip without zip64 can hold. */
export function zipBuffer(entries: readonly ZipEntryInput[], modified = new Date()): Buffer {
  if (entries.length > MAX_16) throw new ZipFormatError('Too many files for one backup')
  const { time, date } = dosDateTime(modified)
  const parts: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const crc = zlib.crc32(entry.data)
    const method = entry.store === true ? 0 : 8
    const body = method === 0 ? entry.data : zlib.deflateRawSync(entry.data)
    if (entry.data.length > MAX_32 || body.length > MAX_32 || offset > MAX_32) {
      throw new ZipFormatError('A file is too large for a backup')
    }
    const local = Buffer.alloc(30)
    local.writeUInt32LE(LOCAL_SIG, 0)
    local.writeUInt16LE(VERSION, 4)
    local.writeUInt16LE(UTF8_FLAG, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(entry.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)

    const header = Buffer.alloc(46)
    header.writeUInt32LE(CENTRAL_SIG, 0)
    header.writeUInt16LE(VERSION, 4)
    header.writeUInt16LE(VERSION, 6)
    header.writeUInt16LE(UTF8_FLAG, 8)
    header.writeUInt16LE(method, 10)
    header.writeUInt16LE(time, 12)
    header.writeUInt16LE(date, 14)
    header.writeUInt32LE(crc, 16)
    header.writeUInt32LE(body.length, 20)
    header.writeUInt32LE(entry.data.length, 24)
    header.writeUInt16LE(name.length, 28)
    // extra, comment, disk, internal and external attributes: all zero
    header.writeUInt32LE(offset, 42)

    parts.push(local, name, body)
    central.push(header, name)
    offset += local.length + name.length + body.length
  }
  const centralBytes = Buffer.concat(central)
  if (offset > MAX_32 || centralBytes.length > MAX_32) {
    throw new ZipFormatError('The backup is too large')
  }
  const end = Buffer.alloc(END_SIZE)
  end.writeUInt32LE(END_SIG, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralBytes.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...parts, centralBytes, end])
}

/** Writes the archive to `file`. The caller makes it atomic (a temp name, then a rename). */
export function writeZip(file: string, entries: readonly ZipEntryInput[], modified?: Date): void {
  fs.writeFileSync(file, zipBuffer(entries, modified))
}

/** One entry as the central directory describes it, before anything is unpacked. */
export interface ZipDirectoryEntry {
  name: string
  method: number
  crc: number
  compressedSize: number
  size: number
  localOffset: number
}

function findEnd(buffer: Buffer): number {
  const earliest = Math.max(0, buffer.length - END_SIZE - MAX_16)
  for (let at = buffer.length - END_SIZE; at >= earliest; at--) {
    if (buffer.readUInt32LE(at) === END_SIG) return at
  }
  throw new ZipFormatError('Not a zip file')
}

/** The central directory: names and sizes, so a caller can refuse an archive before unpacking it. */
export function readZipDirectory(buffer: Buffer): ZipDirectoryEntry[] {
  if (buffer.length < END_SIZE) throw new ZipFormatError('Not a zip file')
  const end = findEnd(buffer)
  const count = buffer.readUInt16LE(end + 10)
  const size = buffer.readUInt32LE(end + 12)
  const start = buffer.readUInt32LE(end + 16)
  if (count === MAX_16 || size === MAX_32 || start === MAX_32) {
    throw new ZipFormatError('This zip format (zip64) is not supported')
  }
  if (start + size > end) throw new ZipFormatError('The zip file is damaged')
  const entries: ZipDirectoryEntry[] = []
  let at = start
  for (let i = 0; i < count; i++) {
    if (at + 46 > end || buffer.readUInt32LE(at) !== CENTRAL_SIG) {
      throw new ZipFormatError('The zip file is damaged')
    }
    const flags = buffer.readUInt16LE(at + 8)
    const method = buffer.readUInt16LE(at + 10)
    const crc = buffer.readUInt32LE(at + 16)
    const compressedSize = buffer.readUInt32LE(at + 20)
    const entrySize = buffer.readUInt32LE(at + 24)
    const nameLength = buffer.readUInt16LE(at + 28)
    const extraLength = buffer.readUInt16LE(at + 30)
    const commentLength = buffer.readUInt16LE(at + 32)
    const localOffset = buffer.readUInt32LE(at + 42)
    if ((flags & ENCRYPTED_FLAG) !== 0) throw new ZipFormatError('Encrypted zips are not supported')
    if (method !== 0 && method !== 8) {
      throw new ZipFormatError(`This zip compression (method ${method}) is not supported`)
    }
    if (compressedSize === MAX_32 || entrySize === MAX_32 || localOffset === MAX_32) {
      throw new ZipFormatError('This zip format (zip64) is not supported')
    }
    const nameEnd = at + 46 + nameLength
    if (nameEnd > end) throw new ZipFormatError('The zip file is damaged')
    const name = buffer.toString('utf8', at + 46, nameEnd)
    entries.push({ name, method, crc, compressedSize, size: entrySize, localOffset })
    at = nameEnd + extraLength + commentLength
  }
  return entries
}

/** Unpacks one entry, checking its size and checksum against the directory. */
export function readZipEntry(buffer: Buffer, entry: ZipDirectoryEntry): Buffer {
  const at = entry.localOffset
  if (at + 30 > buffer.length || buffer.readUInt32LE(at) !== LOCAL_SIG) {
    throw new ZipFormatError('The zip file is damaged')
  }
  const dataStart = at + 30 + buffer.readUInt16LE(at + 26) + buffer.readUInt16LE(at + 28)
  const dataEnd = dataStart + entry.compressedSize
  if (dataEnd > buffer.length) throw new ZipFormatError('The zip file is damaged')
  const body = buffer.subarray(dataStart, dataEnd)
  let data: Buffer
  if (entry.method === 0) {
    data = Buffer.from(body)
  } else {
    try {
      // One byte over the declared size, so a lying header shows as a size mismatch below
      // instead of inflating without bound.
      data = zlib.inflateRawSync(body, { maxOutputLength: Math.max(1, entry.size + 1) })
    } catch {
      throw new ZipFormatError(`The zip file is damaged (${entry.name})`)
    }
  }
  if (data.length !== entry.size)
    throw new ZipFormatError(`The zip file is damaged (${entry.name})`)
  if (zlib.crc32(data) !== entry.crc) {
    throw new ZipFormatError(`The zip file is damaged (${entry.name} fails its checksum)`)
  }
  return data
}

/** Every file entry (directories left out), unpacked and checked. */
export function readZip(buffer: Buffer): ZipEntry[] {
  return readZipDirectory(buffer)
    .filter((entry) => !entry.name.endsWith('/'))
    .map((entry) => ({ name: entry.name, data: readZipEntry(buffer, entry) }))
}
