import { describe, expect, it } from 'vitest'
import { EDIT_PASS_TYPES } from '@shared/editPass'
import { renderSceneMood } from '@shared/sceneCard'
import { buildEditPassPrompt, EDIT_PASS_SENTINEL } from './editPass.v1'
import {
  buildEditPassPromptV2,
  EDIT_PASS_MOOD_TYPES,
  type BuildEditPassPromptV2Input
} from './editPass.v2'

const MOOD = renderSceneMood('quiet dread', 'debts come due') ?? ''
const input = (type: BuildEditPassPromptV2Input['type']): BuildEditPassPromptV2Input => ({
  type,
  text: 'The rope hung slack in the water. She waited.',
  title: 'The Crossing',
  part: { index: 0, count: 1 },
  voice: null,
  keepWords: [],
  references: [],
  instruction: type === 'custom' ? 'Tighten.' : null,
  mood: MOOD
})

describe('editPass.v2 prompt (F-14.15, F-5.6 mood and theme)', () => {
  it('opens the user turn with the mood block for developmental, line, and custom passes', () => {
    expect(EDIT_PASS_MOOD_TYPES).toEqual(['developmental', 'line', 'custom'])
    for (const type of EDIT_PASS_MOOD_TYPES) {
      const built = buildEditPassPromptV2(input(type))
      const v1 = buildEditPassPrompt(input(type))
      expect(built.version).toBe('editPass.v2')
      expect(built.messages[0]).toEqual(v1.messages[0])
      expect(built.messages[0]?.content.startsWith(EDIT_PASS_SENTINEL)).toBe(true)
      expect(built.messages[1]?.content).toBe(`${MOOD}\n\n${v1.messages[1]?.content ?? ''}`)
      expect(built.maxTokens).toBe(v1.maxTokens)
    }
    expect(buildEditPassPromptV2(input('line')).messages).toMatchSnapshot()
  })

  it("leaves copy edit, proofread, and continuity as version 1's messages", () => {
    for (const type of EDIT_PASS_TYPES.filter((each) => !EDIT_PASS_MOOD_TYPES.includes(each))) {
      expect(buildEditPassPromptV2(input(type)).messages).toEqual(
        buildEditPassPrompt(input(type)).messages
      )
    }
  })

  it("is version 1's messages exactly with no mood block", () => {
    expect(buildEditPassPromptV2({ ...input('line'), mood: null }).messages).toEqual(
      buildEditPassPrompt(input('line')).messages
    )
  })
})
