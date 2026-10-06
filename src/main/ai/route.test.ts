import { describe, expect, it } from 'vitest'
import { ROUTE_INSTRUCTION_MAX } from '@shared/assistantRoute'
import { parseRouteAnswer } from './route'

describe('parseRouteAnswer (F-5.19)', () => {
  it('reads the action and the trimmed instruction', () => {
    expect(parseRouteAnswer('{"action":"rewrite","instruction":"  Make it colder. "}')).toEqual({
      action: 'rewrite',
      instruction: 'Make it colder.'
    })
    expect(parseRouteAnswer('{"action":"query","instruction":""}')).toEqual({
      action: 'query',
      instruction: null
    })
    expect(parseRouteAnswer('{"action":"whatNext"}')).toEqual({
      action: 'whatNext',
      instruction: null
    })
  })

  it('matches the action case-insensitively', () => {
    expect(parseRouteAnswer('{"action":"BetaReader","instruction":null}')).toEqual({
      action: 'betaReader',
      instruction: null
    })
  })

  it('falls back to chat for anything unreadable instead of failing the turn', () => {
    for (const text of [
      'not json',
      '[]',
      'null',
      '{"instruction":"x"}',
      '{"action":42}',
      '{"action":"translate","instruction":"into French"}'
    ]) {
      expect(parseRouteAnswer(text)).toEqual({ action: 'chat', instruction: null })
    }
  })

  it('cuts the instruction to its cap and drops one that is not a string', () => {
    const long = parseRouteAnswer(
      JSON.stringify({ action: 'notes', instruction: 'x'.repeat(ROUTE_INSTRUCTION_MAX + 50) })
    )
    expect(long.instruction).toHaveLength(ROUTE_INSTRUCTION_MAX)
    expect(parseRouteAnswer('{"action":"notes","instruction":7}')).toEqual({
      action: 'notes',
      instruction: null
    })
  })
})
