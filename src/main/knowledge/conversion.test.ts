import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { estimateTokens, priceFor } from '@shared/ai'
import { AI_COST_NOTES } from '@shared/aiCostNotes'
import { bundledPricing, hostedQuote } from '@shared/hostedPricing'
import type { TiptapNodeT } from '@shared/tiptap'
import { summaryPrompt, summarySource } from '../ai/summarize'
import { saveDocument } from '../document/documentStore'
import { upsertSummary } from '../document/summaryStore'
import { createProject, projectFolderFor, type ProjectSession } from '../project/projectStore'
import { listNodes, type TreeDb } from '../tree/treeStore'
import {
  confirmConversion,
  conversionPending,
  estimateConversion,
  estimateScenes,
  type ConversionContext
} from './conversion'

const SCENE =
  'The ferry landing was empty when Mara reached it. The rope hung slack in the water and the ' +
  'bell had lost its clapper years ago. She set the lantern down on the post and waited. ' +
  '"You came alone," a voice said behind her. She did not turn. "You said to."'

const doc = (text: string): TiptapNodeT => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }]
})

let tmp: string
let session: ProjectSession
let db: TreeDb
let scene: string

/** Stores a summary of the scene's current text as `version` wrote it. */
function summarised(version: string): void {
  const source = summarySource(db, scene)
  if (source === null) throw new Error('not a scene')
  upsertSummary(db, {
    nodeId: scene,
    contentHash: source.contentHash,
    summary: 'Mara waits.',
    keyPoints: [],
    characters: [],
    promptVersion: version,
    model: 'gpt-5.4-mini',
    truncated: false,
    createdAt: '2026-10-09T00:00:00.000Z'
  })
}

const OWN_KEY: ConversionContext = {
  available: true,
  source: 'ownKey',
  model: 'gpt-5.4-mini',
  pricing: null,
  deferred: false
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-conversion-'))
  session = createProject(projectFolderFor(tmp, 'Conversion'), 'Conversion', 'novel')
  db = session.connection.orm
  scene =
    listNodes(db).find((row) => row.kind === 'document' && row.hierarchyLevel === 'scene')?.id ?? ''
  saveDocument(db, scene, doc(SCENE))
})
afterEach(() => {
  session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('estimateScenes (F-9.14)', () => {
  it('prices the prompts as they would be sent, at the typical answer size, per source', () => {
    const source = summarySource(db, scene)
    if (source === null) throw new Error('not a scene')
    const tokensIn = estimateTokens(
      summaryPrompt(db, source)
        .messages.map((message) => message.content)
        .join('\n')
    )
    const tokensOut = AI_COST_NOTES.summary.typicalOutTokens
    const own = estimateScenes(db, [scene], OWN_KEY)
    expect(own).toEqual({
      tokensIn,
      tokensOut,
      costUsd: priceFor('gpt-5.4-mini', tokensIn, tokensOut).costUsd,
      priced: true
    })
    expect(own.costUsd).toBeGreaterThan(0)

    const hosted = bundledPricing().models[0]?.id ?? ''
    const cloud = estimateScenes(db, [scene], { ...OWN_KEY, source: 'cloud', model: hosted })
    const quote = hostedQuote(bundledPricing(), hosted, tokensIn, tokensOut)
    expect(cloud.costUsd).toBe(quote.costUsd)
    // The hosted quote carries the markup over the provider's own price.
    expect(cloud.costUsd).toBeGreaterThan(priceFor(hosted, tokensIn, tokensOut).costUsd)

    expect(
      estimateScenes(db, [scene], { ...OWN_KEY, source: 'local', model: 'llama3' })
    ).toMatchObject({ costUsd: 0, priced: true })
    expect(estimateScenes(db, [scene], { ...OWN_KEY, model: 'mystery-model' }).priced).toBe(false)
  })
})

describe('estimateConversion (F-9.14, D11)', () => {
  it('asks nothing for a scene this build read, or with the AI unavailable', () => {
    summarised('summary.v4')
    expect(estimateConversion(db, OWN_KEY).state).toBe('none')
    summarised('summary.v3')
    expect(estimateConversion(db, { ...OWN_KEY, available: false }).state).toBe('none')
  })

  it('is pending for scenes an older prompt read, with the count, cost, and time, until confirmed', () => {
    summarised('summary.v3')
    expect(conversionPending(db)).toBe(true)
    const pending = estimateConversion(db, { ...OWN_KEY, deferred: true })
    expect(pending).toMatchObject({
      state: 'pending',
      scenes: 1,
      minutes: 1,
      model: 'gpt-5.4-mini',
      source: 'ownKey',
      deferred: true,
      priced: true
    })
    expect(pending.costUsd).toBe(estimateScenes(db, [scene], OWN_KEY).costUsd)
    confirmConversion(db)
    expect(conversionPending(db)).toBe(false)
    expect(estimateConversion(db, OWN_KEY)).toMatchObject({ state: 'done', scenes: 0 })
  })
})
