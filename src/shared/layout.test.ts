import { describe, expect, it } from 'vitest'
import {
  LAYOUT_LIMITS,
  Layout,
  StoredLayout,
  TAG_BAR_MIN_HEIGHT,
  clampForEditorMin,
  clampPanel,
  clampTagBarHeight,
  defaultLayout,
  editorFraction,
  fitsEditorMin,
  normalizeLayout
} from './layout'

describe('defaultLayout', () => {
  it('passes the schema and leaves at least the editor minimum with both panels open', () => {
    const layout = defaultLayout()
    expect(Layout.parse(layout)).toEqual(layout)
    expect(1 - layout.sidebar.size - layout.notes.size).toBeGreaterThanOrEqual(
      LAYOUT_LIMITS.editorMin
    )
  })

  it('returns a fresh object each time', () => {
    expect(defaultLayout()).not.toBe(defaultLayout())
    expect(defaultLayout().tagBar).not.toBe(defaultLayout().tagBar)
  })

  it('opens the tag bar at 120 px (F-4.4)', () => {
    expect(defaultLayout().tagBar).toEqual({ open: true, height: 120 })
  })
})

describe('Layout schema', () => {
  it('refuses sizes outside the panel limits', () => {
    const base = defaultLayout()
    expect(
      Layout.safeParse({ ...base, sidebar: { open: true, size: 0.1, tab: 'manuscript' } }).success
    ).toBe(false)
    expect(
      Layout.safeParse({ ...base, sidebar: { open: true, size: 0.36, tab: 'manuscript' } }).success
    ).toBe(false)
    expect(Layout.safeParse({ ...base, notes: { open: false, size: 0.51 } }).success).toBe(false)
    expect(Layout.safeParse({ ...base, notes: { open: false, size: 0.5 } }).success).toBe(true)
  })

  it('refuses a tag bar under its floor and has no static ceiling (F-4.4)', () => {
    const base = defaultLayout()
    expect(Layout.safeParse({ ...base, tagBar: { open: true, height: 99 } }).success).toBe(false)
    expect(Layout.safeParse({ ...base, tagBar: { open: true, height: 100 } }).success).toBe(true)
    expect(Layout.safeParse({ ...base, tagBar: { open: false, height: 2000 } }).success).toBe(true)
    const { tagBar: _dropped, ...withoutTagBar } = base
    expect(Layout.safeParse(withoutTagBar).success).toBe(false)
  })

  it('StoredLayout defaults a pre-F-4.4 layout to the default tag bar', () => {
    const { tagBar: _dropped, ...withoutTagBar } = defaultLayout()
    expect(StoredLayout.parse(withoutTagBar)).toEqual(defaultLayout())
  })
})

describe('clampTagBarHeight', () => {
  it('clamps to the floor and to 60 % of the window height', () => {
    expect(clampTagBarHeight(50, 1000)).toBe(TAG_BAR_MIN_HEIGHT)
    expect(clampTagBarHeight(100, 1000)).toBe(100)
    expect(clampTagBarHeight(300, 1000)).toBe(300)
    expect(clampTagBarHeight(700, 1000)).toBe(600)
    expect(clampTagBarHeight(600, 1000)).toBe(600)
  })

  it('never puts the ceiling under the floor on a tiny window', () => {
    expect(clampTagBarHeight(150, 100)).toBe(TAG_BAR_MIN_HEIGHT)
    expect(clampTagBarHeight(100, 100)).toBe(TAG_BAR_MIN_HEIGHT)
  })
})

describe('clampPanel', () => {
  it('clamps at both ends per panel and passes values inside through', () => {
    expect(clampPanel('sidebar', 0.05)).toBe(0.15)
    expect(clampPanel('sidebar', 0.9)).toBe(0.35)
    expect(clampPanel('sidebar', 0.2)).toBe(0.2)
    expect(clampPanel('notes', 0.05)).toBe(0.15)
    expect(clampPanel('notes', 0.9)).toBe(0.5)
    expect(clampPanel('notes', 0.4)).toBe(0.4)
  })
})

