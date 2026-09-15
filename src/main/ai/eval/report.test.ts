import { describe, expect, it } from 'vitest'
import { estimateTokens, inputBudget, outputBudget } from '@shared/ai'
import type { EvalCase } from './fixtures'
import {
  markdownTable,
  renderLiveReport,
  renderTokenReport,
  tokenRows,
  type LiveResult
} from './report'

const aCase: EvalCase = {
  version: 'tags.v1',
  name: 'tiny',
  note: 'a two-message prompt',
  messages: [
    { role: 'system', content: 'Tag the scene with bank names only.' },
    { role: 'user', content: 'Tag bank: a, b\n\nPassage:\nThe storm broke at dusk.' }
  ],
  maxTokens: 120,
  scoring: { kind: 'json', bank: ['a', 'b'] }
}

/** The trimmed cells of one table row (an escaped pipe inside a cell is kept). */
const cells = (line: string): string[] =>
  line
    .slice(1, -1)
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim())

describe('eval report (F-5.12)', () => {
  it('tokenRows estimates the prompt the way the request path does and reads the budgets from the catalogue', () => {
    const [row] = tokenRows([aCase])
    const total = estimateTokens(aCase.messages.map((m) => m.content).join('\n'))
    expect(row).toEqual({
      version: 'tags.v1',
      since: 'F-4.7',
      name: 'tiny',
      note: 'a two-message prompt',
      system: estimateTokens('Tag the scene with bank names only.'),
      user: estimateTokens('Tag bank: a, b\n\nPassage:\nThe storm broke at dusk.'),
      total,
      inputBudget: inputBudget('tags'),
      headroom: inputBudget('tags') - total,
      maxTokens: 120,
      outputBudget: outputBudget('tags')
    })
  })

  it('renderTokenReport writes one padded table row per case under the explanation', () => {
    const [row] = tokenRows([aCase])
    if (!row) throw new Error('expected a row')
    const report = renderTokenReport([row])
    expect(report.startsWith('# Prompt token report (F-5.12)\n')).toBe(true)
    expect(report.endsWith('|\n')).toBe(true)
    const table = report.trimEnd().split('\n').slice(-3)
    expect(table[0]?.startsWith('| Prompt ')).toBe(true)
    expect(table[1]).toMatch(/^\| -+ \| -+ \|/)
    expect(cells(table[2] ?? '')).toEqual([
      'tags.v1',
      'F-4.7',
      'tiny',
      String(row.system),
      String(row.user),
      String(row.total),
      String(row.inputBudget),
      String(row.headroom),
      '120',
      String(row.outputBudget),
      'a two-message prompt'
    ])
  })

  it('renderLiveReport shows each verdict, the estimate beside the real count, and the totals', () => {
    const results: LiveResult[] = [
      {
        version: 'ghostText.v1',
        name: 'full',
        model: 'gpt-5.4-mini',
        answer: 'She lifted the lantern | and waited.',
        estimatedIn: 400,
        usage: { inputTokens: 440, outputTokens: 12 },
        costUsd: 0.00013,
        verdict: { kind: 'fidelity', ok: false, violations: ['switches to present tense'] }
      },
      {
        version: 'ghostText.v1',
        name: 'fresh',
        model: 'gpt-5.4-mini',
        answer: '',
        estimatedIn: 200,
        usage: { inputTokens: 210, outputTokens: 0 },
        costUsd: 0.00005,
        verdict: { kind: 'unscored' }
      },
      {
        version: 'tags.v1',
        name: 'fixture',
        model: 'gpt-5.4-mini',
        answer: '{"tags":["a"]}',
        estimatedIn: 100,
        usage: { inputTokens: 100, outputTokens: 5 },
        costUsd: 0.00004,
        verdict: { kind: 'json', ok: true, problem: null }
      }
    ]
    const report = renderLiveReport(results, new Date('2026-09-15T01:02:03.000Z'))
    expect(report).toContain('# Live prompt eval (2026-09-15T01:02:03.000Z)')
    const rows = report
      .split('\n')
      .filter((line) => line.startsWith('| ghost') || line.startsWith('| tags'))
    expect(rows.map(cells)).toEqual([
      [
        'ghostText.v1',
        'full',
        'gpt-5.4-mini',
        'switches to present tense',
        '440 (400)',
        '12',
        '0.00013',
        'She lifted the lantern \\| and waited.'
      ],
      ['ghostText.v1', 'fresh', 'gpt-5.4-mini', 'unscored', '210 (200)', '0', '0.00005', ''],
      ['tags.v1', 'fixture', 'gpt-5.4-mini', 'valid', '100 (100)', '5', '0.00004', '{"tags":["a"]}']
    ])
    expect(report).toContain('Scored 1 of 2 answers clean (1 unscored).')
    expect(report).toContain('Actual input tokens over the estimate: 1.07 (750 of 700 estimated).')
    expect(report).toContain('Spent 0.00022 USD over 3 requests.')
  })

  it('markdownTable pads every column to its widest cell and fills a short row', () => {
    expect(markdownTable(['A', 'Long'], [['xx', 'y'], ['z']])).toEqual([
      '| A  | Long |',
      '| -- | ---- |',
      '| xx | y    |',
      '| z  |      |'
    ])
  })
})
