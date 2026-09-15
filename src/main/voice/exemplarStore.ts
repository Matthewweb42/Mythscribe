import { randomUUID } from 'node:crypto'
import { asc, count, eq, sql } from 'drizzle-orm'
import type { VoiceExemplar } from '@shared/ipc/contract'
import { parseStoredSceneMeta } from '@shared/sceneMeta'
import { classifyKind } from '@shared/stylometry'
import {
  VOICE_EXEMPLAR_MAX,
  VOICE_EXEMPLAR_TEXT_MAX,
  VOICE_EXEMPLAR_TEXT_MIN
} from '@shared/voice'
import { voiceExemplar } from '../db/schema'
import { AppError } from '../ipc/errors'
import { requireContentTarget } from '../tree/contentTarget'
import type { TreeDb } from '../tree/treeStore'
import { bumpVoiceVersion } from './versionCache'

/**
 * The author-marked voice exemplars (F-14.1). A row is a plain-text snapshot: it keeps the
 * passage as it read when it was marked, so later edits to the scene (or deleting it, which
 * only clears `nodeId`) never change the voice the profile was built on. Every write bumps the
 * profile's version so the next `buildVoiceProfile` recomputes.
 */

/** Every exemplar, oldest first (the profile's tie-break order); two marked within one millisecond keep insertion order. */
export function listExemplars(db: TreeDb): VoiceExemplar[] {
  return db
    .select()
    .from(voiceExemplar)
    .orderBy(asc(voiceExemplar.created), sql`rowid`)
    .all()
}

/**
 * Marks a passage of a document as an exemplar. The text is trimmed and bounded (the contract
 * refuses out-of-bounds input first; this is the backstop), the POV is the document's scene
 * metadata at mark time, the kind is `classifyKind`. NOT_FOUND for an unknown node, VALIDATION
 * for a section root or a folder, and VALIDATION once the project holds the maximum.
 */
export function addExemplar(db: TreeDb, nodeId: string, rawText: string): VoiceExemplar {
  return db.transaction((tx) => {
    const row = requireContentTarget(tx, nodeId, 'voice exemplars')
    if (row.kind !== 'document') {
      throw new AppError('VALIDATION', 'Only a document can hold a voice exemplar', {
        id: nodeId,
        kind: row.kind
      })
    }
    const text = rawText.trim()
    if (text.length < VOICE_EXEMPLAR_TEXT_MIN || text.length > VOICE_EXEMPLAR_TEXT_MAX) {
      throw new AppError(
        'VALIDATION',
        `A voice exemplar is ${VOICE_EXEMPLAR_TEXT_MIN} to ${VOICE_EXEMPLAR_TEXT_MAX} characters`,
        { length: text.length }
      )
    }
    const existing = tx.select({ n: count() }).from(voiceExemplar).get()?.n ?? 0
    if (existing >= VOICE_EXEMPLAR_MAX) {
      throw new AppError(
        'VALIDATION',
        `A voice profile holds at most ${VOICE_EXEMPLAR_MAX} exemplars. Remove one to add another.`,
        { count: existing }
      )
    }
    const pov = parseStoredSceneMeta(row.sceneMeta).pov.trim()
    const inserted: VoiceExemplar = {
      id: randomUUID(),
      nodeId,
      text,
      pov: pov.length > 0 ? pov : null,
      kind: classifyKind(text),
      created: new Date().toISOString()
    }
    tx.insert(voiceExemplar).values(inserted).run()
    bumpVoiceVersion()
    return inserted
  })
}

/** Removes an exemplar; NOT_FOUND when the id is unknown (the `deleteTag` convention). */
export function removeExemplar(db: TreeDb, id: string): void {
  const result = db.delete(voiceExemplar).where(eq(voiceExemplar.id, id)).run()
  if (result.changes === 0) throw new AppError('NOT_FOUND', 'Voice exemplar not found', { id })
  bumpVoiceVersion()
}
