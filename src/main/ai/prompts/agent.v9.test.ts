import { describe, expect, it } from 'vitest'
import { estimateTokens } from '@shared/ai'
import { AGENT_RETRY_MAX_TOKENS } from '@shared/agent'
import {
  SCRIBE_REASONING_TOKENS,
  SCRIBE_ROSTER_TOKENS,
  SCRIBE_SCENE_MAX_TOKENS,
  scribeMaxTokens
} from '@shared/scribe'
import { scribeHistory, type HistoryTurn } from '@shared/scribeAnswer'
import { AGENT_EDIT_RULES_V2, AGENT_RETRY_TURN } from './agent.v2'
import {
  AGENT_PROMPT_V9_VERSION,
  AGENT_V9_EDIT_TOOLS,
  AGENT_V9_HISTORY_LABEL,
  AGENT_V9_NO_SCENE,
  AGENT_V9_RULES,
  AGENT_V9_SENTINEL,
  AGENT_V9_WIDENED_HEADING,
  agentV9System,
  buildAgentPromptV9,
  renderScribeScene,
  SCENE_CUT_MARK,
  scribeRoster,
  scribeRosterLine,
  type BuildAgentPromptV9Input
} from './agent.v9'

const SCENE = renderScribeScene({
  ref: '1.1',
  label: 'happened',
  title: 'The quay',
  paragraphs: ['Mara watched the quay.', 'Tomas sold the map.', 'Orrin overheard Tomas.'],
  caretPara: 2,
  selection: null
}).text

const input = (over: Partial<BuildAgentPromptV9Input> = {}): BuildAgentPromptV9Input => ({
  access: 'read',
  turn: 'answer',
  roster: ['Mara Vell (Mara; Mars)', 'Orrin', 'Tomas'],
  history: [],
  voice: null,
  scene: SCENE,
  evidence: 'E1 [happened, 1.1 ¶1] The quay\nTomas sold the map.',
  widened: null,
  searched: null,
  question: 'What did Orrin hear?',
  ...over
})

/** Eight earlier turns: the conversation at its eighth question. */
const TURNS: HistoryTurn[] = Array.from({ length: 14 }, (_, i) => ({
  role: i % 2 === 0 ? 'user' : 'assistant',
  content:
    i % 2 === 0
      ? `Question ${i / 2 + 1} about Mara and the quay?`
      : `Answer ${(i + 1) / 2}: Mara watched the quay. [E0 "Mara watched the quay"] She waited for the ferry and counted the lamps along the water, one by one, until the tide turned.`
}))