describe('clampForEditorMin', () => {
  it('lets a panel grow to its own maximum while the other panel is closed', () => {
    const layout = defaultLayout() // notes closed at 0.25
    expect(clampForEditorMin(layout, 'sidebar', 0.5)).toBe(0.35)
    const notesOnly: Layout = {
      sidebar: { open: false, size: 0.35, tab: 'manuscript' },
      notes: { open: true, size: 0.25 },
      tagBar: { open: true, height: 120 }
    }
    expect(clampForEditorMin(notesOnly, 'notes', 0.9)).toBe(0.5)
  })

  it('stops the dragged panel where the editor would drop under its minimum', () => {
    const layout: Layout = {
      sidebar: { open: true, size: 0.3, tab: 'manuscript' },
      notes: { open: true, size: 0.3 },
      tagBar: { open: true, height: 120 }
    }
    // Growing the sidebar: 1 - 0.3 (editor) - 0.3 (notes) leaves 0.4, capped by its own max.
    expect(clampForEditorMin(layout, 'sidebar', 0.34)).toBe(0.34)
    expect(clampForEditorMin(layout, 'sidebar', 0.5)).toBe(0.35)
    // Growing the notes: 1 - 0.3 - 0.3 leaves 0.4.
    expect(clampForEditorMin(layout, 'notes', 0.35)).toBe(0.35)
    expect(clampForEditorMin(layout, 'notes', 0.45)).toBeCloseTo(0.4)
    const wide: Layout = {
      sidebar: { open: true, size: 0.35, tab: 'manuscript' },
      notes: { open: true, size: 0.5 },
      tagBar: { open: true, height: 120 }
    }
    expect(clampForEditorMin(wide, 'notes', 0.5)).toBeCloseTo(0.35)
    expect(clampForEditorMin(wide, 'sidebar', 0.35)).toBeCloseTo(0.2)
  })

  it('shrinking is only limited by the panel minimum, in both directions', () => {
    const layout: Layout = {
      sidebar: { open: true, size: 0.3, tab: 'manuscript' },
      notes: { open: true, size: 0.3 },
      tagBar: { open: true, height: 120 }
    }
    expect(clampForEditorMin(layout, 'sidebar', 0.1)).toBe(0.15)
    expect(clampForEditorMin(layout, 'notes', 0.2)).toBe(0.2)
    expect(clampForEditorMin(layout, 'notes', 0)).toBe(0.15)
  })

  it('does not change the other panel', () => {
    const layout: Layout = {
      sidebar: { open: true, size: 0.35, tab: 'manuscript' },
      notes: { open: true, size: 0.5 },
      tagBar: { open: true, height: 120 }
    }
    clampForEditorMin(layout, 'notes', 0.5)
    expect(layout).toEqual({
      sidebar: { open: true, size: 0.35, tab: 'manuscript' },
      notes: { open: true, size: 0.5 },
      tagBar: { open: true, height: 120 }
    })
  })
})

describe('editor minimum across panels', () => {
  const wide: Layout = {
    sidebar: { open: true, size: 0.35, tab: 'manuscript' },
    notes: { open: true, size: 0.5 },
    tagBar: { open: true, height: 120 }
  }

  it('fitsEditorMin counts only open panels', () => {
    expect(fitsEditorMin(wide)).toBe(false)
    expect(fitsEditorMin({ ...wide, notes: { open: false, size: 0.5 } })).toBe(true)
    expect(fitsEditorMin(defaultLayout())).toBe(true)
    expect(editorFraction(wide)).toBeCloseTo(0.15, 9)
  })

  it('normalizeLayout gives way notes first, then the sidebar, and leaves a valid layout alone', () => {
    const ok = defaultLayout()
    expect(normalizeLayout(ok)).toBe(ok)
    const fixed = normalizeLayout(wide)
    expect(fixed.sidebar.size).toBe(0.35)
    expect(fixed.notes.size).toBeCloseTo(0.35, 9)
    expect(fitsEditorMin(fixed)).toBe(true)
    // Notes at their minimum cannot give enough; the sidebar shrinks too.
    const tight: Layout = {
      sidebar: { open: true, size: 0.35, tab: 'manuscript' },
      notes: { open: true, size: 0.15 },
      tagBar: { open: true, height: 120 }
    }
    const still = normalizeLayout({
      ...tight,
      sidebar: { open: true, size: 0.35, tab: 'manuscript' }
    })
    expect(fitsEditorMin(still)).toBe(true)
  })
})
