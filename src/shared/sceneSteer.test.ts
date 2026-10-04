import { describe, expect, it } from 'vitest'
import { estimateTokens } from './ai'
import {
  renderSceneSteer,
  SCENE_STEER_CATEGORIES,
  SCENE_STEER_HEADING,
  SCENE_STEER_NAMES_MAX,
  SCENE_STEER_TOKEN_BUDGET
} from './sceneSteer'
import { TAG_NAME_MAX } from './tags'

describe('renderSceneSteer (F-14.13)', () => {
  it('is null for no tags and for tags only in fact categories', () => {
    expect(renderSceneSteer([])).toBeNull()
    expect(
      renderSceneSteer([
        { category: 'character', name: 'mara' },
        { category: 'setting', name: 'ferry-landing' },
        { category: 'worldBuilding', name: 'tides' }
      ])
    ).toBeNull()
  })

  it('lists the steer categories in a fixed order with their labels, leaving fact tags out', () => {
    expect(
      renderSceneSteer([
        { category: 'custom', name: 'grief' },
        { category: 'character', name: 'mara' },
        { category: 'plotThread', name: 'the-crossing' },
        { category: 'tone', name: 'tense' },
        { category: 'content', name: 'violence' },
        { category: 'tone', name: 'wry' }
      ])
    ).toBe(
      [
        SCENE_STEER_HEADING,
        'Tone: tense, wry',
        'Content: violence',
        'Plot threads: the-crossing',
        'Themes: grief',
        'Write in this tone, keep to what the content tags allow, and keep these threads and themes in view.'
      ].join('\n')
    )
  })

  it('composes the closing sentence from the categories present', () => {
    expect(renderSceneSteer([{ category: 'tone', name: 'tense' }])).toBe(
      `${SCENE_STEER_HEADING}\nTone: tense\nWrite in this tone.`
    )
    expect(
      renderSceneSteer([
        { category: 'tone', name: 'tense' },
        { category: 'content', name: 'violence' }
      ])
        ?.split('\n')
        .at(-1)
    ).toBe('Write in this tone and keep to what the content tags allow.')
    expect(
      renderSceneSteer([{ category: 'custom', name: 'grief' }])
        ?.split('\n')
        .at(-1)
    ).toBe('Keep these threads and themes in view.')
    expect(
      renderSceneSteer([
        { category: 'plotThread', name: 'the-crossing' },
        { category: 'custom', name: 'grief' }
      ])
        ?.split('\n')
        .at(-1)
    ).toBe('Keep these threads and themes in view.')
    expect(
      renderSceneSteer([
        { category: 'content', name: 'violence' },
        { category: 'plotThread', name: 'the-crossing' }
      ])
        ?.split('\n')
        .at(-1)
    ).toBe('Keep to what the content tags allow and keep these threads and themes in view.')
  })

  it('caps each category line at SCENE_STEER_NAMES_MAX names and counts the rest', () => {
    const names = Array.from({ length: SCENE_STEER_NAMES_MAX + 3 }, (_, i) => `t${i}`)
    const block = renderSceneSteer(names.map((name) => ({ category: 'tone' as const, name })))
    expect(block?.split('\n')[1]).toBe(
      `Tone: ${names.slice(0, SCENE_STEER_NAMES_MAX).join(', ')} … and 3 more`
    )
    const exact = names.slice(0, SCENE_STEER_NAMES_MAX)
    expect(
      renderSceneSteer(exact.map((name) => ({ category: 'tone' as const, name })))?.split('\n')[1]
    ).toBe(`Tone: ${exact.join(', ')}`)
  })

  it('keeps fewer names per line to stay within SCENE_STEER_TOKEN_BUDGET, down to one each at worst', () => {
    const long = (category: (typeof SCENE_STEER_CATEGORIES)[number], count: number) =>
      Array.from({ length: count }, (_, i) => ({
        category,
        name: `${category}-${i}-`.padEnd(TAG_NAME_MAX, 'x')
      }))
    const worst = renderSceneSteer(
      SCENE_STEER_CATEGORIES.flatMap((category) => long(category, SCENE_STEER_NAMES_MAX + 1))
    )
    expect(worst).not.toBeNull()
    expect(estimateTokens(worst ?? '')).toBeLessThanOrEqual(SCENE_STEER_TOKEN_BUDGET)
    expect(worst?.split('\n')[1]).toBe(
      `Tone: ${long('tone', 1)[0]?.name} … and ${SCENE_STEER_NAMES_MAX} more`
    )
    // One long category alone keeps more than one name.
    const one = renderSceneSteer(long('tone', SCENE_STEER_NAMES_MAX + 1)) ?? ''
    expect(estimateTokens(one)).toBeLessThanOrEqual(SCENE_STEER_TOKEN_BUDGET)
    expect(one.split('\n')[1]?.split(', ').length).toBeGreaterThan(1)
  })
})
