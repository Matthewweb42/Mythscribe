import { describe, expect, it } from 'vitest'
import { outputBudget } from '@shared/ai'
import {
  TODO_SUGGEST_MAX_TOKENS,
  TODO_SUGGEST_PROMPT_VERSION,
  TODO_SUGGEST_RULES,
  buildTodoSuggestPrompt
} from './todoSuggest.v1'

describe('todoSuggest.v1 prompt (F-9.16)', () => {
  it('keeps the sentinel the e2e keys on, and asks for options, not facts', () => {
    expect(
      TODO_SUGGEST_RULES.startsWith('You are the To do suggestions inside a novel-writing app.')
    ).toBe(true)
    expect(TODO_SUGGEST_RULES).toContain('They are options, not facts')
    expect(TODO_SUGGEST_MAX_TOKENS).toBeLessThanOrEqual(outputBudget('todo'))
  })

  it('sends the item, its target, the sheet, and the passages; empty parts are left out', () => {
    const built = buildTodoSuggestPrompt({
      kind: 'Gap',
      subject: 'Mara',
      why: '2 scenes are told from her point of view, but no goal is stated.',
      target: 'Mara › Goals / motivations',
      current: '',
      record: 'Role: Ferry pilot',
      passages: ['Mara reached the Hollowing at dusk.', 'She did not look back.']
    })
    expect(built.version).toBe(TODO_SUGGEST_PROMPT_VERSION)
    expect(built.maxTokens).toBe(TODO_SUGGEST_MAX_TOKENS)
    expect(built.messages[1]?.content).not.toContain('It holds now')
    expect(built.messages).toMatchSnapshot()
  })
})
