import type { DocumentWordCounts, WordCount } from '@shared/proposedTags'
import { dismissedKey } from '@shared/memory/dismissed'
import {
  countNameSpans,
  nameQuestions,
  type NameAnswer,
  type NameAnswerResult,
  type NameQuestion
} from '@shared/memory/nameQuestions'
import { normName } from '@shared/memory/names'
import { currentDraftId } from '../draft/draftStore'
import type { TreeDb } from '../tree/treeStore'
import { documentText, manuscriptDocuments } from '../voice/profile'
import { dismiss, dismissedKeys } from './dismissedStore'
import { waitingNameNorms } from './reading/claimStore'
import { settleWaitingName, type SettledName } from './reading/waiting'
import { addAlias, createRecord, requireRecord, rosterOf, topicLabels } from './recordStore'

/**
 * Name questions in Needs a look (F-16.4): computed, never stored, from the manuscript's
 * capitalised spans (`countNameSpans`), the roster and the Dismissed list. Each document's counts
 * are memoised by its text (the F-4.12b pattern), so only a document that changed is read again.
 */

interface CountedDocument {
  text: string
  counts: Map<string, WordCount>
}

/** Per-document counts by node id, rebuilt from the open project's rows on every call. */
let memo = new Map<string, CountedDocument>()

/** The questions to ask now: new names and nicknames, most named first. */
export function listNameQuestions(db: TreeDb): NameQuestion[] {
  const next = new Map<string, CountedDocument>()
  const perDocument: DocumentWordCounts[] = []
  for (const row of manuscriptDocuments(db)) {
    const text = documentText(row)
    const hit = memo.get(row.id)
    const counted = hit?.text === text ? hit : { text, counts: countNameSpans(text) }
    next.set(row.id, counted)
    perDocument.push({ nodeId: row.id, counts: counted.counts })
  }
  memo = next
  // F-16.17: a name the reader proposed with a proved fact is asked about once it is seen once.
  const draftId = currentDraftId(db)
  return nameQuestions(
    perDocument,
    rosterOf(db),
    { names: [...dismissedKeys(db, 'name')], aliasKeys: dismissedKeys(db, 'alias') },
    {
      proved: draftId === null ? new Set() : waitingNameNorms(db, draftId),
      labels: topicLabels(db)
    }
  )
}

/**
 * Answers one question. A new name: *Add as* makes a record of it in the category picked (the
 * author's own act: the gate warns, never blocks, decision P1-D4), *Not a name* dismisses it. A
 * nickname: *Yes* adds it to the record (origin `confirmed`), *No* dismisses it for that record.
 */
export function answerQuestion(db: TreeDb, answer: NameAnswer, now: Date): NameAnswerResult {
  switch (answer.kind) {
    case 'addAs': {
      const made = createRecord(
        db,
        { name: answer.name, categoryId: answer.categoryId, force: true },
        now
      )
      return 'record' in made
        ? { kind: 'record', record: made.record }
        : { kind: 'gate', gate: made.gate }
    }
    case 'notAName':
      return {
        kind: 'dismissed',
        dismissed: dismiss(
          db,
          {
            kind: 'name',
            key: dismissedKey({ kind: 'name', name: answer.name }),
            label: `${answer.name}: not a name`,
            quote: answer.name
          },
          now
        )
      }
    case 'yes':
      return {
        kind: 'record',
        record: addAlias(db, answer.recordId, { text: answer.name, origin: 'confirmed' }, now)
      }
    case 'no': {
      const owner = requireRecord(db, answer.recordId)
      return {
        kind: 'dismissed',
        dismissed: dismiss(
          db,
          {
            kind: 'alias',
            key: dismissedKey({ kind: 'alias', recordId: owner.id, alias: answer.name }),
            recordId: owner.id,
            label: `"${answer.name}" is not ${owner.name}`,
            quote: answer.name
          },
          now
        )
      }
    }
  }
}

/**
 * Answers a question and settles the reader's facts waiting on the name (F-16.17, P2a-D7): a Yes
 * (*Add as*, a nickname's *Yes*) attaches them after an anchor check, a No (*Not a name*, a
 * nickname's *No*) deletes them. A gate warning (no record made) leaves them waiting.
 */
export function answerNameQuestion(
  db: TreeDb,
  answer: NameAnswer,
  now: Date
): { result: NameAnswerResult; settled: SettledName | null } {
  const result = answerQuestion(db, answer, now)
  const norm = normName(answer.name)
  const settled =
    result.kind === 'gate'
      ? null
      : result.kind === 'record'
        ? settleWaitingName(db, norm, result.record.id, now)
        : settleWaitingName(db, norm, null, now)
  return { result, settled }
}

/** Forgets the memoised counts (a project change, or one test's manuscript before the next). */
export function resetNameQuestionCache(): void {
  memo = new Map()
}
