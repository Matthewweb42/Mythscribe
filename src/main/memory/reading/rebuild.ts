import { and, eq, gte } from 'drizzle-orm'
import type { Claim } from '@shared/memory/claims'
import { dismissedKey } from '@shared/memory/dismissed'
import { gateText } from '@shared/memory/gate'
import { locateQuote } from '@shared/memory/quote'
import { slotLabel } from '@shared/memory/slots'
import type { RebuildAction, RebuildProgress, RebuildSummary } from '@shared/memory/views'
import { reading } from '../../db/schema'
import { activeDraftId } from '../../draft/draftStore'
import type { TreeDb } from '../../tree/treeStore'
import { dismiss } from '../dismissedStore'
import { answerNameQuestion } from '../questions'
import { getRecord } from '../recordStore'
import { readableScenes } from './backlog'
import { deleteClaims, draftClaims } from './claimStore'
import { loadReadingScene, type ReadingScene } from './readerContext'
import { getRebuild, setRebuild } from './readerRows'
import { markRosterForRebuild } from './roster'

/**
 * *Rebuild memory* (F-16.19; design §2.7, plan P2a §3.6, P2a-D25): the whole active draft read
 * once, scene by scene, each full read replacing the claims of that scene it did not prove again,
 * so a stopped rebuild leaves each scene old or new, never empty; other drafts' rows, the
 * Dismissed list and everything the author wrote are untouched. Priced before it starts; its
 * progress is a settings row, so the queue resumes after a close. At the end, the summary groups
 * what it added by sheet, with *Not right* for a sheet's new lines and *Not names* for the names it
 * left waiting.
 */

/** Starts a rebuild: its progress row, the roster built afresh; answers the scenes to read. */
export function startRebuild(db: TreeDb, now: Date): { nodeIds: string[]; progress: RebuildProgress } {
  const nodeIds = readableScenes(db).map((scene) => scene.nodeId)
  const progress: RebuildProgress = {
    startedAt: now.toISOString(),
    finishedAt: nodeIds.length === 0 ? now.toISOString() : null,
    draftId: activeDraftId(db),
    total: nodeIds.length,
    done: 0
  }
  setRebuild(db, progress)
  markRosterForRebuild(db)
  return { nodeIds, progress }
}

/**
 * One scene of the rebuild read (or found unreadable), `remaining` scenes still queued: answers
 * whether this one ended the rebuild (once only).
 */
export function rebuildSceneDone(db: TreeDb, now: Date, remaining: number): boolean {
  const progress = getRebuild(db)
  if (progress?.finishedAt !== null) return false
  const ended = remaining === 0
  setRebuild(db, {
    ...progress,
    done: Math.min(progress.total, progress.done + 1),
    finishedAt: ended ? now.toISOString() : null
  })
  return ended
}

/** The claims the rebuild's readings stored (not the ones it kept or revived). */
function rebuildClaims(db: TreeDb, progress: RebuildProgress): Claim[] {
  const ids = db
    .select({ id: reading.id })
    .from(reading)
    .where(
      and(
        eq(reading.draftId, progress.draftId),
        eq(reading.purpose, 'rebuild'),
        gte(reading.created, progress.startedAt)
      )
    )
    .all()
    .map((row) => row.id)
  if (ids.length === 0) return []
  const readings = new Set(ids)
  return draftClaims(db, progress.draftId).filter(
    (claim) => claim.readingId !== null && readings.has(claim.readingId)
  )
}

/** What the last rebuild changed, grouped by sheet; null before any rebuild. */
export function rebuildSummary(db: TreeDb): RebuildSummary | null {
  const progress = getRebuild(db)
  if (progress === null) return null
  const claims = rebuildClaims(db, progress)
  const sheets = new Map<string, string[]>()
  const waiting = new Map<string, { text: string; lines: number }>()
  for (const claim of claims) {
    if (claim.state === 'live' && claim.recordId !== null) {
      sheets.set(claim.recordId, [...(sheets.get(claim.recordId) ?? []), claim.id])
    }
    if (claim.state === 'waiting' && claim.pending?.kind === 'name') {
      const entry = waiting.get(claim.pending.norm) ?? { text: claim.pending.text, lines: 0 }
      waiting.set(claim.pending.norm, { ...entry, lines: entry.lines + 1 })
    }
  }
  return {
    progress,
    sheets: [...sheets]
      .map(([recordId, claimIds]) => ({
        recordId,
        name: getRecord(db, recordId)?.name ?? '',
        lines: claimIds.length,
        claimIds
      }))
      .filter((sheet) => sheet.name !== '')
      .sort((a, b) => b.lines - a.lines || a.name.localeCompare(b.name)),
    waiting: [...waiting]
      .map(([norm, entry]) => ({ norm, text: entry.text, lines: entry.lines }))
      .sort((a, b) => b.lines - a.lines || a.text.localeCompare(b.text))
  }
}

