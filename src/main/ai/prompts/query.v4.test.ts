import { describe, expect, it } from 'vitest'
import { estimateTokens } from '@shared/ai'
import { SCENE_PANEL_HEADING } from './chat.v5'
import { buildQueryPromptV3, QUERY_BIBLE_HEADING_V3, QUERY_RULES_V3 } from './query.v3'
import {
  buildQueryPromptV4,
  QUERY_PANEL_RULE,
  QUERY_PROMPT_V4_VERSION,
  type BuildQueryPromptV4Input
} from './query.v4'

const SCENE =
  'The ferry landing was empty when Mara reached it. The rope hung slack in the water and the ' +
  'bell had lost its clapper years ago.'
const BIBLE = 'Mara (character): Age: 31.'
const PANEL = { synopsis: 'Mara waits for Tomas.', notes: 'He is late on purpose.' }
const PANEL_BLOCK =
  `${SCENE_PANEL_HEADING}\nSynopsis: Mara waits for Tomas.\n` +
  'Notes:\n"""\nHe is late on purpose.\n"""'

const input: BuildQueryPromptV4Input = {
  full: [{ title: 'Chapter 1 › The ferry landing', text: SCENE }],
  summaries: [{ title: 'Chapter 2 › The mill', summary: 'Tomas refuses to cross.', keyPoints: [] }],
  history: [{ role: 'user', content: 'Who is Tomas?' }],
  question: 'Why is Tomas late?',
  bible: BIBLE,
  panel: null
}

describe('query.v4 prompt (F-5.20)', () => {
  it('is version 3 exactly with no panel', () => {
    for (const bible of [null, BIBLE]) {
      const v4 = buildQueryPromptV4({ ...input, bible })
      expect(v4.version).toBe(QUERY_PROMPT_V4_VERSION)
      expect(v4.version).toBe('query.v4')
      expect(v4.messages).toEqual(buildQueryPromptV3({ ...input, bible }).messages)
    }
  })

  it('puts the panel and its one rule between the story bible and the scenes, the rest unchanged', () => {
    const built = buildQueryPromptV4({ ...input, panel: PANEL })
    const system = built.messages[0]?.content ?? ''
    expect(system.startsWith(QUERY_RULES_V3)).toBe(true)
    expect(system).toContain(
      `${QUERY_BIBLE_HEADING_V3}\n${BIBLE}\n\n${PANEL_BLOCK}\n${QUERY_PANEL_RULE}\n\n` +
        'Scenes (full text):\n[1] Chapter 1 › The ferry landing'
    )
    expect(built.messages.slice(1)).toEqual(buildQueryPromptV3(input).messages.slice(1))
    const noBible = buildQueryPromptV4({ ...input, bible: null, panel: PANEL })
    expect(noBible.messages[0]?.content).toContain(
      `${QUERY_RULES_V3}\n\n${PANEL_BLOCK}\n${QUERY_PANEL_RULE}\n\nScenes (full text):`
    )
  })

  it('costs what the golden estimate says', () => {
    const built = buildQueryPromptV4({ ...input, panel: PANEL })
    // The golden estimate: a change here means the prompt changed and needs a new version.
    expect(estimateTokens(built.messages.map((m) => m.content).join('\n'))).toBe(451)
  })
})
