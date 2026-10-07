import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { inputBudget, outputBudget, priceFor } from '@shared/ai'
import { AUTHOR_RULES_HEADER } from '@shared/authorRules'
import { findQuote } from '@shared/critique'
import { SCENE_BRIEF_FIELD_MAX } from '@shared/sceneMeta'
import { SceneSummary } from '@shared/summary'
import { toTagName } from '@shared/tags'
import { checkGhostTextFidelity } from '@shared/voiceFidelity'
import { WHAT_NEXT_DIRECTIONS } from '@shared/whatNext'
import { parseAgentReply } from '../agent'
import { checkChatFidelity, postProcessChatText } from '../chat'
import { postProcessGhostText } from '../ghostText'
import { buildOpenAiProvider } from '../providers/openai'
import { PROMPT_CATALOGUE, PROMPT_VERSIONS } from '../prompts/catalogue'
import { parseProofreadAnswer } from '../proofread'
import { parseRouteAnswer } from '../route'
import { parseNotesSuggestAnswer, parseSynopsisAnswer } from '../sceneSuggest'
import { parseSummaryAnswer } from '../summarize'
import { parseVoiceNotesAnswer } from '../voiceNotes'
import { parseWhatNextAnswer } from '../whatNext'
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

  it('the fixture profile carries voice rules, an exemplar, and author rules, so the whole voice block is exercised', () => {
    expect(FIXTURE_PROFILE.rules.length).toBeGreaterThan(0)
    expect(FIXTURE_PROFILE.exemplars).toHaveLength(1)
    expect(FIXTURE_PROFILE.authorRules.bannedPhrases.length).toBeGreaterThan(0)
    const full = EVAL_CASES.find((c) => c.version === 'ghostText.v1' && c.name === 'full')
    const system = full?.messages[0]?.content ?? ''
    expect(system).toContain("Match the author's voice:")
    // F-14.2: the author's rules sit between the stylometric rules and the exemplars.
    expect(system.indexOf(AUTHOR_RULES_HEADER)).toBeGreaterThan(
      system.indexOf("Match the author's voice:")
    )
    expect(system.indexOf(AUTHOR_RULES_HEADER)).toBeLessThan(
      system.indexOf('Example in this voice:')
    )
    expect(system).toContain('Never use these phrases: ')
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

const CritiqueAnswer = z.object({
  notes: z.array(z.object({ quote: z.string() }))
})

/**
 * An editor's-notes answer (F-14.8) scores like the JSON one: it must parse to the shape the
 * prompt asks for, and — the rule the feature turns on — every note must quote the scene that
 * was sent, matched exactly as `runCritique` matches it.
 */
function scoreCritique(sceneText: string, answer: string): LiveResult['verdict'] {
  let parsed: unknown
  try {
    parsed = JSON.parse(answer)
  } catch {
    return { kind: 'json', ok: false, problem: 'not JSON' }
  }
  const result = CritiqueAnswer.safeParse(parsed)
  if (!result.success) return { kind: 'json', ok: false, problem: 'not { notes: [{ quote }] }' }
  const uncited = result.data.notes.filter((note) => !findQuote(sceneText, note.quote)).length
  return uncited === 0
    ? { kind: 'json', ok: true, problem: null }
    : { kind: 'json', ok: false, problem: `${uncited} of ${result.data.notes.length} uncited` }
}

const BetaReaderAnswer = z.object({
  items: z.array(z.object({ scene: z.number(), quote: z.string() }))
})

/**
 * A beta-reader report (F-14.11) scores on the rule the feature turns on: it must parse to the
 * shape the prompt asks for, and every item must name one of the scenes that were sent and
 * quote that scene, matched exactly as `runBetaReader` matches it.
 */
function scoreBetaReader(texts: string[], answer: string): LiveResult['verdict'] {
  let parsed: unknown
  try {
    parsed = JSON.parse(answer)
  } catch {
    return { kind: 'json', ok: false, problem: 'not JSON' }
  }
  const result = BetaReaderAnswer.safeParse(parsed)
  if (!result.success)
    return { kind: 'json', ok: false, problem: 'not { items: [{ scene, quote }] }' }
  const uncited = result.data.items.filter((item) => {
    const source = Number.isInteger(item.scene) ? texts[item.scene - 1] : undefined
    return source === undefined || !findQuote(source, item.quote)
  }).length
  return uncited === 0
    ? { kind: 'json', ok: true, problem: null }
    : { kind: 'json', ok: false, problem: `${uncited} of ${result.data.items.length} uncited` }
}

const QueryAnswer = z.object({
  answer: z.string(),
  citations: z.array(z.object({ scene: z.number(), quote: z.string() })).optional()
})

/**
 * A Story Intelligence answer (F-5.7) scores on the rule the feature turns on: it must parse to
 * the shape the prompt asks for, and every citation must name one of the scenes that were sent
 * in full and quote that scene, matched exactly as `runQuery` matches it. A `found: false`
 * answer carries no citations, so it scores as a pass: "not found" is a valid grounded answer.
 */
function scoreQuery(texts: string[], answer: string): LiveResult['verdict'] {
  let parsed: unknown
  try {
    parsed = JSON.parse(answer)
  } catch {
    return { kind: 'json', ok: false, problem: 'not JSON' }
  }
  const result = QueryAnswer.safeParse(parsed)
  if (!result.success) {
    return { kind: 'json', ok: false, problem: 'not { answer, citations: [{ scene, quote }] }' }
  }
  const citations = result.data.citations ?? []
  const uncited = citations.filter((citation) => {
    const source = Number.isInteger(citation.scene) ? texts[citation.scene - 1] : undefined
    return source === undefined || !findQuote(source, citation.quote)
  }).length
  return uncited === 0
    ? { kind: 'json', ok: true, problem: null }
    : { kind: 'json', ok: false, problem: `${uncited} of ${citations.length} uncited` }
}

const StructureAnswer = z.object({
  breaks: z.array(z.object({ before: z.number(), kind: z.string() })),
  scenes: z.array(z.object({ start: z.number(), tags: z.array(z.string()).nullish() }))
})

/**
 * An import structure pass (F-12.3) scores on the rules the runner enforces: the answer must
 * parse to the shape the prompt asks for, every paragraph number must be one that was sent in
 * the chunk, and every tag must name the bank — anything else is dropped before the author
 * sees it, so a model that returns it wasted the tokens.
 */
function scoreStructure(
  c: EvalCase & { scoring: { kind: 'structure' } },
  answer: string
): LiveResult['verdict'] {
  let parsed: unknown
  try {
    parsed = JSON.parse(answer)
  } catch {
    return { kind: 'json', ok: false, problem: 'not JSON' }
  }
  const result = StructureAnswer.safeParse(parsed)
  if (!result.success) {
    return {
      kind: 'json',
      ok: false,
      problem: 'not { breaks: [{ before, kind }], scenes: [{ start }] }'
    }
  }
  const inChunk = new Set(c.scoring.indices)
  const bank = new Set(c.scoring.bank)
  const strays = [
    ...result.data.breaks
      .filter((item) => !inChunk.has(item.before))
      .map((item) => `break ${item.before}`),
    ...result.data.scenes
      .filter((item) => !inChunk.has(item.start))
      .map((item) => `scene ${item.start}`),
    ...result.data.scenes
      .flatMap((item) => item.tags ?? [])
      .map(toTagName)
      .filter((name) => !bank.has(name))
      .map((name) => `tag ${name}`)
  ]
  return strays.length === 0
    ? { kind: 'json', ok: true, problem: null }
    : { kind: 'json', ok: false, problem: `outside the chunk or the bank: ${strays.join(', ')}` }
}

const ContinuityAnswer = z.object({
  findings: z.array(z.object({ ref: z.number(), quote: z.string() }))
})

/**
 * A consistency check (F-13.4) scores on the rule the feature turns on: it must parse to the
 * shape the prompt asks for, and every finding must carry both citations — the number of a
 * reference that was sent and a quote found in the scene text as sent, matched exactly as
 * `parseContinuityAnswer` matches it.
 */
function scoreContinuity(
  sceneText: string,
  references: number,
  answer: string
): LiveResult['verdict'] {
  let parsed: unknown
  try {
    parsed = JSON.parse(answer)
  } catch {
    return { kind: 'json', ok: false, problem: 'not JSON' }
  }
  const result = ContinuityAnswer.safeParse(parsed)
  if (!result.success) {
    return { kind: 'json', ok: false, problem: 'not { findings: [{ ref, quote }] }' }
  }
  const uncited = result.data.findings.filter(
    (finding) =>
      !Number.isInteger(finding.ref) ||
      finding.ref < 1 ||
      finding.ref > references ||
      !findQuote(sceneText, finding.quote)
  ).length
  return uncited === 0
    ? { kind: 'json', ok: true, problem: null }
    : { kind: 'json', ok: false, problem: `${uncited} of ${result.data.findings.length} uncited` }
}

/**
 * A proofread (F-14.12) scores through the feature's own parser, so the verdict is what the
 * author would see: the answer must parse to `{ fixes: [...] }`, and every fix must survive the
 * checks main applies (quote in the text and once in the scene, a correction rather than a
 * rewrite, keep words left alone, no overlap); a dropped fix is tokens the model wasted.
 */
function scoreProofread(text: string, keepWords: string[], answer: string): LiveResult['verdict'] {
  try {
    const { fixes, dropped } = parseProofreadAnswer(answer, text, text, keepWords)
    return dropped === 0
      ? { kind: 'json', ok: true, problem: null }
      : { kind: 'json', ok: false, problem: `${dropped} of ${fixes.length + dropped} dropped` }
  } catch {
    return { kind: 'json', ok: false, problem: 'not { fixes: [{ kind, quote, fix }] }' }
  }
}

/**
 * What should come next? (F-5.17) scores through the feature's own parser: the answer must
 * parse to `{ directions: [...] }`, and all three directions asked for must survive it (shape,
 * non-blank, within the caps); a dropped or missing one is tokens the model wasted.
 */
function scoreWhatNext(answer: string): LiveResult['verdict'] {
  try {
    const { directions, dropped } = parseWhatNextAnswer(answer)
    return dropped === 0 && directions.length === WHAT_NEXT_DIRECTIONS
      ? { kind: 'json', ok: true, problem: null }
      : {
          kind: 'json',
          ok: false,
          problem: `${directions.length} kept, ${dropped} dropped`
        }
  } catch {
    return { kind: 'json', ok: false, problem: 'not { directions: [{ title, text }] }' }
  }
}

/**
 * The assistant router (F-5.19) scores through the feature's own parser: the answer must be JSON
 * naming a known action (anything else silently becomes `chat`, which is a miss unless `chat`
 * was expected), and the action must be the one the case expects.
 */
function scoreRoute(expected: string, answer: string): LiveResult['verdict'] {
  try {
    JSON.parse(answer)
  } catch {
    return { kind: 'json', ok: false, problem: 'not JSON' }
  }
  const { action } = parseRouteAnswer(answer)
  return action === expected
    ? { kind: 'json', ok: true, problem: null }
    : { kind: 'json', ok: false, problem: `routed to ${action}, expected ${expected}` }
}

/** One chat agent step (F-5.22): JSON that the feature's parser reads as the expected kind. */
function scoreAgent(expected: 'tool' | 'answer', answer: string): LiveResult['verdict'] {
  try {
    JSON.parse(answer.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''))
  } catch {
    return { kind: 'json', ok: false, problem: 'not JSON' }
  }
  const { kind } = parseAgentReply(answer)
  return kind === expected
    ? { kind: 'json', ok: true, problem: null }
    : { kind: 'json', ok: false, problem: `a ${kind}, expected a ${expected}` }
}

/** A suggested synopsis (F-5.20) scores through the feature's own parser. */
function scoreSynopsis(answer: string): LiveResult['verdict'] {
  try {
    parseSynopsisAnswer(answer)
    return { kind: 'json', ok: true, problem: null }
  } catch {
    return { kind: 'json', ok: false, problem: 'not { synopsis } with text' }
  }
}

/** Suggested notes (F-5.20) score through the feature's own parser; a dropped point is waste. */
function scoreNotesSuggest(answer: string): LiveResult['verdict'] {
  try {
    const { points, dropped } = parseNotesSuggestAnswer(answer)
    return dropped === 0 && points.length > 0
      ? { kind: 'json', ok: true, problem: null }
      : { kind: 'json', ok: false, problem: `${points.length} kept, ${dropped} dropped` }
  } catch {
    return { kind: 'json', ok: false, problem: 'not { points: [string] }' }
  }
}

/** Learned style notes (F-14.14) score like the other JSON answers: they must parse to at least one note. */
function scoreVoiceNotes(answer: string): LiveResult['verdict'] {
  try {
    const notes = parseVoiceNotesAnswer(answer)
    return notes.length > 0
      ? { kind: 'json', ok: true, problem: null }
      : { kind: 'json', ok: false, problem: 'no notes kept' }
  } catch {
    return { kind: 'json', ok: false, problem: 'not { notes: string[] }' }
  }
}

const BriefAnswer = z.object({
  goal: z.string(),
  conflict: z.string(),
  turn: z.string(),
  beat: z.string(),
  after: z.string()
})

/**
 * A scene brief (F-14.3) scores like the other JSON answers: it must parse to the five string
 * lines the prompt asks for, and no line may run past the field cap the pane stores.
 */
function scoreBrief(answer: string): LiveResult['verdict'] {
  let parsed: unknown
  try {
    parsed = JSON.parse(answer)
  } catch {
    return { kind: 'json', ok: false, problem: 'not JSON' }
  }
  const result = BriefAnswer.safeParse(parsed)
  if (!result.success) {
    return { kind: 'json', ok: false, problem: 'not { goal, conflict, turn, beat, after }' }
  }
  const over = Object.entries(result.data)
    .filter(([, line]) => line.length > SCENE_BRIEF_FIELD_MAX)
    .map(([field]) => field)
  return over.length === 0
    ? { kind: 'json', ok: true, problem: null }
    : {
        kind: 'json',
        ok: false,
        problem: `over ${SCENE_BRIEF_FIELD_MAX} characters: ${over.join(', ')}`
      }
}

/**
 * A scene summary (F-5.6) scores against the schema the row is stored under: the answer must
 * parse to `SceneSummary`, which is also where the caps live, so an over-long summary or one
 * key point too many is a failure here exactly as it would be in the app.
 */
function scoreSummary(answer: string): LiveResult['verdict'] {
  let parsed: unknown
  try {
    parsed = JSON.parse(answer)
  } catch {
    return { kind: 'json', ok: false, problem: 'not JSON' }
  }
  const result = SceneSummary.safeParse(parsed)
  if (result.success) return { kind: 'json', ok: true, problem: null }
  const issue = result.error.issues[0]
  return {
    kind: 'json',
    ok: false,
    problem:
      `not { summary, keyPoints, characters } within the caps: ${issue?.path.join('.') ?? ''} ${issue?.message ?? ''}`.trim()
  }
}

/**
 * A summary with observed facts (F-5.16) scores as the summary does and then on the rule the
 * story bible turns on: every fact the model gave must survive `parseSummaryAnswer` — the five
 * strings, an attribute of its kind, and a quote found in the scene as sent. A dropped fact is
 * a token paid for nothing, so it fails the case.
 */
function scoreSummaryFacts(sceneText: string, answer: string): LiveResult['verdict'] {
  const summary = scoreSummary(answer)
  if (summary.kind !== 'json' || !summary.ok) return summary
  const { facts, droppedFacts } = parseSummaryAnswer(answer, sceneText)
  return droppedFacts === 0
    ? { kind: 'json', ok: true, problem: null }
    : {
        kind: 'json',
        ok: false,
        problem: `${droppedFacts} of ${facts.length + droppedFacts} facts dropped`
      }
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
      if (c.scoring.kind === 'critique') {
        results.push({
          ...base,
          answer: reply.text,
          verdict: scoreCritique(c.scoring.sceneText, reply.text)
        })
        continue
      }
      if (c.scoring.kind === 'brief') {
        results.push({ ...base, answer: reply.text, verdict: scoreBrief(reply.text) })
        continue
      }
      if (c.scoring.kind === 'summary') {
        results.push({ ...base, answer: reply.text, verdict: scoreSummary(reply.text) })
        continue
      }
      if (c.scoring.kind === 'summaryFacts') {
        results.push({
          ...base,
          answer: reply.text,
          verdict: scoreSummaryFacts(c.scoring.sceneText, reply.text)
        })
        continue
      }
      if (c.scoring.kind === 'betaReader') {
        results.push({
          ...base,
          answer: reply.text,
          verdict: scoreBetaReader(c.scoring.texts, reply.text)
        })
        continue
      }
      if (c.scoring.kind === 'query') {
        results.push({
          ...base,
          answer: reply.text,
          verdict: scoreQuery(c.scoring.texts, reply.text)
        })
        continue
      }
      if (c.scoring.kind === 'continuity') {
        results.push({
          ...base,
          answer: reply.text,
          verdict: scoreContinuity(c.scoring.sceneText, c.scoring.references, reply.text)
        })
        continue
      }
      if (c.scoring.kind === 'proofread') {
        results.push({
          ...base,
          answer: reply.text,
          verdict: scoreProofread(c.scoring.text, c.scoring.keepWords, reply.text)
        })
        continue
      }
      if (c.scoring.kind === 'whatNext') {
        results.push({ ...base, answer: reply.text, verdict: scoreWhatNext(reply.text) })
        continue
      }
      if (c.scoring.kind === 'route') {
        results.push({
          ...base,
          answer: reply.text,
          verdict: scoreRoute(c.scoring.expected, reply.text)
        })
        continue
      }
      if (c.scoring.kind === 'agent') {
        results.push({
          ...base,
          answer: reply.text,
          verdict: scoreAgent(c.scoring.expected, reply.text)
        })
        continue
      }
      if (c.scoring.kind === 'synopsis') {
        results.push({ ...base, answer: reply.text, verdict: scoreSynopsis(reply.text) })
        continue
      }
      if (c.scoring.kind === 'notesSuggest') {
        results.push({ ...base, answer: reply.text, verdict: scoreNotesSuggest(reply.text) })
        continue
      }
      if (c.scoring.kind === 'voiceNotes') {
        results.push({ ...base, answer: reply.text, verdict: scoreVoiceNotes(reply.text) })
        continue
      }
      if (c.scoring.kind === 'structure') {
        results.push({
          ...base,
          answer: reply.text,
          verdict: scoreStructure({ ...c, scoring: c.scoring }, reply.text)
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
      // The features score against the author's banned phrases too (F-14.2); every case that
      // carries a voice block carries the fixture's author rules with it.
      const banned = FIXTURE_PROFILE.authorRules.bannedPhrases
      const violations =
        c.scoring.kind === 'chat'
          ? checkChatFidelity(profile, answer, banned)
          : checkGhostTextFidelity(profile, answer, banned).violations
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
