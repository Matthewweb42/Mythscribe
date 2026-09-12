import { describe, expect, it } from 'vitest'
import {
  LAYOUT_LIMITS,
  Layout,
  clampForEditorMin,
  clampPanel,
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
  })
})

describe('Layout schema', () => {
  it('refuses sizes outside the panel limits', () => {
    const base = defaultLayout()
    expect(Layout.safeParse({ ...base, sidebar: { open: true, size: 0.1 } }).success).toBe(false)
    expect(Layout.safeParse({ ...base, sidebar: { open: true, size: 0.36 } }).success).toBe(false)
    expect(Layout.safeParse({ ...base, notes: { open: false, size: 0.51 } }).success).toBe(false)
    expect(Layout.safeParse({ ...base, notes: { open: false, size: 0.5 } }).success).toBe(true)
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
      sidebar: { open: false, size: 0.35 },
      notes: { open: true, size: 0.25 }
    }
    expect(clampForEditorMin(notesOnly, 'notes', 0.9)).toBe(0.5)
  })

  it('stops the dragged panel where the editor would drop under its minimum', () => {
    const layout: Layout = {
      sidebar: { open: true, size: 0.3 },
      notes: { open: true, size: 0.3 }
    }
    // Growing the sidebar: 1 - 0.3 (editor) - 0.3 (notes) leaves 0.4, capped by its own max.
    expect(clampForEditorMin(layout, 'sidebar', 0.34)).toBe(0.34)
    expect(clampForEditorMin(layout, 'sidebar', 0.5)).toBe(0.35)
    // Growing the notes: 1 - 0.3 - 0.3 leaves 0.4.
    expect(clampForEditorMin(layout, 'notes', 0.35)).toBe(0.35)
    expect(clampForEditorMin(layout, 'notes', 0.45)).toBeCloseTo(0.4)
    const wide: Layout = {
      sidebar: { open: true, size: 0.35 },
      notes: { open: true, size: 0.5 }
    }
    expect(clampForEditorMin(wide, 'notes', 0.5)).toBeCloseTo(0.35)
    expect(clampForEditorMin(wide, 'sidebar', 0.35)).toBeCloseTo(0.2)
  })

  it('shrinking is only limited by the panel minimum, in both directions', () => {
    const layout: Layout = {
      sidebar: { open: true, size: 0.3 },
      notes: { open: true, size: 0.3 }
    }
    expect(clampForEditorMin(layout, 'sidebar', 0.1)).toBe(0.15)
    expect(clampForEditorMin(layout, 'notes', 0.2)).toBe(0.2)
    expect(clampForEditorMin(layout, 'notes', 0)).toBe(0.15)
  })

  it('does not change the other panel', () => {
    const layout: Layout = {
      sidebar: { open: true, size: 0.35 },
      notes: { open: true, size: 0.5 }
    }
    clampForEditorMin(layout, 'notes', 0.5)
    expect(layout).toEqual({
      sidebar: { open: true, size: 0.35 },
      notes: { open: true, size: 0.5 }
    })
  })
})

describe('editor minimum across panels', () => {
  const wide: Layout = { sidebar: { open: true, size: 0.35 }, notes: { open: true, size: 0.5 } }

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
    const tight: Layout = { sidebar: { open: true, size: 0.35 }, notes: { open: true, size: 0.15 } }
    const still = normalizeLayout({ ...tight, sidebar: { open: true, size: 0.35 } })
    expect(fitsEditorMin(still)).toBe(true)
  })
})
