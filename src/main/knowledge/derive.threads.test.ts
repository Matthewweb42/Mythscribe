import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_BILLING_TERMS } from '@shared/cloudBilling'
import { bundledPricing } from '@shared/hostedPricing'
import { costOf } from '@shared/ai'
import { AI_COST_NOTES } from '@shared/aiCostNotes'
import { threadAttribute } from '@shared/threads'
import type { TiptapNodeT } from '@shared/tiptap'
import { saveDocument } from '../document/documentStore'
import { createEntity, listEntities } from '../entity/entityStore'
import { listFactsForEntity, setFactHidden } from '../entity/factStore'
import { node } from '../db/schema'
import { createProject, projectFolderFor, type ProjectSession } from '../project/projectStore'
import { listNodes, type TreeDb } from '../tree/treeStore'
import { estimateScenes } from './conversion'
import { applyDerivedKnowledge } from './derive'
import { listThreads } from './threads'

/**
 * Verifier tests for F-9.14 (P3): thread events across scenes, the per-reading cap on new thread
 * records, and the hosted estimate's markup and safety factor against the billing terms.
 */

const doc = (text: string): TiptapNodeT => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }]
})

let tmp: string
let session: ProjectSession
let db: TreeDb
let scene: string

function addScene(id: string, text: string, offset: number): string {
  const first = listNodes(db).find((row) => row.id === scene)
  if (!first) throw new Error('no seeded scene')
  const now = new Date().toISOString()
  db.insert(node)
    .values({
      id,
      parentId: first.parentId,
      kind: 'document',
      hierarchyLevel: 'scene',
      title: id,
      position: first.position + offset,
      created: now,
      modified: now
    })
    .run()
  saveDocument(db, id, doc(text))
  return id
}

const apply = (
  nodeId: string,
  sceneText: string,
  threads: { name: string; event: 'opened' | 'advanced' | 'resolved' | 'dropped'; quote: string }[],
  tags: { name: string; category: 'plotThread' }[] = []
): void => {
  applyDerivedKnowledge(db, {
    nodeId,
    facts: [],
    tags,
    relations: [],
    threads: threads.map((thread) => ({ ...thread, question: '' })),
    sceneText,
    now: new Date().toISOString()
  })
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-derive-threads-'))
  session = createProject(projectFolderFor(tmp, 'Threads'), 'Threads', 'novel')
  db = session.connection.orm
  scene =
    listNodes(db).find((row) => row.kind === 'document' && row.hierarchyLevel === 'scene')?.id ?? ''
})
afterEach(() => {
  session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('thread events across scenes (F-9.14)', () => {
  it('hiding a premature "resolved" in one scene does not block the real one in a later scene', () => {
    const early = 'Mara thought the debt was paid. It was not.'
    const late = 'Years later Mara paid the debt in full and burned the ledger.'
    saveDocument(db, scene, doc(early))
    const later = addScene('scene-late', late, 1)
    const debt = createEntity(db, { kind: 'thread', name: 'The Debt' }).entity.id

    apply(scene, early, [{ name: 'The Debt', event: 'resolved', quote: 'the debt was paid' }])
    const premature = listFactsForEntity(db, debt).find(
      (fact) => fact.attribute === threadAttribute('resolved')
    )
    if (!premature) throw new Error('no event stored')
    // The author: "wrong, it is not resolved here" (what Undo in Changes does).
    setFactHidden(db, premature.id, true)

    apply(later, late, [{ name: 'The Debt', event: 'resolved', quote: 'paid the debt in full' }])
    expect(
      listFactsForEntity(db, debt).filter(
        (fact) => fact.attribute === threadAttribute('resolved') && !fact.hidden
      )
    ).toMatchObject([{ nodeId: later }])
    expect(listThreads(db)[0]?.status).toBe('resolved')
  })

  it('reads a thread that advances and resolves in the same scene as resolved, every time', () => {
    const text = 'The duel went on until Kael yielded and the feud was over.'
    saveDocument(db, scene, doc(text))
    const statuses: string[] = []
    for (let i = 0; i < 24; i++) {
      const name = `Feud ${String.fromCharCode(65 + i)}`
      createEntity(db, { kind: 'thread', name })
      apply(scene, text, [
        { name, event: 'advanced', quote: 'The duel went on' },
        { name, event: 'resolved', quote: 'the feud was over' }
      ])
      statuses.push(listThreads(db).find((thread) => thread.name === name)?.status ?? '')
    }
    expect(statuses).toEqual(Array.from({ length: 24 }, () => 'resolved'))
  })
})

describe('new thread records per reading (F-9.14)', () => {
  it('makes at most two new thread records in one reading, counting plot-thread tags', () => {
    const text =
      'Mara swore the Iron Pact. The Salt Oath bound her. The Red Ledger lay open. ' +
      'The Grey Debt came due. The Black Tide rose.'
    saveDocument(db, scene, doc(text))
    apply(
      scene,
      text,
      [
        { name: 'The Grey Debt', event: 'opened', quote: 'The Grey Debt came due' },
        { name: 'The Black Tide', event: 'opened', quote: 'The Black Tide rose' }
      ],
      [
        { name: 'Iron Pact', category: 'plotThread' },
        { name: 'Salt Oath', category: 'plotThread' },
        { name: 'Red Ledger', category: 'plotThread' }
      ]
    )
    const threads = listEntities(db).filter((entity) => entity.kind === 'thread')
    expect(threads.map((entity) => entity.name).length).toBeLessThanOrEqual(2)
  })
})

describe('the hosted estimate (F-9.14)', () => {
  it('is the provider price with the 25 % markup, padded by the 1.2 safety factor', () => {
    saveDocument(
      db,
      scene,
      doc('The ferry landing was empty when Mara reached it. She set the lantern down and waited.')
    )
    expect(DEFAULT_BILLING_TERMS.markup).toBe(0.25)
    expect(DEFAULT_BILLING_TERMS.estimateSafetyFactor).toBe(1.2)
    const model = bundledPricing().models[0]
    if (!model) throw new Error('no hosted model')
    const estimate = estimateScenes(db, [scene], {
      source: 'cloud',
      model: model.id,
      pricing: null
    })
    expect(estimate.tokensOut).toBe(AI_COST_NOTES.summary.typicalOutTokens)
    const provider = costOf(
      { inUsdPerM: model.inputUsdPerM, outUsdPerM: model.outputUsdPerM },
      estimate.tokensIn,
      estimate.tokensOut
    )
    expect(estimate.costUsd).toBeCloseTo(provider * 1.25 * 1.2, 5)
  })
})
