import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  TYPEWRITER_DEAD_ZONE_PX,
  Typewriter,
  centerDelta,
  findScroller,
  type ScrollTarget
} from './typewriter'

describe('centerDelta (F-3.9)', () => {
  it('measures the distance from the scroller middle and ignores the dead zone', () => {
    const scroller = { top: 100, height: 400 }
    expect(centerDelta(300, scroller)).toBe(0)
    expect(centerDelta(300 + TYPEWRITER_DEAD_ZONE_PX, scroller)).toBe(0)
    expect(centerDelta(300 + TYPEWRITER_DEAD_ZONE_PX + 1, scroller)).toBe(
      TYPEWRITER_DEAD_ZONE_PX + 1
    )
    expect(centerDelta(120, scroller)).toBe(-180)
  })
})

describe('findScroller', () => {
  it('finds the nearest vertically scrolling ancestor, or null', () => {
    const outer = document.createElement('div')
    outer.style.overflowY = 'auto'
    const middle = document.createElement('div')
    const inner = document.createElement('div')
    outer.append(middle)
    middle.append(inner)
    document.body.append(outer)
    expect(findScroller(inner)).toBe(outer)
    outer.style.overflowY = 'visible'
    expect(findScroller(inner)).toBeNull()
    outer.remove()
  })
})

describe('Typewriter extension', () => {
  let editor: Editor
  let scroller: ScrollTarget
  let host: HTMLElement

  beforeEach(() => {
    scroller = { scrollTop: 1000, getBoundingClientRect: () => ({ top: 0, height: 400 }) }
    host = document.createElement('div')
    document.body.append(host)
    editor = new Editor({
      element: host,
      extensions: [StarterKit, Typewriter.configure({ scroller: () => scroller })],
      content: '<p>Mara waited.</p>'
    })
    // jsdom has no layout; the caret sits 300 px down in every test here.
    vi.spyOn(editor.view, 'coordsAtPos').mockReturnValue({
      top: 300,
      bottom: 316,
      left: 0,
      right: 0
    })
  })
  afterEach(() => {
    editor.destroy()
    host.remove()
  })

  it('does nothing until enabled', () => {
    editor.commands.insertContentAt(editor.state.doc.content.size - 1, ' Nobody came.')
    expect(scroller.scrollTop).toBe(1000)
  })

  it('centers the caret on a document change once enabled, not on a caret move', () => {
    editor.commands.setTypewriter(true)
    editor.commands.setTextSelection(3)
    expect(scroller.scrollTop).toBe(1000)
    editor.commands.insertContentAt(editor.state.doc.content.size - 1, ' Nobody came.')
    // The caret is at 300 and the middle at 200: scroll down by 100.
    expect(scroller.scrollTop).toBe(1100)
  })

  it('leaves the scroller alone inside the dead zone', () => {
    editor.commands.setTypewriter(true)
    vi.spyOn(editor.view, 'coordsAtPos').mockReturnValue({
      top: 200 + TYPEWRITER_DEAD_ZONE_PX,
      bottom: 216,
      left: 0,
      right: 0
    })
    editor.commands.insertContentAt(editor.state.doc.content.size - 1, ' Nobody came.')
    expect(scroller.scrollTop).toBe(1000)
  })
})
