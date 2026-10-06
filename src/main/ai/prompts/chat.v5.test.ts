import { describe, expect, it } from 'vitest'
import { estimateTokens } from '@shared/ai'
import { builtinParams } from '@shared/presets'
import { buildChatPromptV4 } from './chat.v4'
import {
  buildChatPromptV5,
  CHAT_PROMPT_V5_VERSION,
  renderScenePanel,
  SCENE_PANEL_HEADING,
  type BuildChatPromptV5Input
} from './chat.v5'
import { buildChatRegenPromptV4 } from './chatRegen.v4'
import { buildChatRegenPromptV5, CHAT_REGEN_PROMPT_V5_VERSION } from './chatRegen.v5'

const SCENE =
  'The storm broke at dusk over the dark forest. Mara pulled her cloak tight and counted the ' +
  'lightning gaps, each one shorter than the last.'
const PANEL = { synopsis: 'Mara crosses before the storm.', notes: 'Tomas waits on the far bank.' }
const PANEL_BLOCK =
  `${SCENE_PANEL_HEADING}\nSynopsis: Mara crosses before the storm.\n` +
  'Notes:\n"""\nTomas waits on the far bank.\n"""'

const plan: BuildChatPromptV5Input = {
  mode: 'plan',
  paragraphs: 1,
  sceneText: SCENE,
  sceneMeta: null,
  brief: null,
  steer: null,
  panel: null,
  refs: [],
  history: [],
  message: 'What is missing from this scene?',
  voice: null,
  bible: null,
  preset: null
}
const agent: BuildChatPromptV5Input = {
  ...plan,
  mode: 'agent',
  paragraphs: 2,
  message: 'Bring Tomas onto the landing.',
  preset: builtinParams('general')
}

describe('chat.v5 prompt (F-5.20)', () => {
  it('renders the panel block from what is present, and nothing for an empty panel', () => {
    expect(renderScenePanel(PANEL)).toBe(PANEL_BLOCK)
    expect(renderScenePanel({ synopsis: 'Only this.', notes: '' })).toBe(
      `${SCENE_PANEL_HEADING}\nSynopsis: Only this.`
    )
    expect(renderScenePanel({ synopsis: '', notes: '' })).toBeNull()
    expect(renderScenePanel(null)).toBeNull()
  })

  it('is version 4 exactly with no panel, in both modes and with no scene open', () => {
    for (const input of [plan, agent, { ...plan, sceneText: '' }]) {
      const v5 = buildChatPromptV5(input)
      const v4 = buildChatPromptV4(input)
      expect(v5.version).toBe(CHAT_PROMPT_V5_VERSION)
      expect(v5.messages).toEqual(v4.messages)
      expect(v5.maxTokens).toBe(v4.maxTokens)
      expect(v5.temperature).toBe(v4.temperature)
    }
  })

  it('puts the panel right before the active scene in both modes', () => {
    for (const input of [plan, agent]) {
      const system = buildChatPromptV5({ ...input, panel: PANEL }).messages[0]?.content ?? ''
      expect(system).toContain(`${PANEL_BLOCK}\n\nActive scene:\n"""\n${SCENE}\n"""`)
      expect(system.endsWith(`Active scene:\n"""\n${SCENE}\n"""`)).toBe(true)
    }
    const none = buildChatPromptV5({ ...plan, sceneText: '', panel: PANEL }).messages[0]?.content
    expect(
      none?.endsWith(
        `${PANEL_BLOCK}\n\nNo scene is open; the author is working outside the manuscript.`
      )
    ).toBe(true)
  })

  it('regenerates as version 4 does, the clause after the panel', () => {
    const v5 = buildChatRegenPromptV5({ ...agent, violation: 'switches tense' })
    const v4 = buildChatRegenPromptV4({ ...agent, violation: 'switches tense' })
    expect(v5.version).toBe(CHAT_REGEN_PROMPT_V5_VERSION)
    expect(v5.messages).toEqual(v4.messages)
    const withPanel = buildChatRegenPromptV5({
      ...agent,
      panel: PANEL,
      violation: 'switches tense'
    })
    expect(withPanel.messages[0]?.content).toContain(`${PANEL_BLOCK}\n\nActive scene:`)
    expect(withPanel.messages[0]?.content.endsWith("keeps the manuscript's voice.")).toBe(true)
  })

  it('costs what the golden estimate says', () => {
    const built = buildChatPromptV5({ ...plan, panel: PANEL })
    // The golden estimate: a change here means the prompt changed and needs a new version.
    expect(estimateTokens(built.messages.map((m) => m.content).join('\n'))).toBe(168)
  })
})
