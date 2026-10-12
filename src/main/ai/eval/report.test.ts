import { describe, expect, it } from 'vitest'
import { AI_FEATURE_IDS, estimateTokens, inputBudget, outputBudget } from '@shared/ai'
import {
  PLANNED_COST_NOTES,
  PLANNED_TASK_COSTS,
  SHIPPED_PLAN_ROWS,
  type PlannedTask
} from '@shared/aiCostNotes'
import { isPromptVersion } from '../prompts/catalogue'
import { plannedTaskCost, renderCostRegistry } from './costRegistry'
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

describe('the planned story-memory costs (F-16.1, design Part 5)', () => {
  const task = (id: string): PlannedTask => {
    const found = PLANNED_TASK_COSTS.find((candidate) => candidate.id === id)
    if (found === undefined) throw new Error(`no task ${id}`)
    return found
  }

  it.each([
    ['index', 0.12],
    ['openQuestion', 0.015],
    ['openQuestionWidened', 0.03],
    ['session', 0.013],
    ['checkBook', 0.035],
    ['whatIf', 0.11]
  ] as const)(
    'keeps %s within ±30 %% of the design’s figure at the corrected prices',
    (id, design) => {
      const cost = plannedTaskCost(task(id), 'ownKey')
      expect(cost).toBeGreaterThan(design * 0.7)
      expect(cost).toBeLessThan(design * 1.3)
    }
  )

  it('averages an open question near the design’s 2¢ with one in five widened', () => {
    const average =
      0.8 * plannedTaskCost(task('openQuestion'), 'ownKey') +
      0.2 * plannedTaskCost(task('openQuestionWidened'), 'ownKey')
    expect(average).toBeGreaterThan(0.02 * 0.7)
    expect(average).toBeLessThan(0.02 * 1.3)
  })

  it('keeps the heavy month inside the design’s $1.60–2.30, give or take 30 %', () => {
    const month = plannedTaskCost(task('heavyMonth'), 'ownKey')
    expect(month).toBeGreaterThan(1.6 * 0.7)
    expect(month).toBeLessThan(2.3 * 1.3)
  })

  it('marks a planned feature existing exactly when it is already an AiFeatureId', () => {
    const known: readonly string[] = AI_FEATURE_IDS
    for (const row of PLANNED_COST_NOTES) {
      expect(row.existing, row.id).toBe(known.includes(row.feature))
    }
    // The planned new ids are new: none collides with a feature id this build has.
    const fresh = [...new Set(PLANNED_COST_NOTES.filter((r) => !r.existing).map((r) => r.feature))]
    expect(fresh.sort()).toEqual(['cite', 'judge', 'navigator'])
    expect(fresh.some((feature) => known.includes(feature))).toBe(false)
  })

  it('names only planned or shipped rows in the tasks, and every row once', () => {
    const ids = [...PLANNED_COST_NOTES, ...SHIPPED_PLAN_ROWS].map((row) => row.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const planned of PLANNED_TASK_COSTS) {
      for (const { row } of planned.calls) expect(ids).toContain(row)
    }
  })

  it('F-16.9, F-16.17, F-16.20, F-16.21: the shipped rows left the planned table and their prompts are catalogued', () => {
    expect(SHIPPED_PLAN_ROWS.map((row) => row.id)).toEqual([
      'contextImport.v3',
      'reviewChat.v3',
      'reader.v1:first',
      'reader.v1:window',
      'verify.v1',
      'verify.v1:pro',
      'verify.v1:spot',
      'reader.v1:card',
      'synopsis.v2',
      'notesSuggest.v4',
      'planLinks.v2'
    ])
    for (const row of SHIPPED_PLAN_ROWS) {
      expect(PLANNED_COST_NOTES.some((planned) => planned.id === row.id)).toBe(false)
      expect(isPromptVersion(row.prompt), row.prompt).toBe(true)
    }
    // The upload task is still priced from the design's sizes: 14 chunks, about 15¢ on an own key.
    const upload = PLANNED_TASK_COSTS.find((task) => task.id === 'upload')
    if (upload === undefined) throw new Error('no upload task')
    const cost = plannedTaskCost(upload, 'ownKey')
    expect(cost).toBeGreaterThan(0.15 * 0.7)
    expect(cost).toBeLessThan(0.15 * 1.3)
    // P2a is shipped: none of its rows is planned any more.
    expect(PLANNED_COST_NOTES.filter((row) => row.phase === 'P2a')).toEqual([])
  })

  it('renders both planned tables into the registry', () => {
    const registry = renderCostRegistry([])
    expect(registry).toContain('## Planned: story memory (F-16)')
    for (const row of PLANNED_COST_NOTES) expect(registry).toContain(`| \`${row.id}\` |`)
    for (const planned of PLANNED_TASK_COSTS) expect(registry).toContain(`| ${planned.label} |`)
  })
})
