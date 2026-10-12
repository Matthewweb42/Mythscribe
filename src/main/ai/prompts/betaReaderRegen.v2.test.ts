import { describe, expect, it } from 'vitest'
import { buildBetaReaderPromptV2, type BuildBetaReaderPromptV2Input } from './betaReader.v2'
import {
  BETA_READER_REGEN_PROMPT_V2_VERSION,
  buildBetaReaderRegenPromptV2
} from './betaReaderRegen.v2'

const input: BuildBetaReaderPromptV2Input = {
  scenes: [{ title: 'Chapter 1 › Opening', gist: 'Mara hides the ledger.' }],
  current: { title: 'Chapter 2 › The landing', text: 'Mara waited at the landing.' },
  honesty: 'encouraging'
}

describe('betaReaderRegen.v2 prompt (F-16.20)', () => {
  it('appends the author’s note to the user turn and keeps the system turn byte for byte', () => {
    const base = buildBetaReaderPromptV2(input)
    const built = buildBetaReaderRegenPromptV2({ ...input, note: 'Focus on the ledger.' })
    expect(built.version).toBe(BETA_READER_REGEN_PROMPT_V2_VERSION)
    expect(built.version).toBe('betaReaderRegen.v2')
    expect(built.messages[0]).toEqual(base.messages[0])
    expect(built.messages[1]?.content).toBe(
      `${base.messages[1]?.content}\n\nThe writer asked for a different read and said: "Focus on the ledger.".`
    )
    expect(built.maxTokens).toBe(base.maxTokens)
  })

  it('is the plain read under its own version when no note was given', () => {
    const built = buildBetaReaderRegenPromptV2({ ...input, note: null })
    expect(built.messages).toEqual(buildBetaReaderPromptV2(input).messages)
    expect(built.version).toBe('betaReaderRegen.v2')
  })
})
