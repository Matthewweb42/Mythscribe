import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { IMAGE_MAX_BYTES } from '@shared/assets'
import { addImageAsset, assetDir, removeImageAsset } from './imageAssets'

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
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-assets-'))
  folder = path.join(tmp, 'Book.mythscribe')
  fs.mkdirSync(folder, { recursive: true })
})
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('addImageAsset (F-9.3)', () => {
  it('creates the folder, copies the file under a minted name, and leaves the source', () => {
    const dir = assetDir(folder, 'entities')
    expect(dir).toBe(path.join(folder, 'assets', 'entities'))
    expect(fs.existsSync(dir)).toBe(false)
    const file = addImageAsset(folder, 'entities', source('Mara Vell.PNG'), 'image')
    expect(file).toMatch(/^Mara-Vell\.[0-9a-f]{8}\.png$/)
    expect(fs.readFileSync(path.join(dir, file))).toEqual(PNG)
    expect(fs.existsSync(source('Mara Vell.PNG'))).toBe(true)
  })

  it('keeps two copies of one image apart and serves each folder on its own', () => {
    const a = addImageAsset(folder, 'entities', source('portrait.png'), 'image')
    const b = addImageAsset(folder, 'entities', source('portrait.png'), 'image')
    expect(a).not.toBe(b)
    const c = addImageAsset(folder, 'backgrounds', source('portrait.png'), 'background')
    expect(fs.readdirSync(assetDir(folder, 'entities')).sort()).toEqual([a, b].sort())
    expect(fs.readdirSync(assetDir(folder, 'backgrounds'))).toEqual([c])
  })

  it('falls back to the given stem when nothing of the original survives', () => {
    expect(addImageAsset(folder, 'entities', source('???.png'), 'image')).toMatch(
      /^image\.[0-9a-f]{8}\.png$/
    )
  })

  it('refuses a type outside the allowed list, a file over the limit, and a missing one', () => {
    expect(() => addImageAsset(folder, 'entities', source('vector.svg'), 'image')).toThrowError(
      expect.objectContaining({
        code: 'VALIDATION',
        message: 'vector.svg is not an image MythScribe can use (png, jpg, jpeg, webp, gif)'
      })
    )
    const big = source('big.png', Buffer.alloc(IMAGE_MAX_BYTES + 1))
    expect(() => addImageAsset(folder, 'entities', big, 'image')).toThrowError(
      expect.objectContaining({ code: 'VALIDATION', message: 'big.png is larger than 20 MB' })
    )
    expect(() =>
      addImageAsset(folder, 'entities', path.join(tmp, 'absent.png'), 'image')
    ).toThrowError(expect.objectContaining({ code: 'NOT_FOUND' }))
    const asFolder = path.join(tmp, 'folder.png')
    fs.mkdirSync(asFolder)
    expect(() => addImageAsset(folder, 'entities', asFolder, 'image')).toThrowError(
      expect.objectContaining({ code: 'VALIDATION', message: 'folder.png is not a file' })
    )
    expect(fs.existsSync(assetDir(folder, 'entities'))).toBe(false)
  })

  it('accepts a file exactly at the limit', () => {
    const exact = source('exact.png', Buffer.alloc(IMAGE_MAX_BYTES))
    expect(addImageAsset(folder, 'entities', exact, 'image')).toMatch(/\.png$/)
  })
})

describe('removeImageAsset (F-9.3)', () => {
  it('deletes the file and ignores one that is already gone', () => {
    const file = addImageAsset(folder, 'entities', source('a.png'), 'image')
    const other = addImageAsset(folder, 'entities', source('b.png'), 'image')
    removeImageAsset(folder, 'entities', file)
    expect(fs.readdirSync(assetDir(folder, 'entities'))).toEqual([other])
    removeImageAsset(folder, 'entities', file)
    removeImageAsset(folder, 'entities', 'never-stored.png')
    expect(fs.readdirSync(assetDir(folder, 'entities'))).toEqual([other])
  })

  it('refuses a name that could reach outside the folder, deleting nothing', () => {
    const outside = path.join(folder, 'project.db')
    fs.writeFileSync(outside, 'x')
    for (const bad of ['', '.', '..', '../project.db', '..\\project.db', 'sub/a.png', 'a\0.png']) {
      expect(() => removeImageAsset(folder, 'entities', bad)).toThrowError(
        expect.objectContaining({ code: 'VALIDATION' })
      )
    }
    expect(fs.existsSync(outside)).toBe(true)
  })
})
