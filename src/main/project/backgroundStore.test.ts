import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BACKGROUND_MAX_BYTES } from '@shared/focus'
import { addBackground, backgroundsDir, listBackgrounds, removeBackground } from './backgroundStore'

let tmp: string
let folder: string

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGMwTpsJAAICATNWh+JUAAAAAElFTkSuQmCC',
  'base64'
)

function source(name: string, bytes: Buffer = PNG): string {
  const file = path.join(tmp, name)
  fs.writeFileSync(file, bytes)
  return file
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-backgrounds-'))
  folder = path.join(tmp, 'Book.mythscribe')
  fs.mkdirSync(path.join(folder, 'assets'), { recursive: true })
})
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('backgroundStore (F-6.2)', () => {
  it('lists nothing before the folder exists and creates it on the first add', () => {
    expect(fs.existsSync(backgroundsDir(folder))).toBe(false)
    expect(listBackgrounds(folder)).toEqual([])
    const added = addBackground(folder, source('Sunset.PNG'))
    expect(added.name).toBe('Sunset.png')
    expect(added.id).toMatch(/^Sunset\.[0-9a-f]{8}$/)
    expect(added.url).toBe(`mythscribe-asset://backgrounds/${added.id}.png`)
    expect(fs.readFileSync(path.join(backgroundsDir(folder), `${added.id}.png`))).toEqual(PNG)
    expect(fs.existsSync(source('Sunset.PNG'))).toBe(true) // copied, not moved
    expect(listBackgrounds(folder)).toEqual([added])
  })

  it('lists the folder by file name and ignores non-image entries', () => {
    const a = addBackground(folder, source('a.jpg'))
    const b = addBackground(folder, source('b.webp'))
    const c = addBackground(folder, source('c.gif'))
    fs.writeFileSync(path.join(backgroundsDir(folder), 'notes.txt'), 'x')
    fs.mkdirSync(path.join(backgroundsDir(folder), 'sub.png'))
    const expected = [a, b, c].sort((x, y) => x.name.localeCompare(y.name))
    expect(listBackgrounds(folder)).toEqual(expected)
  })

  it('refuses a type outside the allowed list with VALIDATION and copies nothing', () => {
    expect(() => addBackground(folder, source('vector.svg'))).toThrowError(
      expect.objectContaining({
        code: 'VALIDATION',
        message: 'vector.svg is not an image MythScribe can use (png, jpg, jpeg, webp, gif)'
      })
    )
    expect(() => addBackground(folder, source('README'))).toThrowError(
      expect.objectContaining({ code: 'VALIDATION' })
    )
    expect(listBackgrounds(folder)).toEqual([])
  })

  it('refuses a file over the size limit with VALIDATION and a missing one with NOT_FOUND', () => {
    const big = source('big.png', Buffer.alloc(BACKGROUND_MAX_BYTES + 1))
    expect(() => addBackground(folder, big)).toThrowError(
      expect.objectContaining({ code: 'VALIDATION', message: 'big.png is larger than 20 MB' })
    )
    expect(() => addBackground(folder, path.join(tmp, 'absent.png'))).toThrowError(
      expect.objectContaining({ code: 'NOT_FOUND' })
    )
    expect(listBackgrounds(folder)).toEqual([])
  })

  it('accepts a file exactly at the limit', () => {
    const exact = source('exact.png', Buffer.alloc(BACKGROUND_MAX_BYTES))
    expect(addBackground(folder, exact).name).toMatch(/\.png$/)
  })

  it('removes by id and reports an unknown id as NOT_FOUND', () => {
    const a = addBackground(folder, source('a.png'))
    const b = addBackground(folder, source('b.png'))
    removeBackground(folder, a.id)
    expect(listBackgrounds(folder)).toEqual([b])
    expect(fs.existsSync(path.join(backgroundsDir(folder), `${a.id}.png`))).toBe(false)
    expect(() => removeBackground(folder, a.id)).toThrowError(
      expect.objectContaining({ code: 'NOT_FOUND' })
    )
    expect(() => removeBackground(folder, '../project.db')).toThrowError(
      expect.objectContaining({ code: 'NOT_FOUND' })
    )
  })
})
