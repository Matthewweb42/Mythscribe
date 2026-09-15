import { describe, expect, it } from 'vitest'
import {
  LAYOUT_LIMITS,
  LAYOUT_PANELS,
  Layout,
  StoredLayout,
  TAG_BAR_MIN_HEIGHT,
  TAG_BAR_SPLIT_LIMITS,
  clampForEditorMin,
  clampPanel,
  clampRect,
  clampTagBarHeight,
  clampTagBarSplit,
  defaultFloating,
  defaultLayout,
  editorFraction,
  fitsEditorMin,
  normalizeLayout,
  rectEquals,
  FLOATING_MIN_SIZE,
  FLOATING_PANELS,
  type Rect
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

  it('opens the tag bar at 120 px (F-4.4) with the metadata pane at 40 % (F-4.5)', () => {
    expect(defaultLayout().tagBar).toEqual({ open: true, height: 120, split: 0.4 })
  })

  it('starts with the assistant panel closed at 0.3 (F-5.4)', () => {
    expect(defaultLayout().assistant).toEqual({ open: false, size: 0.3 })
    expect(LAYOUT_PANELS).toEqual(['sidebar', 'notes', 'assistant'])
    expect(LAYOUT_LIMITS.assistant).toEqual([0.2, 0.5])
  })

  it('every panel at its floor still leaves the editor its minimum', () => {
    const floors = LAYOUT_PANELS.reduce((sum, p) => sum + LAYOUT_LIMITS[p][0], 0)
    expect(floors + LAYOUT_LIMITS.editorMin).toBeLessThanOrEqual(1)
  })

  it('floats the notes at the right third and the assistant below it, each a fresh copy (F-6.6)', () => {
    expect(FLOATING_PANELS).toEqual(['notes', 'assistant'])
    const floating = defaultFloating()
    expect(defaultLayout().floating).toEqual(floating)
    expect(floating.notes).toEqual({ x: 860, y: 48, width: 380, height: 320 })
    expect(floating.assistant).toEqual({ x: 860, y: 392, width: 380, height: 380 })
    // Both fit a 1280 × 800 window, one under the other.
    expect(floating.notes.x + floating.notes.width).toBeLessThanOrEqual(1280)
    expect(floating.notes.y + floating.notes.height).toBeLessThanOrEqual(floating.assistant.y)
    expect(floating.assistant.y + floating.assistant.height).toBeLessThanOrEqual(800)
    expect(defaultFloating().notes).not.toBe(defaultFloating().notes)
    expect(defaultLayout().floating).not.toBe(defaultLayout().floating)
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

  it('refuses an assistant panel outside 20–50 % and requires it; StoredLayout defaults a pre-F-5.4 layout (F-5.4)', () => {
    const base = defaultLayout()
    expect(Layout.safeParse({ ...base, assistant: { open: true, size: 0.19 } }).success).toBe(false)
    expect(Layout.safeParse({ ...base, assistant: { open: true, size: 0.2 } }).success).toBe(true)
    expect(Layout.safeParse({ ...base, assistant: { open: false, size: 0.5 } }).success).toBe(true)
    expect(Layout.safeParse({ ...base, assistant: { open: false, size: 0.51 } }).success).toBe(
      false
    )
    const { assistant: _dropped, ...withoutAssistant } = base
    expect(Layout.safeParse(withoutAssistant).success).toBe(false)
    expect(StoredLayout.parse(withoutAssistant)).toEqual(base)
    expect(
      StoredLayout.parse({ ...withoutAssistant, assistant: { open: true, size: 0.4 } }).assistant
    ).toEqual({ open: true, size: 0.4 })
  })

  it('refuses a tag bar under its floor and has no static ceiling (F-4.4)', () => {
    const base = defaultLayout()
    const bar = (height: number, open = true): Layout['tagBar'] => ({ open, height, split: 0.4 })
    expect(Layout.safeParse({ ...base, tagBar: bar(99) }).success).toBe(false)
    expect(Layout.safeParse({ ...base, tagBar: bar(100) }).success).toBe(true)
    expect(Layout.safeParse({ ...base, tagBar: bar(2000, false) }).success).toBe(true)
    const { tagBar: _dropped, ...withoutTagBar } = base
    expect(Layout.safeParse(withoutTagBar).success).toBe(false)
  })

  it('refuses a metadata split outside 30–70 % of the bar and requires it (F-4.5)', () => {
    const base = defaultLayout()
    const bar = (split: number): Layout['tagBar'] => ({ open: true, height: 120, split })
    expect(Layout.safeParse({ ...base, tagBar: bar(0.29) }).success).toBe(false)
    expect(Layout.safeParse({ ...base, tagBar: bar(0.3) }).success).toBe(true)
    expect(Layout.safeParse({ ...base, tagBar: bar(0.7) }).success).toBe(true)
    expect(Layout.safeParse({ ...base, tagBar: bar(0.71) }).success).toBe(false)
    const { split: _dropped, ...withoutSplit } = bar(0.4)
    expect(Layout.safeParse({ ...base, tagBar: withoutSplit }).success).toBe(false)
  })

  it('refuses a floating window under the minimum size or off the top-left, and requires the field; StoredLayout defaults a pre-F-6.6 layout (F-6.6)', () => {
    const base = defaultLayout()
    const rect = (patch: Partial<Rect>): Rect => ({ ...base.floating.notes, ...patch })
    const withNotes = (notes: Rect): unknown => ({
      ...base,
      floating: { ...base.floating, notes }
    })
    expect(FLOATING_MIN_SIZE).toEqual({ width: 280, height: 200 })
    expect(Layout.safeParse(withNotes(rect({ width: 279 }))).success).toBe(false)
    expect(Layout.safeParse(withNotes(rect({ width: 280 }))).success).toBe(true)
    expect(Layout.safeParse(withNotes(rect({ height: 199 }))).success).toBe(false)
    expect(Layout.safeParse(withNotes(rect({ height: 200 }))).success).toBe(true)
    expect(Layout.safeParse(withNotes(rect({ x: -1 }))).success).toBe(false)
    expect(Layout.safeParse(withNotes(rect({ y: -1 }))).success).toBe(false)
    expect(Layout.safeParse(withNotes(rect({ x: 0, y: 0 }))).success).toBe(true)
    // No ceiling: a rect from a larger display parses and is clamped at render time.
    expect(Layout.safeParse(withNotes(rect({ x: 5000, width: 4000 }))).success).toBe(true)
    expect(Layout.safeParse({ ...base, floating: { notes: base.floating.notes } }).success).toBe(
      false
    )
    const { floating: _dropped, ...withoutFloating } = base
    expect(Layout.safeParse(withoutFloating).success).toBe(false)
    expect(StoredLayout.parse(withoutFloating)).toEqual(base)
    const stored = { notes: rect({ x: 10, y: 20 }), assistant: rect({ width: 300, height: 250 }) }
    expect(StoredLayout.parse({ ...withoutFloating, floating: stored }).floating).toEqual(stored)
  })

  it('StoredLayout defaults a pre-F-4.4 layout to the default tag bar', () => {
    const { tagBar: _dropped, ...withoutTagBar } = defaultLayout()
    expect(StoredLayout.parse(withoutTagBar)).toEqual(defaultLayout())
  })

  it('StoredLayout gives a pre-F-4.5 tag bar (open and height only) the default split', () => {
    const base = defaultLayout()
    expect(StoredLayout.parse({ ...base, tagBar: { open: false, height: 240 } })).toEqual({
      ...base,
      tagBar: { open: false, height: 240, split: 0.4 }
    })
    // A stored split is kept, and one outside the limits is still refused.
    expect(
      StoredLayout.parse({ ...base, tagBar: { open: true, height: 120, split: 0.6 } })
    ).toEqual({ ...base, tagBar: { open: true, height: 120, split: 0.6 } })
    expect(
      StoredLayout.safeParse({ ...base, tagBar: { open: true, height: 120, split: 0.8 } }).success
    ).toBe(false)
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

describe('clampTagBarSplit', () => {
  it('clamps to 30–70 % and passes values inside through', () => {
    expect(TAG_BAR_SPLIT_LIMITS).toEqual([0.3, 0.7])
    expect(clampTagBarSplit(0)).toBe(0.3)
    expect(clampTagBarSplit(0.3)).toBe(0.3)
    expect(clampTagBarSplit(0.45)).toBe(0.45)
    expect(clampTagBarSplit(0.7)).toBe(0.7)
    expect(clampTagBarSplit(1)).toBe(0.7)
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
      tagBar: { open: true, height: 120, split: 0.4 },
      assistant: { open: false, size: 0.3 },
      floating: defaultFloating()
    }
    expect(clampForEditorMin(notesOnly, 'notes', 0.9)).toBe(0.5)
  })

  it('stops the dragged panel where the editor would drop under its minimum', () => {
    const layout: Layout = {
      sidebar: { open: true, size: 0.3, tab: 'manuscript' },
      notes: { open: true, size: 0.3 },
      tagBar: { open: true, height: 120, split: 0.4 },
      assistant: { open: false, size: 0.3 },
      floating: defaultFloating()
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
      tagBar: { open: true, height: 120, split: 0.4 },
      assistant: { open: false, size: 0.3 },
      floating: defaultFloating()
    }
    expect(clampForEditorMin(wide, 'notes', 0.5)).toBeCloseTo(0.35)
    expect(clampForEditorMin(wide, 'sidebar', 0.35)).toBeCloseTo(0.2)
  })

  it('shrinking is only limited by the panel minimum, in both directions', () => {
    const layout: Layout = {
      sidebar: { open: true, size: 0.3, tab: 'manuscript' },
      notes: { open: true, size: 0.3 },
      tagBar: { open: true, height: 120, split: 0.4 },
      assistant: { open: false, size: 0.3 },
      floating: defaultFloating()
    }
    expect(clampForEditorMin(layout, 'sidebar', 0.1)).toBe(0.15)
    expect(clampForEditorMin(layout, 'notes', 0.2)).toBe(0.2)
    expect(clampForEditorMin(layout, 'notes', 0)).toBe(0.15)
  })

  it('does not change the other panel', () => {
    const layout: Layout = {
      sidebar: { open: true, size: 0.35, tab: 'manuscript' },
      notes: { open: true, size: 0.5 },
      tagBar: { open: true, height: 120, split: 0.4 },
      assistant: { open: false, size: 0.3 },
      floating: defaultFloating()
    }
    clampForEditorMin(layout, 'notes', 0.5)
    expect(layout).toEqual({
      sidebar: { open: true, size: 0.35, tab: 'manuscript' },
      notes: { open: true, size: 0.5 },
      tagBar: { open: true, height: 120, split: 0.4 },
      assistant: { open: false, size: 0.3 },
      floating: defaultFloating()
    })
  })
})

describe('editor minimum across panels', () => {
  const wide: Layout = {
    sidebar: { open: true, size: 0.35, tab: 'manuscript' },
    notes: { open: true, size: 0.5 },
    tagBar: { open: true, height: 120, split: 0.4 },
    assistant: { open: false, size: 0.3 },
    floating: defaultFloating()
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
      tagBar: { open: true, height: 120, split: 0.4 },
      assistant: { open: false, size: 0.3 },
      floating: defaultFloating()
    }
    const still = normalizeLayout({
      ...tight,
      sidebar: { open: true, size: 0.35, tab: 'manuscript' }
    })
    expect(fitsEditorMin(still)).toBe(true)
  })

  it('normalizeLayout gives way assistant first when a third panel opens beside two wide ones (F-5.4)', () => {
    const three: Layout = {
      sidebar: { open: true, size: 0.35, tab: 'manuscript' },
      notes: { open: true, size: 0.35 },
      tagBar: { open: true, height: 120, split: 0.4 },
      assistant: { open: true, size: 0.4 },
      floating: defaultFloating()
    }
    const fixed = normalizeLayout(three)
    // The assistant lands on its floor, then the notes give the rest; the sidebar keeps its size.
    expect(fixed.assistant.size).toBe(0.2)
    expect(fixed.notes.size).toBeCloseTo(0.15, 9)
    expect(fixed.sidebar.size).toBe(0.35)
    expect(fitsEditorMin(fixed)).toBe(true)
    // A closed assistant does not take part: the other two fit as they are.
    const input: Layout = { ...three, assistant: { open: false, size: 0.4 } }
    const closed = normalizeLayout(input)
    expect(closed).toBe(input)
    expect(closed.notes.size).toBe(0.35)
  })
})

describe('clampRect (F-6.6)', () => {
  const viewport = { width: 1000, height: 800 }

  it('passes a rect inside the viewport through unchanged', () => {
    const rect: Rect = { x: 100, y: 50, width: 300, height: 250 }
    expect(clampRect(rect, viewport)).toEqual(rect)
  })

  it('moves an overflowing rect back in, keeping its size', () => {
    expect(clampRect({ x: 900, y: 700, width: 300, height: 250 }, viewport)).toEqual({
      x: 700,
      y: 550,
      width: 300,
      height: 250
    })
    expect(clampRect({ x: -40, y: -10, width: 300, height: 250 }, viewport)).toEqual({
      x: 0,
      y: 0,
      width: 300,
      height: 250
    })
  })

  it('shrinks a rect larger than the viewport to the viewport, at the origin', () => {
    expect(clampRect({ x: 100, y: 100, width: 1200, height: 900 }, viewport)).toEqual({
      x: 0,
      y: 0,
      width: 1000,
      height: 800
    })
  })

  it('never goes under the minimum size, even on a viewport smaller than it', () => {
    expect(clampRect({ x: 10, y: 10, width: 100, height: 50 }, viewport)).toEqual({
      x: 10,
      y: 10,
      width: 280,
      height: 200
    })
    expect(
      clampRect({ x: 10, y: 10, width: 300, height: 250 }, { width: 200, height: 100 })
    ).toEqual({ x: 0, y: 0, width: 280, height: 200 })
    expect(
      clampRect({ x: 10, y: 10, width: 100, height: 50 }, viewport, { width: 50, height: 40 })
    ).toEqual({ x: 10, y: 10, width: 100, height: 50 })
  })

  it('rounds to whole px', () => {
    expect(clampRect({ x: 10.4, y: 20.6, width: 300.5, height: 250.2 }, viewport)).toEqual({
      x: 10,
      y: 21,
      width: 301,
      height: 250
    })
  })

  it('rectEquals compares the four values', () => {
    const a: Rect = { x: 1, y: 2, width: 300, height: 250 }
    expect(rectEquals(a, { ...a })).toBe(true)
    expect(rectEquals(a, { ...a, x: 2 })).toBe(false)
    expect(rectEquals(a, { ...a, height: 251 })).toBe(false)
  })
})
