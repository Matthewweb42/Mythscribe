import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { estimateTokens, outputBudget } from '@shared/ai'
import { AGENT_TOOLS_V1 } from '@shared/agent'
import {
  AGENT_EDIT_RULES,
  AGENT_FINAL_TURN,
  AGENT_PROMPT_VERSION,
  AGENT_RULES,
  buildAgentPrompt,
  renderAgentFocus
} from './agent.v1'

const FOCUS = renderAgentFocus({
  ref: 'n7',
  title: 'Chapter 1 › The ferry landing',
  level: 'scene',
  synopsis: 'Mara confronts Tomas.',
  notes: 'Ends at the elm.',
  summary: '',
  beforeCaret: 'He looked at the lantern.',
  selection: ''
})

describe('agent.v1 prompt (F-5.22)', () => {
  it("pins the e2e fake server's CHAT_AGENT_SENTINEL to this version's opening (the e2e tsconfig cannot import from src/main)", () => {
    const spec = readFileSync(join(__dirname, '../../../../e2e/smoke.spec.ts'), 'utf8')
    const match = /const CHAT_AGENT_SENTINEL =\s*"([^"]+)"/.exec(spec)
    if (!match) throw new Error('e2e/smoke.spec.ts no longer declares CHAT_AGENT_SENTINEL')
    expect(AGENT_RULES.startsWith(match[1]!)).toBe(true)
  })

  it('lists every tool in the stable rules and asks for one JSON object', () => {
    expect(AGENT_PROMPT_VERSION).toBe('agent.v1')
    for (const tool of AGENT_TOOLS_V1) expect(AGENT_RULES).toContain(`- ${tool} {`)
    expect(
      AGENT_RULES.startsWith(
        "You are the assistant inside a novel-writing app, working for the book's author."
      )
    ).toBe(true)
    expect(AGENT_RULES).toContain('Reply with one JSON object and nothing else')
    for (const edit of ['text', 'insert', 'synopsis', 'notes', 'sheet', 'create', 'rename']) {
      expect(AGENT_EDIT_RULES).toContain(`{"edit":"${edit}"`)
    }
  })

  it('renders the open document with only the parts it has', () => {
    expect(FOCUS).toBe(
      'Open document n7: Chapter 1 › The ferry landing (scene)\n' +
        'Synopsis: Mara confronts Tomas.\n' +
        'Notes:\nEnds at the elm.\n' +
        'Text before the caret:\n"""\nHe looked at the lantern.\n"""'
    )
  })

  it('orders rules, edit rules, voice, and the open document in the system turn, then history, the message, and the steps', () => {
    const built = buildAgentPrompt({
      access: 'write',
      voice: 'VOICE',
      focus: FOCUS,
      history: [
        { role: 'user', content: 'Who is Tomas?' },
        { role: 'assistant', content: 'The man the mill owes.' }
      ],
      message: 'Tighten the last line.',
      steps: [{ call: '{"tool":"tags"}', result: 'Result of tags:\nTone: grim' }],
      final: true
    })
    expect(built.version).toBe('agent.v1')
    expect(built.maxTokens).toBe(outputBudget('agent'))
    expect(built.messages).toEqual([
      { role: 'system', content: `${AGENT_RULES}\n\n${AGENT_EDIT_RULES}\n\nVOICE\n\n${FOCUS}` },
      { role: 'user', content: 'Who is Tomas?' },
      { role: 'assistant', content: 'The man the mill owes.' },
      { role: 'user', content: 'Tighten the last line.' },
      { role: 'assistant', content: '{"tool":"tags"}' },
      { role: 'user', content: 'Result of tags:\nTone: grim' },
      { role: 'user', content: AGENT_FINAL_TURN }
    ])
  })

  it('sends a read run without the edit rules, and says when nothing is open', () => {
    const built = buildAgentPrompt({
      access: 'read',
      voice: 'VOICE',
      focus: null,
      history: [],
      message: 'Who owes the mill?',
      steps: [],
      final: false
    })
    expect(built.messages).toEqual([
      { role: 'system', content: `${AGENT_RULES}\n\nVOICE\n\nNo document is open.` },
      { role: 'user', content: 'Who owes the mill?' }
    ])
    // The golden estimate of the rules: a change here means the prompt changed and needs a new version.
    expect(estimateTokens(`${AGENT_RULES}\n\n${AGENT_EDIT_RULES}`)).toBe(GOLDEN_RULES_TOKENS)
  })
})

/** The estimate of the full rules (read rules plus edit rules) when agent.v1 shipped. */
const GOLDEN_RULES_TOKENS = 678
