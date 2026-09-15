import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { inputBudget, outputBudget, priceFor } from '@shared/ai'
import { toTagName } from '@shared/tags'
import { checkGhostTextFidelity } from '@shared/voiceFidelity'
import { checkChatFidelity, postProcessChatText } from '../chat'
import { postProcessGhostText } from '../ghostText'
import { buildOpenAiProvider } from '../providers/openai'
import { PROMPT_CATALOGUE, PROMPT_VERSIONS } from '../prompts/catalogue'
import { EVAL_CASES, FIXTURE_PROFILE, type EvalCase } from './fixtures'
import { renderLiveReport, renderTokenReport, tokenRows, type LiveResult } from './report'

/**
 * The prompt eval harness (F-5.12), `npm run eval:ai`. Offline (always, part of `npm run
 * test`): every catalogued version has cases, every case fits its budgets, and the token
 * report matches the committed `token-report.md` (accept a change with `-u`; the file's diff
 * is the token delta a prompt change reports). Live (`MYTHSCRIBE_EVAL_LIVE=1` with an
 * `OPENAI_API_KEY`, optionally `OPENAI_BASE_URL`): every case goes to the provider once, the
 * answers are post-processed and scored as the features score them, and the report is printed
 * and written under `test-results/eval-ai/`. The live run never touches the key store, the
 * ledger, or a project: it is a developer tool, not the app.
 */

const LIVE = process.env.MYTHSCRIBE_EVAL_LIVE === '1'
const TOKEN_REPORT = './token-report.md'

describe('prompt eval harness (F-5.12)', () => {
  it('has at least one case for every catalogued prompt version, in catalogue order', () => {
    const covered = [...new Set(EVAL_CASES.map((c) => c.version))]
    expect(covered).toEqual([...PROMPT_VERSIONS])
  })

  it('the fixture profile carries voice rules and an exemplar, so the voice block is exercised', () => {
    expect(FIXTURE_PROFILE.rules.length).toBeGreaterThan(0)
    expect(FIXTURE_PROFILE.exemplars).toHaveLength(1)
    const full = EVAL_CASES.find((c) => c.version === 'ghostText.v1' && c.name === 'full')
    expect(full?.messages[0]?.content).toContain("Match the author's voice:")
  })

  it('every case fits its feature input budget and never asks for more than the output cap', () => {
    for (const row of tokenRows(EVAL_CASES)) {
      const label = `${row.version} / ${row.name}`
      expect(row.total, `${label} is over the ${row.version} input budget`).toBeLessThanOrEqual(
        inputBudget(PROMPT_CATALOGUE[row.version].feature)
      )
      expect(row.maxTokens, `${label} asks for more than its output cap`).toBeLessThanOrEqual(
        outputBudget(PROMPT_CATALOGUE[row.version].feature)
      )
    }
  })

  it('the token report matches the committed baseline (accept a change with `npm run eval:ai -- -u`)', async () => {
    await expect(renderTokenReport(tokenRows(EVAL_CASES))).toMatchFileSnapshot(TOKEN_REPORT)
  })
})

const TagsAnswer = z.object({ tags: z.array(z.string()) })

function scoreJson(
  c: EvalCase & { scoring: { kind: 'json' } },
  answer: string
): LiveResult['verdict'] {
  let parsed: unknown
  try {
    parsed = JSON.parse(answer)
  } catch {
    return { kind: 'json', ok: false, problem: 'not JSON' }
  }
  const result = TagsAnswer.safeParse(parsed)
  if (!result.success) return { kind: 'json', ok: false, problem: 'not { tags: string[] }' }
  const bank = new Set(c.scoring.bank)
  const unknown = result.data.tags.map(toTagName).filter((name) => !bank.has(name))
  return unknown.length === 0
    ? { kind: 'json', ok: true, problem: null }
    : { kind: 'json', ok: false, problem: `not in the bank: ${unknown.join(', ')}` }
}

describe.skipIf(!LIVE)('live prompt eval (MYTHSCRIBE_EVAL_LIVE=1)', () => {
  it('sends every case once, scores the answers, and writes the fidelity report', async () => {
    const key = process.env.OPENAI_API_KEY
    if (!key) throw new Error('The live eval needs OPENAI_API_KEY in the environment.')
    const provider = buildOpenAiProvider(key)
    const results: LiveResult[] = []
    for (const c of EVAL_CASES) {
      const entry = PROMPT_CATALOGUE[c.version]
      const estimatedIn = tokenRows([c])[0]?.total ?? 0
      const reply = await provider.complete({
        tier: entry.tier,
        messages: c.messages,
        maxTokens: c.maxTokens,
        json: entry.output === 'json',
        ...(c.temperature === undefined ? {} : { temperature: c.temperature })
      })
      const { costUsd } = priceFor(reply.model, reply.usage.inputTokens, reply.usage.outputTokens)
      const base = {
        version: c.version,
        name: c.name,
        model: reply.model,
        estimatedIn,
        usage: reply.usage,
        costUsd
      }
      if (c.scoring.kind === 'json') {
        results.push({
          ...base,
          answer: reply.text,
          verdict: scoreJson({ ...c, scoring: c.scoring }, reply.text)
        })
        continue
      }
      const answer =
        c.scoring.kind === 'chat'
          ? postProcessChatText(reply.text)
          : postProcessGhostText(reply.text, c.scoring.before, c.scoring.after)
      const profile = c.scoring.profile
      if (profile === null || answer === '') {
        results.push({ ...base, answer, verdict: { kind: 'unscored' } })
        continue
      }
      const violations =
        c.scoring.kind === 'chat'
          ? checkChatFidelity(profile, answer)
          : checkGhostTextFidelity(profile, answer).violations
      results.push({
        ...base,
        answer,
        verdict: {
          kind: 'fidelity',
          ok: violations.length === 0,
          violations: violations.map((v) => v.message)
        }
      })
    }
    const report = renderLiveReport(results, new Date())
    const dir = path.resolve('test-results/eval-ai')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'live-report.md'), report)
    process.stdout.write(`\n${report}\n`)
    expect(results).toHaveLength(EVAL_CASES.length)
  }, 120_000)
})
