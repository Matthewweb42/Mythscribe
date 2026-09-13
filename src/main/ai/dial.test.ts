import { describe, expect, it } from 'vitest'
import { AI_NEXT_STEP } from '@shared/ai'
import { defaultAiSettings } from '@shared/aiSettings'
import { assertFeatureAllowed } from './dial'
import { AiDisabledError, AiProviderError } from './providers/types'

const at = (dial: 0 | 1 | 2 | 3): ReturnType<typeof defaultAiSettings> => ({
  ...defaultAiSettings(),
  dial
})

describe('assertFeatureAllowed (F-14.4)', () => {
  it('returns for a feature the dial and its toggle allow', () => {
    expect(() => assertFeatureAllowed(at(1), 'tags')).not.toThrow()
    expect(() => assertFeatureAllowed(at(2), 'ghostText')).not.toThrow()
    expect(() => assertFeatureAllowed(at(3), 'authorMode')).not.toThrow()
  })

  it('throws DISABLED naming the level needed when the dial is too low', () => {
    let caught: unknown
    try {
      assertFeatureAllowed(at(1), 'ghostText')
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(AiDisabledError)
    expect(caught).toBeInstanceOf(AiProviderError)
    if (!(caught instanceof AiDisabledError)) throw new Error('unreachable')
    expect(caught.code).toBe('DISABLED')
    expect(caught.message).toBe('Ghost text needs the AI dial at Suggest or higher (it is at Ask).')
    expect(AI_NEXT_STEP[caught.code]).toBe(
      'Turn the AI dial up in Settings, or enable the feature there.'
    )
  })

  it('throws DISABLED for every feature at Off', () => {
    expect(() => assertFeatureAllowed(at(0), 'tags')).toThrow(
      /Tag suggestions needs the AI dial at Ask or higher \(it is at Off\)\./
    )
  })

  it('throws DISABLED saying the feature is off when the dial suffices but the toggle is off', () => {
    const settings = { ...at(3), features: { ...at(3).features, critique: false } }
    expect(() => assertFeatureAllowed(settings, 'critique')).toThrow(
      "Editor's notes is turned off for this project."
    )
    expect(() => assertFeatureAllowed(settings, 'critique')).not.toThrow(/dial/)
  })
})
