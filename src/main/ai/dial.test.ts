import { describe, expect, it } from 'vitest'
import { AI_NEXT_STEP } from '@shared/ai'
import { defaultAiSettings, type AiSettings } from '@shared/aiSettings'
import { assertFeatureAllowed } from './dial'
import { AiDisabledError, AiProviderError } from './providers/types'

const at = (dial: 0 | 1, auto = false): AiSettings => ({
  ...defaultAiSettings(),
  dial,
  chatMode: auto ? 'auto' : 'ask'
})

describe('assertFeatureAllowed (F-14.4, F-5.21)', () => {
  it('returns for every feature at Ask and at Auto when its toggle is on', () => {
    for (const settings of [at(1), at(1, true)]) {
      expect(() => assertFeatureAllowed(settings, 'tags')).not.toThrow()
      expect(() => assertFeatureAllowed(settings, 'ghostText')).not.toThrow()
      expect(() => assertFeatureAllowed(settings, 'authorMode')).not.toThrow()
    }
  })

  it('throws DISABLED naming the switch when it is Off', () => {
    let caught: unknown
    try {
      assertFeatureAllowed(at(0), 'ghostText')
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(AiDisabledError)
    expect(caught).toBeInstanceOf(AiProviderError)
    if (!(caught instanceof AiDisabledError)) throw new Error('unreachable')
    expect(caught.code).toBe('DISABLED')
    expect(caught.message).toBe('Ghost text needs Use AI turned on (it is off).')
    expect(AI_NEXT_STEP[caught.code]).toBe(
      'Turn on Use AI in Settings › AI, or enable the feature there.'
    )
  })

  it('throws DISABLED saying the feature is off when the switch is on but the toggle is off', () => {
    const settings = { ...at(1), features: { ...at(1).features, critique: false } }
    expect(() => assertFeatureAllowed(settings, 'critique')).toThrow(
      "Editor's notes is turned off for this project."
    )
    expect(() => assertFeatureAllowed(settings, 'critique')).not.toThrow(/switch/)
  })
})
