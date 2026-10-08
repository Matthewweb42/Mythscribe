import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { assetPathFor, bookFontPathFor } from './assetUrl'

const root = path.join('/', 'projects', 'Book.mythscribe')
const dir = path.join(root, 'assets', 'backgrounds')
const entitiesDir = path.join(root, 'assets', 'entities')

describe('assetPathFor (F-6.2)', () => {
  it('resolves a background file name inside the project folder', () => {
    expect(assetPathFor(root, 'mythscribe-asset://backgrounds/a1.png')).toBe(
      path.join(dir, 'a1.png')
    )
    expect(assetPathFor(root, 'mythscribe-asset://backgrounds/a%20b.JPG')).toBe(
      path.join(dir, 'a b.JPG')
    )
  })

  it('resolves an entity image in its own folder (F-9.3)', () => {
    expect(assetPathFor(root, 'mythscribe-asset://entities/Mara.0a1b2c3d.png')).toBe(
      path.join(entitiesDir, 'Mara.0a1b2c3d.png')
    )
    expect(assetPathFor(root, 'mythscribe-asset://entities/..%2Fa.png')).toBeNull()
    expect(assetPathFor(root, 'mythscribe-asset://entities/notes.txt')).toBeNull()
  })

  it('resolves a pinned reference image in its own folder (F-9.6)', () => {
    expect(assetPathFor(root, 'mythscribe-asset://references/Harbor-Map.0a1b2c3d.png')).toBe(
      path.join(root, 'assets', 'references', 'Harbor-Map.0a1b2c3d.png')
    )
    expect(assetPathFor(root, 'mythscribe-asset://references/..%2Fa.png')).toBeNull()
  })

  it('refuses another scheme, host, or a nested path', () => {
    expect(assetPathFor(root, 'file:///etc/passwd')).toBeNull()
    expect(assetPathFor(root, 'mythscribe-asset://other/a1.png')).toBeNull()
    expect(assetPathFor(root, 'mythscribe-asset://backgrounds/sub/a1.png')).toBeNull()
    expect(assetPathFor(root, 'mythscribe-asset://backgrounds/')).toBeNull()
    expect(assetPathFor(root, 'mythscribe-asset://backgrounds')).toBeNull()
    expect(assetPathFor(root, 'not a url')).toBeNull()
  })

  it('refuses anything that could escape the folder', () => {
    expect(assetPathFor(root, 'mythscribe-asset://backgrounds/..')).toBeNull()
    expect(assetPathFor(root, 'mythscribe-asset://backgrounds/%2e%2e%2fproject.db')).toBeNull()
    expect(assetPathFor(root, 'mythscribe-asset://backgrounds/..%5cproject.db')).toBeNull()
    expect(assetPathFor(root, 'mythscribe-asset://backgrounds/..%2Fa.png')).toBeNull()
    expect(assetPathFor(root, 'mythscribe-asset://backgrounds/a%00.png')).toBeNull()
  })

  it('refuses an unknown extension, even inside the folder', () => {
    expect(assetPathFor(root, 'mythscribe-asset://backgrounds/project.db')).toBeNull()
    expect(assetPathFor(root, 'mythscribe-asset://backgrounds/a1.svg')).toBeNull()
    expect(assetPathFor(root, 'mythscribe-asset://backgrounds/a1')).toBeNull()
  })
})

describe('bookFontPathFor (Compile v2 preview fonts)', () => {
  const fonts = path.join('/', 'app', 'resources', 'fonts')

  it('resolves a shipped font file under the fonts folder', () => {
    expect(
      bookFontPathFor(
        fonts,
        'mythscribe-asset://book-fonts/eb-garamond/eb-garamond-latin-400-normal.woff2'
      )
    ).toBe(path.join(fonts, 'eb-garamond', 'eb-garamond-latin-400-normal.woff2'))
    expect(
      bookFontPathFor(
        fonts,
        'mythscribe-asset://book-fonts/liberation-serif/LiberationSerif-Regular.ttf'
      )
    ).toBe(path.join(fonts, 'liberation-serif', 'LiberationSerif-Regular.ttf'))
  })

  it('refuses anything that is not a listed font file', () => {
    expect(bookFontPathFor(fonts, 'mythscribe-asset://book-fonts/eb-garamond/OFL.txt')).toBeNull()
    expect(
      bookFontPathFor(fonts, 'mythscribe-asset://book-fonts/..%2Feb-garamond/x.woff2')
    ).toBeNull()
    expect(bookFontPathFor(fonts, 'mythscribe-asset://covers/a.png')).toBeNull()
    expect(
      bookFontPathFor(
        fonts,
        'mythscribe-asset://book-fonts/eb-garamond/eb-garamond-latin-400-normal.woff2/x'
      )
    ).toBeNull()
  })
})