describe('agent.v9 prompt (F-16.25, F-16.26)', () => {
  it('opens with the sentinel and keeps rules and the edit list under 1,200 tokens', () => {
    expect(AGENT_V9_RULES.startsWith(AGENT_V9_SENTINEL)).toBe(true)
    expect(estimateTokens(AGENT_V9_RULES)).toBeLessThanOrEqual(750)
    expect(estimateTokens(AGENT_V9_EDIT_TOOLS)).toBeLessThanOrEqual(450)
    expect(estimateTokens(`${AGENT_V9_RULES}\n\n${AGENT_V9_EDIT_TOOLS}`)).toBeLessThanOrEqual(1_200)
  })

  it('says the rules the answer is checked on: the citation form, labels, scope, need, pins', () => {
    for (const rule of [
      '[E7 "exact words from E7"]',
      'Never cite a map.',
      '"your idea, not in the book"',
      'Never say someone does not know something',
      '"found":false',
      '{"need":"chapter 9"}',
      '"place":"ask"',
      'Without the edit list, say what you would add'
    ]) {
      expect(AGENT_V9_RULES).toContain(rule)
    }
  })

  it('keeps agent.v2’s brief sentence word for word, and pin among the edits', () => {
    const brief =
      'Never write manuscript prose yourself: for new or rewritten prose give a "brief" (what ' +
      'to write, in a sentence or two: who, what happens, the beat) and the app drafts it in the ' +
      "author's voice."
    expect(AGENT_EDIT_RULES_V2).toContain(brief)
    expect(AGENT_V9_EDIT_TOOLS.replace(/\n/g, ' ')).toContain(brief)
    for (const edit of ['insert', 'text', 'synopsis', 'notes', 'create', 'rename', 'move']) {
      expect(AGENT_V9_EDIT_TOOLS).toContain(`{"edit":"${edit}"`)
    }
    for (const edit of ['split', 'merge', 'delete', 'undo', 'pin']) {
      expect(AGENT_V9_EDIT_TOOLS).toContain(`{"edit":"${edit}"`)
    }
    // The kinds v2 never offers are not offered.
    for (const edit of ['tag', 'sheet', 'status', 'todo', 'clear', 'summaries', 'open']) {
      expect(AGENT_V9_EDIT_TOOLS).not.toContain(`{"edit":"${edit}"`)
    }
  })

  it('orders a read run: rules, roster in the system turn; then the history; then E0, evidence, question', () => {
    const built = buildAgentPromptV9(input({ history: [{ role: 'user', content: 'Earlier?' }] }))
    expect(built.version).toBe(AGENT_PROMPT_V9_VERSION)
    expect(built.messages.map((m) => m.role)).toEqual(['system', 'user', 'user'])
    const system = built.messages[0]?.content ?? ''
    expect(system).toBe(agentV9System('read', input().roster))
    expect(system).not.toContain(AGENT_V9_EDIT_TOOLS)
    expect(
      system.endsWith('Records (names and nicknames):\nMara Vell (Mara; Mars)\nOrrin\nTomas')
    ).toBe(true)
    expect(built.messages[1]?.content).toBe(`${AGENT_V9_HISTORY_LABEL} Earlier?`)
    const user = built.messages[2]?.content ?? ''
    expect(user).toBe(
      `${SCENE}\n\nEvidence:\nE1 [happened, 1.1 ¶1] The quay\nTomas sold the map.\n\nQuestion: What did Orrin hear?`
    )
    expect(built.reasoning).toBe('off')
    expect(built.maxTokens).toBe(700)
  })

  it('a write run adds the edit list after the rules, and an edit turn the voice first, reasoning low', () => {
    const built = buildAgentPromptV9(
      input({ access: 'write', turn: 'edit', voice: 'Match the author’s voice:\n- Short.' })
    )
    const system = built.messages[0]?.content ?? ''
    expect(system.indexOf(AGENT_V9_EDIT_TOOLS)).toBeGreaterThan(system.indexOf(AGENT_V9_RULES))
    expect(system.indexOf('Records (names')).toBeGreaterThan(system.indexOf(AGENT_V9_EDIT_TOOLS))
    const user = built.messages.at(-1)?.content ?? ''
    expect(user.startsWith('Match the author’s voice:')).toBe(true)
    expect(user.indexOf('E0 [')).toBeGreaterThan(0)
    expect(built.reasoning).toBe('low')
    expect(built.maxTokens).toBe(1_500 + SCRIBE_REASONING_TOKENS)
  })

  it('the turn-8 fixture: the system turn is byte-identical to turn 1, older turns one line', () => {
    const first = buildAgentPromptV9(input({ history: [] }))
    const history = scribeHistory(TURNS)
    const eighth = buildAgentPromptV9(
      input({ history, question: 'Question 8: where does Mara wait?' })
    )
    expect(eighth.messages[0]?.content).toBe(first.messages[0]?.content)
    // History stays under 1,500 tokens; the older turns are one line each, citations stripped.
    expect(estimateTokens(history.map((turn) => turn.content).join('\n'))).toBeLessThanOrEqual(
      1_500
    )
    const oldest = eighth.messages[2]?.content ?? ''
    expect(oldest).not.toContain('[E0')
    expect(oldest.split(/\s+/u).length).toBeLessThanOrEqual(30)
    for (const turn of eighth.messages.slice(1, -1)) {
      expect(turn.content.startsWith(AGENT_V9_HISTORY_LABEL)).toBe(true)
    }
  })

  it('a lookup turn: 300 out; the retry: the larger cap and the retry turn last', () => {
    expect(buildAgentPromptV9(input({ turn: 'lookup' })).maxTokens).toBe(scribeMaxTokens('lookup'))
    expect(scribeMaxTokens('lookup')).toBe(300)
    const retry = buildAgentPromptV9(input({ retry: true }))
    expect(retry.maxTokens).toBe(AGENT_RETRY_MAX_TOKENS)
    expect(retry.messages.at(-1)).toEqual({ role: 'user', content: AGENT_RETRY_TURN })
  })

  it('a widened request carries the chapter after the evidence, then the Searched line and the question', () => {
    const user =
      buildAgentPromptV9(
        input({
          widened: { what: 'chapter 1 (1.1–1.2)', text: 'W1 [happened, 1.2 ¶0–1] Two\n¶0 …' },
          searched: 'Searched every scene up to 1.1 for map'
        })
      ).messages.at(-1)?.content ?? ''
    const order = [
      'E0 [',
      'Evidence:',
      `${AGENT_V9_WIDENED_HEADING}, chapter 1 (1.1–1.2):`,
      'Searched every scene up to 1.1 for map.',
      'Question:'
    ].map((part) => user.indexOf(part))
    expect(order.every((at) => at >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  it('says so when no scene is open', () => {
    expect(buildAgentPromptV9(input({ scene: null })).messages.at(-1)?.content).toContain(
      AGENT_V9_NO_SCENE
    )
  })
})

describe('renderScribeScene (P3-D10)', () => {
  it('numbers every paragraph, notes the caret and the selection, and a write run’s ids', () => {
    const rendered = renderScribeScene({
      ref: '1.1',
      label: 'happened',
      title: 'The quay',
      paragraphs: ['One.', 'Two.'],
      caretPara: 1,
      selection: 'Two',
      id: 'n5',
      parentId: 'n4'
    })
    expect(rendered.text).toBe(
      'E0 [happened, the open scene 1.1, id n5 in n4] The quay\n¶0 One.\n¶1 Two.\n' +
        "The author's caret is in ¶1.\nSelected: “Two”"
    )
    expect(rendered.shown).toEqual([0, 1])
  })

  it('over the cap, sends the paragraphs around the caret and names the ones left out', () => {
    const paragraphs = Array.from({ length: 80 }, (_, i) => `Paragraph ${i} ${'word '.repeat(150)}`)
    const rendered = renderScribeScene({
      ref: '3.2',
      label: 'happened',
      title: 'Long',
      paragraphs,
      caretPara: 40,
      selection: null
    })
    expect(estimateTokens(rendered.text)).toBeLessThanOrEqual(SCRIBE_SCENE_MAX_TOKENS + 50)
    expect(rendered.shown).toContain(40)
    const first = rendered.shown[0] ?? 0
    const last = rendered.shown.at(-1) ?? 0
    expect(first).toBeGreaterThan(0)
    expect(last).toBeLessThan(79)
    expect(rendered.text).toContain(`(¶0–${first - 1} and ¶${last + 1}–79 not shown)`)
    expect(rendered.sent.map((line) => line.para)).toEqual(rendered.shown)
  })

  it('shortens one paragraph over the cap alone to its opening and end, and says so', () => {
    const long = Array.from({ length: 12_000 }, (_, i) => `w${i}`).join(' ')
    const rendered = renderScribeScene({
      ref: '3.2',
      label: 'happened',
      title: 'Imported',
      paragraphs: ['Short opening.', long],
      caretPara: 1,
      selection: null
    })
    expect(estimateTokens(rendered.text)).toBeLessThanOrEqual(SCRIBE_SCENE_MAX_TOKENS + 50)
    expect(rendered.shown).toEqual([1])
    const [head, tail] = rendered.sent[0]?.parts ?? []
    expect(long.startsWith(head ?? '?')).toBe(true)
    expect(long.endsWith(tail ?? '?')).toBe(true)
    expect(rendered.text).toContain(`¶1 ${head ?? ''} ${SCENE_CUT_MARK} ${tail ?? ''}`)
    expect(rendered.text).toContain('(¶0 not shown)')
    expect(rendered.text).toContain('(¶1 shortened: its middle not shown)')
  })

  it('labels an Idea scene as one', () => {
    expect(
      renderScribeScene({
        ref: 'What if',
        label: 'ideaScene',
        title: 'What if',
        paragraphs: ['Maybe.'],
        caretPara: null,
        selection: null
      }).text.split('\n')[0]
    ).toBe('E0 [idea scene, the open scene What if] What if')
  })
})

describe('scribeRoster', () => {
  it('lists names and nicknames in creation order, the least named left out past the cap', () => {
    expect(scribeRosterLine({ name: 'Mara Vell', nicknames: ['Mara', 'Mars'] })).toBe(
      'Mara Vell (Mara; Mars)'
    )
    const records = Array.from({ length: 300 }, (_, i) => ({
      id: `r${String(i).padStart(3, '0')}`,
      name: `Character Number ${i}`,
      nicknames: [`Number ${i}`],
      created: `2026-10-01T00:00:${String(i % 60).padStart(2, '0')}.${String(i).padStart(3, '0')}Z`
    }))
    const named = new Map([['r000', 50]])
    const roster = scribeRoster(records, named)
    expect(estimateTokens(roster.join('\n'))).toBeLessThanOrEqual(SCRIBE_ROSTER_TOKENS)
    expect(roster).toContain('Character Number 0 (Number 0)')
    expect(roster.length).toBeLessThan(records.length)
  })
})
