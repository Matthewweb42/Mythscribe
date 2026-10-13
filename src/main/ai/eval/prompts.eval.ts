import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  estimateTokens,
  OPENROUTER_BASE_URL,
  OPENROUTER_DEFAULT_MODELS,
  outputBudget
} from '@shared/ai'
import { settleRoute } from '@shared/assistantRoute'
import { AUTHOR_RULES_HEADER } from '@shared/authorRules'
import { findQuote, normalizeForMatch } from '@shared/critique'
import type { EditPassType } from '@shared/editPass'
import { parseFilingAnswer, quoteParagraph } from '@shared/filing'
import { locateQuote } from '@shared/memory/quote'
import { parseReaderAnswer, parseVerifyAnswer, unfence } from '@shared/memory/readerAnswer'
import { parseHow } from '@shared/memory/knows'
import { parseStep } from '@shared/memory/topics'
import { STORY_NOTES_CONTINUITY_HEADING, STORY_NOTES_HEADING } from '@shared/memory/storyNotes'
import { SCENE_BRIEF_FIELD_MAX } from '@shared/sceneMeta'
import { SceneSummary } from '@shared/summary'
import { toTagName } from '@shared/tags'
import { checkGhostTextFidelity } from '@shared/voiceFidelity'
import { renderCostRegistry } from './costRegistry'
import { WHAT_NEXT_DIRECTIONS } from '@shared/whatNext'
import { parseAgentReply } from '../agent'
import { readScribeReply } from '../../scribe/runScribe'
import { CITE_SENTINEL, parseCiteReply } from '../prompts/cite.v1'
import { NAVIGATOR_SENTINEL, parseNavigatorStep } from '../prompts/navigator.v1'
import { parseCitedAnswer, quoteHeld, statesAbsenceAsFact, statesScope } from '@shared/scribeAnswer'
import { parseBetaReaderAnswerV2 } from '../betaReader'
import { parsePlanLinksV2Answer } from '../../memory/reading/planLinks'
import { checkChatFidelity, postProcessChatText } from '../chat'
import { postProcessGhostText } from '../ghostText'
import { PROMPT_CATALOGUE, PROMPT_VERSIONS, promptInputBudget } from '../prompts/catalogue'
import { parseEditChanges, parseEditNotes } from '../editPass'
import { parseProofreadAnswer } from '../proofread'
import { parseOrganiseAnswer } from '../organise'
import { parseReviewChatAnswer } from '../reviewChat'
import { parseRouteAnswer } from '../route'
import { parseNotesSuggestAnswer, parseSynopsisAnswer } from '../sceneSuggest'
import { parseSummaryAnswer } from '../summarize'
import { parseVoiceNotesAnswer } from '../voiceNotes'
import { parseRefileAnswer, parseWriteUpAnswer } from '../sheetSync'
import { parseWhatNextAnswer } from '../whatNext'
import { parseTodoAnswer, parseTodoSuggestAnswer } from '../todoPass'
import {
  EVAL_CASES,
  FIXTURE_PROFILE,
  STORY_NOTES_GHOST_CASE,
  type EvalCase,
  type NavigatorExpected
} from './fixtures'
import { STORY_NOTES_IDEA_TEXT, STORY_NOTES_NOT_CANON_TEXT } from './storyNotesFixture'
import { runAiRequest, sha256 } from '../request'
import { fakeChatServer } from './fakeChatServer'
import { liveProviderFromEnv, liveRequestDeps, type LiveProvider } from './liveProvider'
import { renderLiveReport, renderTokenReport, tokenRows, type LiveResult } from './report'

/**
 * The prompt eval harness (F-5.12), `npm run eval:ai`. Offline (always, part of `npm run
 * test`): every catalogued version has cases, every case fits its budgets, and the token
 * report matches the committed `token-report.md` (accept a change with `-u`; the file's diff
 * is the token delta a prompt change reports). Live (`MYTHSCRIBE_EVAL_LIVE=1` with
 * `OPENROUTER_API_KEY`, or `OPENAI_API_KEY` and optionally `OPENAI_BASE_URL`: `liveProvider.ts`):
 * every case goes to the provider once through the request path, as the app sends it (its tier,
 * its reasoning mode, the cost OpenRouter reports), the answers are post-processed and scored as
 * the features score them, and the report is printed and written under `test-results/eval-ai/`.
 * The live run never touches the key store, the app's ledger, or a project: it is a developer
 * tool, not the app.
 *
 *     MYTHSCRIBE_EVAL_LIVE=1 OPENROUTER_API_KEY=sk-or-… npm run eval:ai -- prompts
 */

