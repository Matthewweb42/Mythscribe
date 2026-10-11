import { describe, expect, it } from 'vitest'
import { ROUTE_CHAPTER_MAX, ROUTE_INSTRUCTION_MAX } from '@shared/assistantRoute'
import { parseRouteAnswer } from './route'

const chat = { action: 'chat', instruction: null, edit: null }

describe('parseRouteAnswer (F-5.19)', () => {
  it('reads the action and the trimmed instruction', () => {
    expect(parseRouteAnswer('{"action":"rewrite","instruction":"  Make it colder. "}')).toEqual({
      action: 'rewrite',
      instruction: 'Make it colder.',
      edit: null
    })
    expect(parseRouteAnswer('{"action":"query","instruction":""}')).toEqual({
      action: 'query',
      instruction: null,
      edit: null
    })
    expect(parseRouteAnswer('{"action":"whatNext"}')).toEqual({
      action: 'whatNext',
      instruction: null,
      edit: null
    })
  })

  it('matches the action case-insensitively', () => {
    expect(parseRouteAnswer('{"action":"BetaReader","instruction":null}')).toEqual({
      action: 'betaReader',
      instruction: null,
      edit: null
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
      expect(parseRouteAnswer(text)).toEqual(chat)
    }
  })

  it('cuts the instruction to its cap and drops one that is not a string', () => {
    const long = parseRouteAnswer(
      JSON.stringify({ action: 'notes', instruction: 'x'.repeat(ROUTE_INSTRUCTION_MAX + 50) })
    )
    expect(long.instruction).toHaveLength(ROUTE_INSTRUCTION_MAX)
    expect(parseRouteAnswer('{"action":"notes","instruction":7}')).toEqual({
      action: 'notes',
      instruction: null,
      edit: null
    })
  })
})

describe('parseRouteAnswer for edit passes (route.v2, F-5.26)', () => {
  it("reads an edit pass's pass, target, and chapter", () => {
    expect(
      parseRouteAnswer(
        '{"action":"editPass","instruction":"","pass":"Proofread","target":"chapter","chapter":" Chapter 3 "}'
      )
    ).toEqual({
      action: 'editPass',
      instruction: null,
      edit: { pass: 'proofread', target: 'chapter', chapter: 'Chapter 3' }
    })
    expect(
      parseRouteAnswer(
        '{"action":"editPass","instruction":"Sharpen the banter.","pass":"dialogue","target":"selection","chapter":""}'
      )
    ).toEqual({
      action: 'editPass',
      instruction: 'Sharpen the banter.',
      edit: { pass: 'dialogue', target: 'selection', chapter: null }
    })
  })

  it('reads a missing or unknown pass as ask and target as the scene, and caps the chapter', () => {
    expect(parseRouteAnswer('{"action":"editPass"}')).toEqual({
      action: 'editPass',
      instruction: null,
      edit: { pass: 'ask', target: 'scene', chapter: null }
    })
    const long = parseRouteAnswer(
      JSON.stringify({
        action: 'editPass',
        pass: 'polish',
        target: 'book',
        chapter: 'c'.repeat(ROUTE_CHAPTER_MAX + 9)
      })
    )
    expect(long.edit).toMatchObject({ pass: 'ask', target: 'scene' })
    expect(long.edit?.chapter).toHaveLength(ROUTE_CHAPTER_MAX)
  })

  it('ignores edit fields on any other action', () => {
    expect(parseRouteAnswer('{"action":"critique","pass":"line","target":"scene"}')).toEqual({
      action: 'critique',
      instruction: null,
      edit: null
    })
  })
})
