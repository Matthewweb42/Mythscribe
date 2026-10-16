import { describe, expect, it } from 'vitest'
import { EDIT_FLOW_DEEP_SLICE_TOKENS, EDIT_FLOW_QUICK_SLICE_TOKENS } from '@shared/editFlow'
import { flowFamilies, planRequests, sliceScenes, type FlowScene } from './plan'

/** A scene of about `tokens` estimated tokens (four characters each) in paragraphs. */
function scene(n: number, chapter: string | null, tokens: number): FlowScene {
  const paragraph = `Paragraph of scene ${n}. ${'word '.repeat(150)}`.trim()
  const count = Math.max(1, Math.round((tokens * 4) / (paragraph.length + 2)))
  return {
    nodeId: `sc-${n}`,
    ref: `n${n}`,
    title: chapter === null ? `Scene ${n}` : `${chapter} › Scene ${n}`,
    chapterId: chapter,
    chapterTitle: chapter,
    text: Array.from({ length: count }, () => paragraph).join('\n\n')
  }
}

describe('sliceScenes (the edit flow’s request plan)', () => {
  it('Quick starts a slice at every chapter; a chapter of several scenes is one slice named by the chapter', () => {
    const scenes = [
      scene(1, 'Chapter 1', 1_000),
      scene(2, 'Chapter 1', 1_000),
      scene(3, 'Chapter 2', 1_000)
    ]
    const slices = sliceScenes(scenes, 'quick')
    expect(slices.map((slice) => slice.items.map((item) => item.nodeId))).toEqual([
      ['sc-1', 'sc-2'],
      ['sc-3']
    ])
    expect(slices.map((slice) => slice.label)).toEqual(['Chapter 1', 'Chapter 2 › Scene 3'])
  })

  it('Deep reads across chapters up to its budget', () => {
    const scenes = [
      scene(1, 'Chapter 1', 1_000),
      scene(2, 'Chapter 2', 1_000),
      scene(3, 'Chapter 3', 1_000)
    ]
    const slices = sliceScenes(scenes, 'deep')
    expect(slices).toHaveLength(1)
    expect(slices[0]?.label).toBe('Chapter 1 › Scene 1 to Chapter 3 › Scene 3')
    expect(slices[0]?.tokens).toBeLessThanOrEqual(EDIT_FLOW_DEEP_SLICE_TOKENS)
  })

  it('a chapter past the Quick budget splits at a scene break; a scene past it goes in pieces', () => {
    const big = [
      scene(1, 'Chapter 1', EDIT_FLOW_QUICK_SLICE_TOKENS * 0.7),
      scene(2, 'Chapter 1', EDIT_FLOW_QUICK_SLICE_TOKENS * 0.7)
    ]
    expect(sliceScenes(big, 'quick').map((s) => s.items.map((i) => i.nodeId))).toEqual([
      ['sc-1'],
      ['sc-2']
    ])
    const huge = sliceScenes([scene(9, 'Chapter 9', EDIT_FLOW_QUICK_SLICE_TOKENS * 2.5)], 'quick')
    expect(huge.length).toBeGreaterThanOrEqual(3)
    for (const slice of huge) {
      expect(slice.tokens).toBeLessThanOrEqual(EDIT_FLOW_QUICK_SLICE_TOKENS)
      for (const item of slice.items) expect(item.part.count).toBe(huge.length)
    }
    // Nothing is lost: the pieces put together are the scene.
    const pieces = huge.flatMap((slice) => slice.items.map((item) => item.text))
    expect(pieces.join('\n\n').replace(/\s+/g, ' ')).toBe(
      scene(9, 'Chapter 9', EDIT_FLOW_QUICK_SLICE_TOKENS * 2.5).text.replace(/\s+/g, ' ')
    )
  })
})

describe('flowFamilies and planRequests', () => {
  it('asks each stage on its own, the checks together, Update notes apart, in the flow’s order', () => {
    expect(flowFamilies(['updateNotes', 'voice', 'copy', 'continuity', 'developmental'])).toEqual([
      'developmental',
      'copy',
      'checks',
      'notes'
    ])
  })

  it('sends every family of a slice before the next slice', () => {
    const slices = sliceScenes(
      [scene(1, 'Chapter 1', 500), scene(2, 'Chapter 2', 500)],
      'quick'
    )
    expect(planRequests(slices, ['copy', 'checks'])).toEqual([
      { slice: 0, family: 'copy' },
      { slice: 0, family: 'checks' },
      { slice: 1, family: 'copy' },
      { slice: 1, family: 'checks' }
    ])
  })
})