/** The gate texts of a claim's quote sentences (what a `notRight` dismissal keys on), or null. */
function statingOf(scene: ReadingScene, claim: Claim): string[] | null {
  const only = scene.texts.map((text, i) => (i === claim.para ? text : ''))
  const location = locateQuote(only, claim.para, claim.quote)
  if (!location.ok) return null
  return location.sentences.map((i) =>
    gateText(scene.spans[claim.para]?.[i]?.text ?? '', scene.shared.index)
  )
}

/**
 * *Not right* for these claims (F-16.18's *Wrong value*, in bulk): a `notRight` Dismissed row for
 * each (by record, slot, value and its sentences), and the claim goes. Answers how many went.
 */
export function dismissClaimsNotRight(db: TreeDb, claims: readonly Claim[], now: Date): number {
  const scenes = new Map<string, ReadingScene | null>()
  const gone: string[] = []
  for (const claim of claims) {
    if (claim.recordId === null) continue
    if (!scenes.has(claim.nodeId)) scenes.set(claim.nodeId, loadReadingScene(db, claim.nodeId))
    const scene = scenes.get(claim.nodeId) ?? null
    const stating = scene === null ? null : statingOf(scene, claim)
    if (stating !== null) {
      const name = getRecord(db, claim.recordId)?.name ?? ''
      dismiss(
        db,
        {
          kind: 'notRight',
          key: dismissedKey({
            kind: 'notRight',
            recordId: claim.recordId,
            slot: claim.slot,
            value: claim.value,
            stating
          }),
          recordId: claim.recordId,
          nodeId: claim.nodeId,
          label: `${name}: ${slotLabel(claim.slot)} ${claim.value}`,
          quote: claim.quote
        },
        now
      )
    }
    gone.push(claim.id)
  }
  deleteClaims(db, gone)
  return gone.length
}

/** The summary's bulk actions; answers how many lines or names they took away. */
export function applyRebuildAction(
  db: TreeDb,
  action: RebuildAction,
  now: Date
): { changed: number; nodeIds: string[]; recordIds: string[]; names: boolean } {
  const progress = getRebuild(db)
  if (progress === null) return { changed: 0, nodeIds: [], recordIds: [], names: false }
  const claims = rebuildClaims(db, progress)
  if (action.action === 'notRightAll') {
    const lines = claims.filter(
      (claim) => claim.state === 'live' && claim.recordId === action.recordId
    )
    const changed = db.transaction((tx) => dismissClaimsNotRight(tx, lines, now))
    return {
      changed,
      nodeIds: [...new Set(lines.map((claim) => claim.nodeId))],
      recordIds: [action.recordId],
      names: false
    }
  }
  const names = new Map<string, string>()
  for (const claim of claims) {
    if (claim.state === 'waiting' && claim.pending?.kind === 'name') {
      names.set(claim.pending.norm, claim.pending.text)
    }
  }
  const nodeIds = new Set<string>()
  for (const text of names.values()) {
    const { settled } = answerNameQuestion(db, { kind: 'notAName', name: text }, now)
    for (const nodeId of settled?.nodeIds ?? []) nodeIds.add(nodeId)
  }
  return { changed: names.size, nodeIds: [...nodeIds], recordIds: [], names: names.size > 0 }
}

/** *Stop* (the queue's Cancel): an unfinished rebuild ends where it stood, without its spot checks. */
export function stopRebuild(db: TreeDb, now: Date): void {
  const progress = getRebuild(db)
  if (progress?.finishedAt !== null) return
  setRebuild(db, { ...progress, finishedAt: now.toISOString() })
}

