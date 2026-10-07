import { describe, expect, it } from 'vitest'
import { DEFAULT_ROUTING_TABLE } from '@shared/aiRouting'
import { PROMPT_CATALOGUE } from './catalogue'

describe('the bundled Auto table (AI-BILLING-SPEC R4)', () => {
  it('routes every catalogued prompt to the tier its feature already asks for, so Auto changes nothing', () => {
    for (const [version, entry] of Object.entries(PROMPT_CATALOGUE)) {
      const routed = DEFAULT_ROUTING_TABLE[entry.feature]
      if (routed === undefined) continue
      expect({ version, tier: routed }).toEqual({ version, tier: entry.tier })
    }
  })
})