const LIVE = process.env.MYTHSCRIBE_EVAL_LIVE === '1'
const TOKEN_REPORT = './token-report.md'
/** Every AI feature with its estimated cost per call (author request 2026-10-08). */
const COST_REGISTRY = '../../../../docs/AI-COST-REGISTRY.md'

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
      // F-16.25 (P3-D10): a version with its own cap (agent.v9's 24,000) is held to it.
      expect(row.total, `${label} is over the ${row.version} input budget`).toBeLessThanOrEqual(
        promptInputBudget(PROMPT_CATALOGUE[row.version].feature, row.version)
      )
      expect(row.maxTokens, `${label} asks for more than its output cap`).toBeLessThanOrEqual(
        outputBudget(PROMPT_CATALOGUE[row.version].feature)
      )
    }
  })

  it('the token report matches the committed baseline (accept a change with `npm run eval:ai -- -u`)', async () => {
    await expect(renderTokenReport(tokenRows(EVAL_CASES))).toMatchFileSnapshot(TOKEN_REPORT)
  })

  it('F-16.14: every Story notes version has a 150-budget case, and no case carries Ideas or Not canon text', () => {
    const notesVersions = PROMPT_VERSIONS.filter((version) =>
      EVAL_CASES.some(
        (c) =>
          c.version === version &&
          c.messages.some(
            (m) =>
              m.content.includes(STORY_NOTES_HEADING) ||
              m.content.includes(STORY_NOTES_CONTINUITY_HEADING)
          )
      )
    )
    expect(notesVersions).toEqual([
      'ghostText.v5',
      'ghostTextRegen.v5',
      'rewrite.v5',
      'rewriteRegen.v5',
      'chat.v6',
      'chatRegen.v6',
      'critique.v4',
      'critiqueRegen.v4',
      'editPass.v3',
      'whatNext.v4',
      'notesSuggest.v3',
      // F-16.20: the card in the summary's place, the same Story notes.
      'notesSuggest.v4'
    ])
    const primary = notesVersions.filter((version) => !version.includes('Regen'))
    for (const version of primary) {
      expect(
        EVAL_CASES.some((c) => c.version === version && c.name === STORY_NOTES_GHOST_CASE),
        `${version} needs a case at the 150-token ghost budget`
      ).toBe(true)
    }
    for (const c of EVAL_CASES) {
      const text = c.messages.map((m) => m.content).join('\n')
      expect(text, `${c.version} / ${c.name}`).not.toContain(STORY_NOTES_IDEA_TEXT)
      expect(text, `${c.version} / ${c.name}`).not.toContain(STORY_NOTES_NOT_CANON_TEXT)
    }
  })

  it('the AI cost registry matches the committed one (docs/AI-COST-REGISTRY.md; accept with `-u`)', async () => {
    await expect(renderCostRegistry(tokenRows(EVAL_CASES))).toMatchFileSnapshot(COST_REGISTRY)
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

/**
 * A v2 beta-reader report (F-16.20) scores on the rule `betaReader.v2` turns on: it must parse, and
 * every item must quote the current scene (never the map of gists), checked by the feature's own
 * parser (`parseBetaReaderAnswerV2`).
 */
function scoreBetaReaderV2(
  sceneText: string,
  earlier: number,
  answer: string
): LiveResult['verdict'] {
  try {
    const { items, dropped } = parseBetaReaderAnswerV2(answer, sceneText, earlier)
    return dropped === 0
      ? { kind: 'json', ok: true, problem: null }
      : { kind: 'json', ok: false, problem: `${dropped} of ${items.length + dropped} dropped` }
  } catch {
    return { kind: 'json', ok: false, problem: 'not { items: [{ quote }] }' }
  }
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

const ContextImportAnswer = z.object({
  entities: z.array(
    z.object({ kind: z.enum(['character', 'setting', 'world']), name: z.string() })
  ),
  notes: z.array(z.string()).nullish()
})

/**
 * A context-library chunk (F-9.8) scores on what the runner keeps: the answer must parse to the
 * shape the prompt asks for, and every name the document clearly describes must be among the
 * entities (compared lower-cased, so "the ferry landing" counts).
 */
function scoreContextImport(expected: string[], answer: string): LiveResult['verdict'] {
  let parsed: unknown
  try {
    parsed = JSON.parse(answer)
  } catch {
    return { kind: 'json', ok: false, problem: 'not JSON' }
  }
  const result = ContextImportAnswer.safeParse(parsed)
  if (!result.success) {
    return { kind: 'json', ok: false, problem: 'not { entities: [{ kind, name }], notes }' }
  }
  const names = new Set(result.data.entities.map((entity) => entity.name.trim().toLowerCase()))
  const missing = expected.filter((name) => !names.has(name.toLowerCase()))
  return missing.length === 0
    ? { kind: 'json', ok: true, problem: null }
    : { kind: 'json', ok: false, problem: `missing: ${missing.join(', ')}` }
}

/**
 * A filing chunk (F-16.9) scores on what the planner keeps: the answer must parse
 * (`parseFilingAnswer`), every expected name must be filed, and every line's quote must be in the
 * document as sent, matched as `quoteParagraph` matches it.
 */
function scoreFiling(expected: string[], document: string, answer: string): LiveResult['verdict'] {
  const parsed = parseFilingAnswer(answer)
  if (parsed === null)
    return { kind: 'json', ok: false, problem: 'not { records, categories, images }' }
  const records = parsed.records ?? []
  const names = new Set(records.map((record) => record.name.trim().toLowerCase()))
  const missing = expected.filter((name) => !names.has(name.toLowerCase()))
  if (missing.length > 0)
    return { kind: 'json', ok: false, problem: `missing: ${missing.join(', ')}` }
  const paragraphs = document.split('\n\n').map((text, index) => ({ index, text, notCanon: false }))
  const lines = records.flatMap((record) => record.lines ?? [])
  const unquoted = lines.filter((line) => quoteParagraph(line.q, paragraphs) === null).length
  return unquoted === 0
    ? { kind: 'json', ok: true, problem: null }
    : {
        kind: 'json',
        ok: false,
        problem: `${unquoted} of ${lines.length} quotes not in the document`
      }
}

/**
 * A review chat message (F-9.9) scores on what the renderer applies: the answer must parse
 * through `parseReviewChatAnswer` with no operation dropped, and hold each expected operation.
 */
function scoreReviewChat(expected: string[], answer: string): LiveResult['verdict'] {
  const parsed = parseReviewChatAnswer(answer)
  if (parsed === null) return { kind: 'json', ok: false, problem: 'not { reply, ops }' }
  if (parsed.dropped > 0) {
    return { kind: 'json', ok: false, problem: `${parsed.dropped} operations did not parse` }
  }
  const missing = expected.filter((op) => !parsed.ops.some((o) => o.op === op))
  return missing.length === 0
    ? { kind: 'json', ok: true, problem: null }
    : { kind: 'json', ok: false, problem: `missing: ${missing.join(', ')}` }
}

/** An organise answer (F-9.10) scores as a review chat answer does, through its own parser. */
function scoreOrganise(expected: string[], answer: string): LiveResult['verdict'] {
  const parsed = parseOrganiseAnswer(answer)
  if (parsed === null) return { kind: 'json', ok: false, problem: 'not { reply, ops }' }
  if (parsed.dropped > 0) {
    return { kind: 'json', ok: false, problem: `${parsed.dropped} operations did not parse` }
  }
  const missing = expected.filter((op) => !parsed.ops.some((o) => o.op === op))
  return missing.length === 0
    ? { kind: 'json', ok: true, problem: null }
    : { kind: 'json', ok: false, problem: `missing: ${missing.join(', ')}` }
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
 * An edit pass (F-14.15) scores through the feature's own parsers, so the verdict is what the
 * author would see: the answer must parse, and every change (quote in the piece and once in the
 * scene, within one paragraph, no overlap, a proofread only a correction) or note (cited) must
 * survive; a dropped item is tokens the model wasted.
 */
function scoreEditPass(type: EditPassType, text: string, answer: string): LiveResult['verdict'] {
  try {
    const scene = normalizeForMatch(text)
    let kept: number
    let dropped: number
    if (type === 'developmental') {
      const parsed = parseEditNotes(answer, text, scene)
      kept = parsed.notes.length
      dropped = parsed.dropped
    } else {
      const parsed = parseEditChanges(answer, text, scene, { type, keep: new Set(), taken: [] })
      kept = parsed.changes.length
      dropped = parsed.dropped
    }
    return dropped === 0
      ? { kind: 'json', ok: true, problem: null }
      : { kind: 'json', ok: false, problem: `${dropped} of ${kept + dropped} dropped` }
  } catch {
    return { kind: 'json', ok: false, problem: 'not the changes or notes JSON asked for' }
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
 * was expected), and the action must be the one the case expects; for an edit pass (route.v2,
 * F-5.26) also the pass and the target.
 */
function scoreRoute(
  expected: string,
  edit: { pass: string; target: string } | undefined,
  answer: string
): LiveResult['verdict'] {
  try {
    JSON.parse(answer)
  } catch {
    return { kind: 'json', ok: false, problem: 'not JSON' }
  }
  const decision = parseRouteAnswer(answer)
  if (decision.action !== expected) {
    return {
      kind: 'json',
      ok: false,
      problem: `routed to ${decision.action}, expected ${expected}`
    }
  }
  if (edit !== undefined) {
    const got = `${decision.edit?.pass ?? '-'}/${decision.edit?.target ?? '-'}`
    const want = `${edit.pass}/${edit.target}`
    if (got !== want) return { kind: 'json', ok: false, problem: `edit ${got}, expected ${want}` }
  }
  return { kind: 'json', ok: true, problem: null }
}

/** One chat agent step (F-5.22): JSON that the feature's parser reads as the expected kind. */
function scoreAgent(expected: 'tool' | 'answer', answer: string): LiveResult['verdict'] {
  try {
    JSON.parse(
      answer
        .trim()
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/, '')
    )
  } catch {
    return { kind: 'json', ok: false, problem: 'not JSON' }
  }
  const { kind } = parseAgentReply(answer)
  return kind === expected
    ? { kind: 'json', ok: true, problem: null }
    : { kind: 'json', ok: false, problem: `a ${kind}, expected a ${expected}` }
}

/**
 * An answer that must carry an edit of one kind (F-5.25): a bulk delete must come back as a
 * `clear` edit, not as an organise request or a string of single deletes.
 */
function scoreAgentEdit(expected: string, answer: string): LiveResult['verdict'] {
  const reply = parseAgentReply(answer)
  if (reply.kind !== 'answer')
    return { kind: 'json', ok: false, problem: 'a lookup, not an answer' }
  if (reply.organise !== undefined && reply.organise !== null)
    return { kind: 'json', ok: false, problem: 'asked to organise' }
  const kinds = reply.edits.map((edit) =>
    typeof edit === 'object' && edit !== null && 'edit' in edit ? String(edit.edit) : ''
  )
  return kinds.includes(expected)
    ? { kind: 'json', ok: true, problem: null }
    : {
        kind: 'json',
        ok: false,
        problem: `no ${expected} edit (edits: ${kinds.join(', ') || 'none'})`
      }
}

/**
 * A story-time answer (F-5.23) scores on the rule the feature turns on: it must be an answer (not
 * another lookup), and it must not state as happened an event the author's notes only plan.
 */
function scoreStoryTime(forbidden: string[], answer: string): LiveResult['verdict'] {
  const reply = parseAgentReply(answer)
  if (reply.kind !== 'answer')
    return { kind: 'json', ok: false, problem: 'a lookup, not an answer' }
  const stated = forbidden.filter((pattern) => new RegExp(pattern, 'iu').test(reply.answer))
  return stated.length === 0
    ? { kind: 'json', ok: true, problem: null }
    : {
        kind: 'json',
        ok: false,
        problem: `states a planned event as happened: ${stated.join(', ')}`
      }
}

const PlanLinksAnswer = z.object({
  links: z.array(z.object({ plan: z.string(), scene: z.string() }))
})

/** Plan links (F-11.1d): `{ links }` naming only the plan and scene labels that were sent. */
function scorePlanLinks(plans: number, scenes: number, answer: string): LiveResult['verdict'] {
  let parsed: unknown
  try {
    parsed = JSON.parse(answer)
  } catch {
    return { kind: 'json', ok: false, problem: 'not JSON' }
  }
  const result = PlanLinksAnswer.safeParse(parsed)
  if (!result.success)
    return { kind: 'json', ok: false, problem: 'not { links: [{ plan, scene }] }' }
  const inRange = (label: string, prefix: string, max: number): boolean => {
    const n = Number(label.trim().toUpperCase().replace(prefix, ''))
    return Number.isInteger(n) && n >= 1 && n <= max
  }
  const strays = result.data.links.filter(
    (link) => !inRange(link.plan, 'P', plans) || !inRange(link.scene, 'S', scenes)
  ).length
  return strays === 0
    ? { kind: 'json', ok: true, problem: null }
    : { kind: 'json', ok: false, problem: `${strays} links name labels that were not sent` }
}

/**
 * The To do check (F-9.16) scores through the feature's own parser: every item must be kept (a
 * known type, a name, a scene label that was sent), against an empty table and bible.
 */
function scoreTodo(scenes: number, answer: string): LiveResult['verdict'] {
  let items: unknown[]
  try {
    const json: unknown = JSON.parse(answer)
    items =
      typeof json === 'object' &&
      json !== null &&
      Array.isArray((json as { items?: unknown }).items)
        ? (json as { items: unknown[] }).items
        : []
    const parsed = parseTodoAnswer(answer, {
      scenes: new Map(Array.from({ length: scenes }, (_, at) => [`s${at + 1}`, `n${at + 1}`])),
      listed: new Map(),
      keys: new Set(),
      entities: [],
      categories: [],
      quoteOf: () => null
    })
    const dropped = Math.min(items.length, 8) - parsed.items.length
    return dropped === 0
      ? { kind: 'json', ok: true, problem: null }
      : { kind: 'json', ok: false, problem: `${dropped} items dropped by the parser` }
  } catch {
    return { kind: 'json', ok: false, problem: 'not { items: [...], resolved: [...] }' }
  }
}

/** A To do item's suggestions (F-9.16): the parser must keep at least two options. */
function scoreTodoSuggest(answer: string): LiveResult['verdict'] {
  try {
    const kept = parseTodoSuggestAnswer(answer)
    return kept.length >= 2
      ? { kind: 'json', ok: true, problem: null }
      : { kind: 'json', ok: false, problem: `only ${kept.length} option` }
  } catch {
    return { kind: 'json', ok: false, problem: 'not { suggestions: [string] }' }
  }
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
/** F-9.18: a write-up parses, and every part is one of the heading fields sent. */
function scoreSheetWriteUp(headings: readonly string[], answer: string): LiveResult['verdict'] {
  try {
    const parsed = parseWriteUpAnswer(answer)
    const stray = Object.keys(parsed.parts).filter((id) => !headings.includes(id))
    if (parsed.intro.trim() === '' && Object.keys(parsed.parts).length === 0) {
      return { kind: 'json', ok: false, problem: 'an empty write-up' }
    }
    return stray.length === 0
      ? { kind: 'json', ok: true, problem: null }
      : {
          kind: 'json',
          ok: false,
          problem: `parts for fields that are not headings: ${stray.join(', ')}`
        }
  } catch {
    return { kind: 'json', ok: false, problem: 'not { intro, parts }' }
  }
}

/** F-9.18: a filing parses, keeps something, and names only fields that were sent. */
function scoreSheetRefile(fields: readonly string[], answer: string): LiveResult['verdict'] {
  try {
    const parsed = parseRefileAnswer(answer)
    const stray = parsed.edits.filter((edit) => !fields.includes(edit.f)).map((edit) => edit.f)
    if (parsed.edits.length + parsed.adds.length === 0) {
      return { kind: 'json', ok: false, problem: 'nothing filed' }
    }
    return stray.length === 0
      ? { kind: 'json', ok: true, problem: null }
      : { kind: 'json', ok: false, problem: `edits of fields not sent: ${stray.join(', ')}` }
  } catch {
    return { kind: 'json', ok: false, problem: 'not { edits, add }' }
  }
}

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

/** Whether two quotes overlap: one holds the other once normalised. */
function sameQuote(a: string, b: string): boolean {
  const x = normalizeForMatch(a)
  const y = normalizeForMatch(b)
  return x.includes(y) || y.includes(x)
}

/**
 * The story-memory reader (F-16.17) scores on what the ladder keeps: the answer must parse, every
 * quote must sit once in the paragraph it names among those sent (`locateQuote`), and no fact the
 * test book rejects may be offered as narration in `now` mode. Recall per slot is reported.
 */
function scoreReader(
  scoring: Extract<EvalCase['scoring'], { kind: 'reader' }>,
  answer: string
): LiveResult['verdict'] {
  const parsed = parseReaderAnswer(answer)
  if (parsed === null) return { kind: 'json', ok: false, problem: 'not the reader JSON' }
  const texts: string[] = []
  for (const paragraph of scoring.paragraphs) texts[paragraph.p] = paragraph.text
  const sent = Array.from({ length: texts.length }, (_, p) => texts[p] ?? '')
  const items = [...parsed.claims, ...parsed.names.flatMap((name) => name.c)]
  const missing = items.filter((item) => !locateQuote(sent, item.p, item.q).ok).length
  const offered = items.filter(
    (item) =>
      item.voice === 'narration' &&
      item.mode === 'now' &&
      scoring.rejected.some((label) => label.slot === item.s && sameQuote(item.q, label.quote))
  ).length
  const bySlot = new Map<string, { found: number; total: number }>()
  for (const label of scoring.expected) {
    const entry = bySlot.get(label.slot) ?? { found: 0, total: 0 }
    entry.total += 1
    if (items.some((item) => item.s === label.slot && sameQuote(item.q, label.quote))) {
      entry.found += 1
    }
    bySlot.set(label.slot, entry)
  }
  const recall = [...bySlot]
    .map(([slot, entry]) => `${slot} ${entry.found}/${entry.total}`)
    .join(', ')
  // P2b (`reader.v2`): knows lines on learner, secret, how and source; steps on thread and step.
  const knowsItems = parsed.claims.filter((item) => item.s === 'knows')
  const fresh = new Set(parsed.topics.filter((topic) => topic.label !== null).map((t) => t.id))
  const secretMatches = (want: string | null, got: string | null): boolean =>
    want === null ? got !== null && fresh.has(got) : got === want
  let knowsFound = 0
  let howRight = 0
  let fromRight = 0
  let fromAsked = 0
  for (const label of scoring.knows ?? []) {
    const hit = knowsItems.find(
      (item) => item.r === label.learner && sameQuote(item.q, label.quote)
    )
    if (hit === undefined) continue
    if (secretMatches(label.secret, hit.o)) knowsFound += 1
    if (parseHow(hit.how) === parseHow(label.how)) howRight += 1
    if (label.from !== null) {
      fromAsked += 1
      if (hit.fr === label.from) fromRight += 1
    }
  }
  const stepItems = parsed.claims.filter((item) => item.s === 'thread')
  const stepsFound = (scoring.steps ?? []).filter((label) =>
    stepItems.some(
      (item) =>
        sameQuote(item.q, label.quote) &&
        parseStep(item.how) === parseStep(label.how) &&
        (label.thread === null ? item.r !== null && fresh.has(item.r) : item.r === label.thread)
    )
  ).length
  const wrongKnowers = knowsItems.filter(
    (item) => item.r !== null && (scoring.notKnowing ?? []).includes(item.r)
  ).length
  const knowsTotal = scoring.knows?.length ?? 0
  const stepsTotal = scoring.steps?.length ?? 0
  const problems = [
    `quotes ${items.length - missing}/${items.length}`,
    ...(recall === '' ? [] : [`recall ${recall}`]),
    ...(knowsTotal === 0
      ? []
      : [`knows ${knowsFound}/${knowsTotal} (how ${howRight}, from ${fromRight}/${fromAsked})`]),
    ...(stepsTotal === 0 ? [] : [`steps ${stepsFound}/${stepsTotal}`]),
    ...(offered > 0 ? [`${offered} rejected facts offered as narration, now`] : []),
    ...(wrongKnowers > 0 ? [`${wrongKnowers} knows lines for someone who never learns it`] : [])
  ]
  return {
    kind: 'json',
    ok: missing === 0 && offered === 0 && wrongKnowers === 0,
    problem: problems.join('; ')
  }
}

/** The story-memory checker (F-16.17): each verdict's `ok` against the label's `expect`. */
function scoreVerify(
  expected: readonly (boolean | 'notCounted')[],
  answer: string
): LiveResult['verdict'] {
  const verdicts = parseVerifyAnswer(answer)
  if (verdicts.size === 0) return { kind: 'json', ok: false, problem: 'not { v: [...] }' }
  const wrong = expected.flatMap((want, i) => {
    const verdict = verdicts.get(i + 1)
    if (want === 'notCounted') {
      // P2b-D7 (review of slice 2): a rumoured, supposed or dreamt reveal makes no secret.
      const counted =
        verdict?.ok === true &&
        verdict.voice !== 'rumour' &&
        verdict.mode !== 'hypothetical' &&
        verdict.mode !== 'dream'
      return counted ? [`${i + 1}: expected no counted reveal (rumour, hypothetical or dream)`] : []
    }
    return (verdict?.ok ?? false) === want ? [] : [`${i + 1}: expected ${want ? 'ok' : 'not ok'}`]
  })
  return wrong.length === 0
    ? { kind: 'json', ok: true, problem: null }
    : { kind: 'json', ok: false, problem: wrong.join(', ') }
}

/**
 * Ms Scribe's quote check (F-16.25, `cite.v1`): each sentence's verdict the labelled one (any, for
 * a null label, but one), and the scope verdict when the case sent a scope item.
 */
function scoreCite(
  scoring: Extract<EvalCase['scoring'], { kind: 'cite' }>,
  answer: string
): LiveResult['verdict'] {
  const reply = parseCiteReply(answer)
  if (reply.verdicts.size === 0) return { kind: 'json', ok: false, problem: 'not { v: [...] }' }
  const wrong = scoring.expected.flatMap((want, i) => {
    const got = reply.verdicts.get(i + 1)
    if (got === undefined) return [`${i + 1}: no verdict`]
    return want === null || got === want ? [] : [`${i + 1}: ${got}, expected ${want}`]
  })
  if (scoring.scope !== null && reply.scope !== scoring.scope) {
    wrong.push(`scope ${reply.scope ?? 'missing'}, expected ${scoring.scope}`)
  }
  return wrong.length === 0
    ? { kind: 'json', ok: true, problem: null }
    : { kind: 'json', ok: false, problem: wrong.join(', ') }
}

/** The fields a navigator step may carry: ids, names, words and the request restated, never prose. */
const NAVIGATOR_FIELDS = new Set([
  'a',
  'action',
  't',
  'i',
  'instruction',
  'pass',
  'target',
  'chapter',
  'call',
  'use'
])

/**
 * Ms Scribe's navigator (F-16.25, `navigator.v1`): the step as the feature reads it
 * (`parseNavigatorStep`); at step 1 the expected action, pass, target and chapter (route.v2's, read
 * by the same readers), the turn kind, whether "i" is empty, and the decision as `settleRoute`
 * settles it (what F-5.26 runs); the expected first tool, or ids to use; at most 150 output
 * tokens; no field outside the schema (no prose).
 */
function scoreNavigator(
  scoring: Extract<EvalCase['scoring'], { kind: 'navigator' }>,
  answer: string
): LiveResult['verdict'] {
  const step = parseNavigatorStep(answer, scoring.step)
  if (!step.readable) return { kind: 'json', ok: false, problem: 'not one JSON object' }
  const problems: string[] = []
  if (estimateTokens(answer) > outputBudget('navigator')) problems.push('over 150 tokens')
  // Readable, so the reply is one JSON object.
  const json: unknown = JSON.parse(unfence(answer))
  const keys = typeof json === 'object' && json !== null ? Object.keys(json) : []
  const prose = keys.filter((key) => !NAVIGATOR_FIELDS.has(key))
  if (prose.length > 0) problems.push(`fields outside the schema: ${prose.join(', ')}`)
  const want = scoring.expected
  if (want.action !== undefined && step.route?.action !== want.action) {
    problems.push(`action ${step.route?.action ?? 'none'}, expected ${want.action}`)
  }
  if (want.pass !== undefined && step.route?.edit?.pass !== want.pass) {
    problems.push(`pass ${step.route?.edit?.pass ?? 'none'}, expected ${want.pass}`)
  }
  if (want.target !== undefined && step.route?.edit?.target !== want.target) {
    problems.push(`target ${step.route?.edit?.target ?? 'none'}, expected ${want.target}`)
  }
  if (want.chapter !== undefined && step.route?.edit?.chapter !== want.chapter) {
    problems.push(`chapter ${step.route?.edit?.chapter ?? 'none'}, expected ${want.chapter}`)
  }
  if (want.turn !== undefined && step.turn !== want.turn) {
    problems.push(`turn ${step.turn ?? 'none'}, expected ${want.turn}`)
  }
  const instruction = step.route?.instruction ?? null
  if (want.instruction !== undefined && (instruction === null) !== (want.instruction === 'empty')) {
    problems.push(
      `instruction ${instruction === null ? 'empty' : 'given'}, expected ${want.instruction}`
    )
  }
  if (want.settled !== undefined) {
    // What F-5.26 runs: the decision as `ai:navigate` settles it for the case's situation.
    const settled = settleRoute(
      step.route ?? { action: 'chat', instruction: null, edit: null },
      want.settled.situation
    )
    if (settled.action !== want.settled.action) {
      problems.push(`settled action ${settled.action}, expected ${want.settled.action}`)
    }
    if (want.settled.pass !== undefined && settled.edit?.pass !== want.settled.pass) {
      problems.push(`settled pass ${settled.edit?.pass ?? 'none'}, expected ${want.settled.pass}`)
    }
  }
  if (want.tool !== undefined && step.calls[0]?.tool !== want.tool) {
    problems.push(`first tool ${step.calls[0]?.tool ?? 'none'}, expected ${want.tool}`)
  }
  if (want.use === true && (step.use === null || step.use.length === 0)) {
    problems.push('expected it to end with use')
  }
  return problems.length === 0
    ? { kind: 'json', ok: true, problem: null }
    : { kind: 'json', ok: false, problem: problems.join('; ') }
}

/**
 * Ms Scribe's answer (F-16.25, `agent.v9`): the reply as the feature reads it; every citation's
 * item sent and its quote in it as sent (the code check), never a map; `found` or a `need`; the
 * expected edit and place, or none; no absence as fact without "searched"; required phrases.
 */
function scoreScribe(
  scoring: Extract<EvalCase['scoring'], { kind: 'scribe' }>,
  answer: string
): LiveResult['verdict'] {
  const reply = readScribeReply(answer, null)
  if (reply.kind === 'broken') return { kind: 'json', ok: false, problem: 'not one JSON object' }
  const want = scoring.expect
  if (reply.kind === 'need') {
    return want.need === true
      ? { kind: 'json', ok: true, problem: null }
      : { kind: 'json', ok: false, problem: `asked for "${reply.need}"` }
  }
  if (want.need === true) return { kind: 'json', ok: false, problem: 'answered instead of asking' }
  const problems: string[] = []
  const parsed = parseCitedAnswer(reply.answer)
  let citations = 0
  let bad = parsed.malformed
  for (const sentence of parsed.sentences) {
    for (const citation of sentence.citations) {
      citations += 1
      const quotable = scoring.sent[citation.evidence]
      if (
        quotable === undefined ||
        scoring.maps.includes(citation.evidence) ||
        !quoteHeld(quotable, citation.quote)
      ) {
        bad += 1
      }
    }
  }
  if (bad > 0) problems.push(`${bad} of ${citations} citations fail the code check`)
  if (want.found !== undefined && reply.found !== want.found) {
    problems.push(`found ${reply.found}, expected ${want.found}`)
  }
  const edits = reply.edits.map((edit) =>
    typeof edit === 'object' && edit !== null ? (edit as Record<string, unknown>) : {}
  )
  if (want.noEdits === true && edits.length > 0)
    problems.push(`${edits.length} edits on a read run`)
  if (want.edit !== undefined) {
    const expected = want.edit
    const hit = edits.find(
      (edit) =>
        edit.edit === expected.kind &&
        (expected.place === undefined || edit.place === expected.place)
    )
    if (hit === undefined) {
      const word = (value: unknown): string => (typeof value === 'string' ? value : '?')
      const got = edits.map(
        (edit) => `${word(edit.edit)}${edit.place === undefined ? '' : `/${word(edit.place)}`}`
      )
      problems.push(
        `no ${expected.kind}${expected.place === undefined ? '' : `/${expected.place}`} edit (edits: ${got.join(', ') || 'none'})`
      )
    }
    if (
      expected.kind === 'insert' &&
      hit !== undefined &&
      typeof hit.text === 'string' &&
      hit.text !== ''
    ) {
      problems.push('wrote prose instead of a brief')
    }
  }
  // Someone does not know something, which no answer may state as fact (P2b rule 9), unless it
  // says what was searched: the same rule `runScribe` checks.
  if (statesAbsenceAsFact(reply.answer) && !statesScope(reply.answer)) {
    problems.push('states an absence without its scope')
  }
  for (const phrase of want.required ?? []) {
    if (!reply.answer.toLowerCase().includes(phrase.toLowerCase())) problems.push(`no "${phrase}"`)
  }
  return problems.length === 0
    ? { kind: 'json', ok: true, problem: null }
    : { kind: 'json', ok: false, problem: problems.join('; ') }
}

/**
 * The live fidelity run through `live` (F-5.12; one key, F-16.22): every case once through the
 * request path, as the app sends it, each answer post-processed and scored as its feature scores
 * it.
 */
export async function runLivePrompts(live: LiveProvider): Promise<LiveResult[]> {
  const run = liveRequestDeps(live)
  const results: LiveResult[] = []
  for (const c of EVAL_CASES) {
    const entry = PROMPT_CATALOGUE[c.version]
    const estimatedIn = tokenRows([c])[0]?.total ?? 0
    const reply = await runAiRequest(run.deps, {
      feature: entry.feature,
      tier: entry.tier,
      messages: c.messages,
      maxTokens: c.maxTokens,
      json: entry.output === 'json',
      ...(c.temperature === undefined ? {} : { temperature: c.temperature }),
      // F-16.25: a case's own reasoning, as the feature sends it (Ms Scribe's answer turns).
      ...(c.reasoning === undefined ? {} : { reasoning: c.reasoning }),
      // Everything the request carries, so two cases apart only in temperature or cap never
      // share the run's cache: each case reaches the provider once.
      contextHash: sha256(
        JSON.stringify({
          messages: c.messages,
          temperature: c.temperature ?? null,
          maxTokens: c.maxTokens
        })
      ),
      promptVersion: c.version
    })
    // The cost OpenRouter reported when it did, else the price table's (the request path's).
    const { costUsd } = reply
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
    if (c.scoring.kind === 'editPass') {
      results.push({
        ...base,
        answer: reply.text,
        verdict: scoreEditPass(c.scoring.type, c.scoring.text, reply.text)
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
        verdict: scoreRoute(c.scoring.expected, c.scoring.edit, reply.text)
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
    if (c.scoring.kind === 'agentEdit') {
      results.push({
        ...base,
        answer: reply.text,
        verdict: scoreAgentEdit(c.scoring.expected, reply.text)
      })
      continue
    }
    if (c.scoring.kind === 'storyTime') {
      results.push({
        ...base,
        answer: reply.text,
        verdict: scoreStoryTime(c.scoring.forbidden, reply.text)
      })
      continue
    }
    if (c.scoring.kind === 'betaReaderV2') {
      results.push({
        ...base,
        answer: reply.text,
        verdict: scoreBetaReaderV2(c.scoring.sceneText, c.scoring.earlier, reply.text)
      })
      continue
    }
    if (c.scoring.kind === 'planLinksPick') {
      const pick = parsePlanLinksV2Answer(reply.text)
      const expected = c.scoring.expected
      results.push({
        ...base,
        answer: reply.text,
        verdict:
          pick === null
            ? { kind: 'json', ok: false, problem: 'not { pick: S1 | S2 | none }' }
            : expected !== null && pick.pick !== expected
              ? { kind: 'json', ok: false, problem: `picked ${pick.pick}, expected ${expected}` }
              : { kind: 'json', ok: true, problem: null }
      })
      continue
    }
    if (c.scoring.kind === 'planLinks') {
      results.push({
        ...base,
        answer: reply.text,
        verdict: scorePlanLinks(c.scoring.plans, c.scoring.scenes, reply.text)
      })
      continue
    }
    if (c.scoring.kind === 'todo') {
      results.push({
        ...base,
        answer: reply.text,
        verdict: scoreTodo(c.scoring.scenes, reply.text)
      })
      continue
    }
    if (c.scoring.kind === 'todoSuggest') {
      results.push({ ...base, answer: reply.text, verdict: scoreTodoSuggest(reply.text) })
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
    if (c.scoring.kind === 'sheetWriteUp') {
      results.push({
        ...base,
        answer: reply.text,
        verdict: scoreSheetWriteUp(c.scoring.headings, reply.text)
      })
      continue
    }
    if (c.scoring.kind === 'sheetRefile') {
      results.push({
        ...base,
        answer: reply.text,
        verdict: scoreSheetRefile(c.scoring.fields, reply.text)
      })
      continue
    }
    if (c.scoring.kind === 'voiceNotes') {
      results.push({ ...base, answer: reply.text, verdict: scoreVoiceNotes(reply.text) })
      continue
    }
    if (c.scoring.kind === 'contextImport') {
      results.push({
        ...base,
        answer: reply.text,
        verdict: scoreContextImport(c.scoring.expected, reply.text)
      })
      continue
    }
    if (c.scoring.kind === 'filing') {
      results.push({
        ...base,
        answer: reply.text,
        verdict: scoreFiling(c.scoring.expected, c.scoring.document, reply.text)
      })
      continue
    }
    if (c.scoring.kind === 'organise') {
      results.push({
        ...base,
        answer: reply.text,
        verdict: scoreOrganise(c.scoring.expected, reply.text)
      })
      continue
    }
    if (c.scoring.kind === 'reviewChat') {
      results.push({
        ...base,
        answer: reply.text,
        verdict: scoreReviewChat(c.scoring.expected, reply.text)
      })
      continue
    }
    if (c.scoring.kind === 'reader') {
      results.push({ ...base, answer: reply.text, verdict: scoreReader(c.scoring, reply.text) })
      continue
    }
    if (c.scoring.kind === 'verify') {
      results.push({
        ...base,
        answer: reply.text,
        verdict: scoreVerify(c.scoring.expected, reply.text)
      })
      continue
    }
    if (c.scoring.kind === 'scribe') {
      results.push({ ...base, answer: reply.text, verdict: scoreScribe(c.scoring, reply.text) })
      continue
    }
    if (c.scoring.kind === 'cite') {
      results.push({ ...base, answer: reply.text, verdict: scoreCite(c.scoring, reply.text) })
      continue
    }
    if (c.scoring.kind === 'navigator') {
      results.push({
        ...base,
        answer: reply.text,
        verdict: scoreNavigator(c.scoring, reply.text)
      })
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
  return results
}

describe('navigator scoring (F-16.25): what the owed live run checks', () => {
  const scoring = (
    expected: NavigatorExpected
  ): Extract<EvalCase['scoring'], { kind: 'navigator' }> => ({
    kind: 'navigator',
    step: 1,
    expected
  })
  it('scores the settled decision, "i", the chapter and the turn kind', () => {
    const vague = scoring({
      instruction: 'empty',
      settled: {
        situation: { hasNode: true, hasSelection: false },
        action: 'editPass',
        pass: 'ask'
      }
    })
    expect(scoreNavigator(vague, '{"a":"rewrite","t":"edit","i":""}')).toEqual({
      kind: 'json',
      ok: true,
      problem: null
    })
    // A restated "i" on a vague rewrite skips F-5.26's quick picks: a custom pass.
    expect(scoreNavigator(vague, '{"a":"rewrite","t":"edit","i":"Rewrite the scene."}')).toEqual({
      kind: 'json',
      ok: false,
      problem: 'instruction given, expected empty; settled pass custom, expected ask'
    })
    const chapter = scoring({ action: 'editPass', chapter: '3' })
    expect(
      scoreNavigator(
        chapter,
        '{"a":"editPass","t":"edit","pass":"proofread","target":"chapter","chapter":"4"}'
      )
    ).toMatchObject({ ok: false, problem: 'chapter 4, expected 3' })
    expect(scoreNavigator(scoring({ turn: 'edit' }), '{"a":"query","t":"answer"}')).toMatchObject({
      ok: false,
      problem: 'turn answer, expected edit'
    })
  })
})

describe('the live prompt eval, end to end against a fake OpenRouter (F-16.22; nothing spent)', () => {
  it('starts from OPENROUTER_API_KEY alone and sends every case as the app does', async () => {
    const server = fakeChatServer(() => ({ text: '{}' }))
    const live = liveProviderFromEnv({ OPENROUTER_API_KEY: 'sk-or-fake' }, { fetch: server.fetch })
    const results = await runLivePrompts(live)
    expect(results).toHaveLength(EVAL_CASES.length)
    // Every case reached OpenRouter once: none was answered from the run's cache.
    expect(server.calls).toHaveLength(EVAL_CASES.length)
    for (const call of server.calls) {
      expect(call.url).toBe(`${OPENROUTER_BASE_URL}/chat/completions`)
      expect(call.headers.get('authorization')).toBe('Bearer sk-or-fake')
      expect(Object.values(OPENROUTER_DEFAULT_MODELS)).toContain(call.body.model)
    }
    // The story-memory reader and checker, Ms Scribe's quote check (P3-D21) and her navigator
    // ask for no reasoning, as the app sends them.
    const memory = server.calls.filter((call) =>
      /^You are the (story-memory reader|fact checker|citation checker|navigator)/.test(
        call.messages[0]?.content ?? ''
      )
    )
    expect(memory.some((call) => call.messages[0]?.content.startsWith(CITE_SENTINEL))).toBe(true)
    expect(memory.some((call) => call.messages[0]?.content.startsWith(NAVIGATOR_SENTINEL))).toBe(
      true
    )
    expect(memory.length).toBeGreaterThan(0)
    for (const call of memory) expect(call.body.reasoning).toEqual({ enabled: false })
    expect(
      results.filter((result) => result.costUsd !== 0.0001).map((result) => result.name)
    ).toEqual([])
  }, 120_000)
})

describe.skipIf(!LIVE)('live prompt eval (MYTHSCRIBE_EVAL_LIVE=1)', () => {
  it('sends every case once, scores the answers, and writes the fidelity report', async () => {
    const live = liveProviderFromEnv()
    const results = await runLivePrompts(live)
    const report = renderLiveReport(results, new Date(), live.describe)
    const dir = path.resolve('test-results/eval-ai')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'live-report.md'), report)
    process.stdout.write(`\n${report}\n`)
    expect(results).toHaveLength(EVAL_CASES.length)
  }, 1_800_000)
})
