import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { assetPathFor } from './assetUrl'

const root = path.join('/', 'projects', 'Book.mythscribe')
const dir = path.join(root, 'assets', 'backgrounds')

describe('assetPathFor (F-6.2)', () => {
  it('resolves a background file name inside the project folder', () => {
    expect(assetPathFor(root, 'mythscribe-asset://backgrounds/a1.png')).toBe(
      path.join(dir, 'a1.png')
    )
    expect(assetPathFor(root, 'mythscribe-asset://backgrounds/a%20b.JPG')).toBe(
      path.join(dir, 'a b.JPG')
    )
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
