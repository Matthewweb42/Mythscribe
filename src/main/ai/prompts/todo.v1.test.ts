import { describe, expect, it } from 'vitest'
import { outputBudget } from '@shared/ai'
import { TODO_PROMPT_VERSION, TODO_RULES, buildTodoPrompt } from './todo.v1'

describe('todo.v1 prompt (F-9.16)', () => {
  it('keeps the sentinel the e2e keys on, and says suggestions are options, never facts', () => {
    expect(TODO_RULES.startsWith('You are the To do check inside a novel-writing app.')).toBe(true)
    expect(TODO_RULES).toContain('Never fill one.')
    expect(TODO_RULES).toContain('never facts')
  })

  it('sends the rules alone, the book next, and what is listed or settled last', () => {
    const built = buildTodoPrompt({
      digest: ['Mara (character): blank goals', 'Hollowing (world item): empty'],
      threads: ['The missing ferry: where did it go?'],
      scenes: ['S1 "The quay" · the first night · POV Mara · Mara hears the Hollowing.'],
      listed: ['A1 term: Hollowing', 'noGoal: Mara'],
      settled: []
    })
    expect(built.version).toBe(TODO_PROMPT_VERSION)
    expect(built.maxTokens).toBe(outputBudget('todo'))
    expect(built.messages.map((message) => message.role)).toEqual(['system', 'user', 'user'])
    expect(built.messages[2]?.content).toContain('Settled:\n(none)')
    expect(built.messages).toMatchSnapshot()
  })
})
