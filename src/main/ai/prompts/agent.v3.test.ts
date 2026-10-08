import { describe, expect, it } from 'vitest'
import { AGENT_RETRY_MAX_TOKENS, AGENT_STEP_MAX_TOKENS } from '@shared/agent'
import { renderStoryMap, STORY_MAP_HEADING } from '@shared/storyTime'
import { AGENT_FINAL_TURN, AGENT_RULES, renderAgentFocus } from './agent.v1'
import { AGENT_EDIT_RULES_V2, AGENT_RETRY_TURN } from './agent.v2'
import { AGENT_PROMPT_V3_VERSION, AGENT_TIME_RULES, buildAgentPromptV3 } from './agent.v3'

const FOCUS = renderAgentFocus({
  ref: 'n7',
  title: 'Chapter 1 › The ferry landing',
  level: 'scene',
  synopsis: '',
  notes: '',
  summary: '',
  beforeCaret: 'He looked at the lantern.',
  selection: ''
})
const MAP = renderStoryMap(
  [
    {
      id: 'a',
      ref: 'n7',
      title: 'The ferry landing',
      depth: 0,
      kind: 'document',
      progress: 'drafted',
      summary: 'Mara meets Tomas.'
    },
    {
      id: 'b',
      ref: 'n8',
      title: 'The war',
      depth: 0,
      kind: 'document',
      progress: 'planned',
      summary: null
    }
  ],
  { nowId: 'a', basis: 'open' },
  1_200
)

describe('agent.v3 prompt (F-5.23 story time)', () => {
  it('keeps the v1 opening and adds the story-time rule', () => {
    expect(AGENT_PROMPT_V3_VERSION).toBe('agent.v3')
    expect(AGENT_TIME_RULES).toContain('An event has happened only if the manuscript shows it')
    expect(AGENT_TIME_RULES).toContain("the author's notes and plans")
    expect(MAP).toContain(STORY_MAP_HEADING)
  })

  it('orders rules, the time rule, edit rules, the map, and the open document; then the turns', () => {
    const built = buildAgentPromptV3({
      access: 'write',
      voice: 'VOICE',
      map: MAP,
      focus: FOCUS,
      history: [{ role: 'user', content: 'Who is Tomas?' }],
      message: 'Is Pell alive?',
      steps: [{ call: '{"tool":"tags"}', result: 'Result of tags:\nTone: grim' }],
      final: true
    })
    expect(built.version).toBe('agent.v3')
    expect(built.maxTokens).toBe(AGENT_STEP_MAX_TOKENS)
    expect(built.messages).toEqual([
      {
        role: 'system',
        content: [AGENT_RULES, AGENT_TIME_RULES, AGENT_EDIT_RULES_V2, MAP, FOCUS].join('\n\n')
      },
      { role: 'user', content: 'Who is Tomas?' },
      { role: 'user', content: 'Is Pell alive?' },
      { role: 'assistant', content: '{"tool":"tags"}' },
      { role: 'user', content: 'Result of tags:\nTone: grim' },
      { role: 'user', content: AGENT_FINAL_TURN }
    ])
  })

  it('leaves the map out without one, and asks the retry at the larger cap', () => {
    const built = buildAgentPromptV3({
      access: 'read',
      voice: null,
      map: null,
      focus: null,
      history: [],
      message: 'Who owes the mill?',
      steps: [],
      final: false,
      retry: true
    })
    expect(built.messages).toEqual([
      { role: 'system', content: `${AGENT_RULES}\n\n${AGENT_TIME_RULES}\n\nNo document is open.` },
      { role: 'user', content: 'Who owes the mill?' },
      { role: 'user', content: AGENT_RETRY_TURN }
    ])
    expect(built.maxTokens).toBe(AGENT_RETRY_MAX_TOKENS)
    // The golden text of the rule: a change here is a new version.
    expect(AGENT_TIME_RULES).toMatchSnapshot()
  })
})
