import { describe, expect, it } from 'vitest'
import {
  BACKGROUND_EXTENSIONS,
  FocusSettings,
  backgroundExtension,
  backgroundUrl,
  defaultFocusSettings,
  backgroundDisplayName,
  backgroundFileName,
  clampInt,
  OVERLAY_WIDTH
} from './focus'

describe('FocusSettings (F-6.2)', () => {
  it('defaults to no background and fills the field into an older row', () => {
    expect(defaultFocusSettings().backgroundId).toBeNull()
    expect(FocusSettings.parse({})).toEqual(defaultFocusSettings())
    expect(FocusSettings.parse({ backgroundId: 'abc' })).toEqual({
      ...defaultFocusSettings(),
      backgroundId: 'abc'
    })
  })

  it('refuses a non-string id', () => {
    expect(FocusSettings.safeParse({ backgroundId: 3 }).success).toBe(false)
  })
})

describe('backgroundExtension', () => {
  it('answers the lower-cased extension for every allowed type, any case', () => {
    for (const ext of BACKGROUND_EXTENSIONS) {
      expect(backgroundExtension(`photo.${ext}`)).toBe(ext)
      expect(backgroundExtension(`PHOTO.${ext.toUpperCase()}`)).toBe(ext)
    }
  })

  it('answers null for other types, no extension, or a dot-file', () => {
    expect(backgroundExtension('notes.txt')).toBeNull()
    expect(backgroundExtension('archive.tar.gz')).toBeNull()
    expect(backgroundExtension('README')).toBeNull()
    expect(backgroundExtension('.png')).toBeNull()
  })
})

describe('backgroundUrl', () => {
  it('builds the asset URL and escapes the file name', () => {
    expect(backgroundUrl('a1.png')).toBe('mythscribe-asset://backgrounds/a1.png')
    expect(backgroundUrl('a b.png')).toBe('mythscribe-asset://backgrounds/a%20b.png')
  })
})

describe('background names (F-6.2)', () => {
  it('keeps a recognisable stem, a short id, and the lower-cased extension', () => {
    expect(backgroundFileName('Sunset over harbor.PNG', 'abcdef12')).toBe(
      'Sunset-over-harbor.abcdef12.png'
    )
    expect(backgroundFileName('../weird name!!.jpeg', '01234567')).toBe('weird-name.01234567.jpeg')
    expect(backgroundFileName('.png', '01234567')).toBe('background.01234567.png')
    expect(backgroundFileName('x'.repeat(60) + '.webp', 'deadbeef')).toBe(
      `${'x'.repeat(40)}.deadbeef.webp`
    )
  })

  it('shows the file without its id, and a file without one as it is', () => {
    expect(backgroundDisplayName('Sunset-over-harbor.abcdef12.png')).toBe('Sunset-over-harbor.png')
    expect(backgroundDisplayName('a.png')).toBe('a.png')
    expect(backgroundDisplayName('notes.v2.abcdef12.jpg')).toBe('notes.v2.jpg')
  })
})

describe('rotation and overlay (F-6.3, F-6.4)', () => {
  it('fills a row written before them with the defaults, and keeps what is there', () => {
    expect(FocusSettings.parse({ backgroundId: 'a' })).toEqual({
      ...defaultFocusSettings(),
      backgroundId: 'a'
    })
    expect(
      FocusSettings.parse({
        backgroundId: null,
        rotation: { enabled: true, intervalMinutes: 12 },
        overlay: { darkness: 5, width: 100 }
      })
    ).toEqual({
      backgroundId: null,
      rotation: { enabled: true, intervalMinutes: 12 },
      overlay: { darkness: 5, width: 100 }
    })
  })

  it('refuses values outside the ranges and clamps for the controls', () => {
    expect(FocusSettings.safeParse({ overlay: { darkness: 101, width: 70 } }).success).toBe(false)
    expect(FocusSettings.safeParse({ overlay: { darkness: 0, width: 34 } }).success).toBe(false)
    expect(
      FocusSettings.safeParse({ rotation: { enabled: true, intervalMinutes: 0 } }).success
    ).toBe(false)
    expect(clampInt(120, OVERLAY_WIDTH)).toBe(100)
    expect(clampInt(10.6, OVERLAY_WIDTH)).toBe(35)
    expect(clampInt(Number.NaN, OVERLAY_WIDTH)).toBe(35)
    expect(clampInt(49.5, OVERLAY_WIDTH)).toBe(50)
  })
})
