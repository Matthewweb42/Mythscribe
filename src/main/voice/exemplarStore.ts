import { createHash, randomUUID } from 'node:crypto'
import { asc, count, eq, sql } from 'drizzle-orm'
import type { VoiceExemplar } from '@shared/ipc/contract'
import { parseStoredSceneMeta } from '@shared/sceneMeta'
import { classifyKind } from '@shared/stylometry'
import {
  VOICE_AUTO_DISMISSED_MAX,
  VOICE_EXEMPLAR_MAX,
  VOICE_EXEMPLAR_TEXT_MAX,
  VOICE_EXEMPLAR_TEXT_MIN,
  type VoiceExemplarKind
} from '@shared/voice'
import { voiceExemplar } from '../db/schema'
import { AppError } from '../ipc/errors'
import { getVoiceAutoState, setVoiceAutoState } from '../project/settingsStore'
import { requireContentTarget } from '../tree/contentTarget'
import type { TreeDb } from '../tree/treeStore'
import { bumpVoiceVersion } from './versionCache'

/**
 * The voice exemplars: the author-marked ones (F-14.1) and, since F-14.14, the ones the local
 * voice job picks (`source = 'auto'`). A row is a plain-text snapshot: it keeps the
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
 * for a section root or a folder, and VALIDATION once the project holds the maximum of
 * hand-marked ones (automatic ones never count against it).
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
    const existing =
      tx.select({ n: count() }).from(voiceExemplar).where(eq(voiceExemplar.source, 'author')).get()
        ?.n ?? 0
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
      created: new Date().toISOString(),
      source: 'author'
    }
    tx.insert(voiceExemplar).values(inserted).run()
    bumpVoiceVersion()
    return inserted
  })
}

/**
 * Removes an exemplar; NOT_FOUND when the id is unknown (the `deleteTag` convention). An
 * automatic one (F-14.14) is remembered by its text's hash, so the voice job never picks the
 * same passage again; the oldest memories go past `VOICE_AUTO_DISMISSED_MAX`.
 */
export function removeExemplar(db: TreeDb, id: string): void {
  db.transaction((tx) => {
    const row = tx.select().from(voiceExemplar).where(eq(voiceExemplar.id, id)).get()
    if (!row) throw new AppError('NOT_FOUND', 'Voice exemplar not found', { id })
    tx.delete(voiceExemplar).where(eq(voiceExemplar.id, id)).run()
    if (row.source === 'auto') {
      const state = getVoiceAutoState(tx)
      const hash = passageHash(row.text)
      const dismissed = [...state.dismissed.filter((h) => h !== hash), hash]
      setVoiceAutoState(tx, {
        ...state,
        dismissed: dismissed.slice(-VOICE_AUTO_DISMISSED_MAX)
      })
    }
  })
  bumpVoiceVersion()
}

/** The hash an automatic passage is remembered by once removed (F-14.14). */
export function passageHash(text: string): string {
  return createHash('sha256').update(text.trim()).digest('hex')
}

/** A passage the voice job picked (F-14.14), before it is stored. */
export interface AutoExemplarPick {
  nodeId: string
  text: string
  pov: string | null
  kind: VoiceExemplarKind
}

/**
 * Replaces the automatic exemplars (F-14.14) with `picks`, in their order, leaving every
 * hand-marked row alone. Answers whether anything changed; an identical set writes nothing and
 * keeps the profile's version, so a refresh that re-picks the same passages costs no prompt
 * cache.
 */
export function replaceAutoExemplars(db: TreeDb, picks: AutoExemplarPick[], now: Date): boolean {
  const changed = db.transaction((tx) => {
    const current = tx
      .select()
      .from(voiceExemplar)
      .where(eq(voiceExemplar.source, 'auto'))
      .orderBy(asc(voiceExemplar.created), sql`rowid`)
      .all()
    const same =
      current.length === picks.length &&
      current.every((row, i) => row.text === picks[i]?.text && row.nodeId === picks[i]?.nodeId)
    if (same) return false
    tx.delete(voiceExemplar).where(eq(voiceExemplar.source, 'auto')).run()
    const created = now.toISOString()
    for (const pick of picks) {
      tx.insert(voiceExemplar)
        .values({ id: randomUUID(), ...pick, created, source: 'auto' })
        .run()
    }
    return true
  })
  if (changed) bumpVoiceVersion()
  return changed
}
