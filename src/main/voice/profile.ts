import { docToText } from '@shared/docText'
import type { VoiceExemplar, VoiceProfile } from '@shared/ipc/contract'
import { parseStoredSceneMeta } from '@shared/sceneMeta'
import { computeStylometrics, renderVoiceRules } from '@shared/stylometry'
import { TiptapNode, type TiptapNodeT } from '@shared/tiptap'
import { voiceConfidence } from '@shared/voice'
import type { NodeRow } from '../db/schema'
import { listNodes, type TreeDb } from '../tree/treeStore'
import { listExemplars } from './exemplarStore'
import { currentVoiceVersion } from './versionCache'

export type { VoiceProfile } from '@shared/ipc/contract'

/** Words a POV's documents must hold before the profile narrows to them; below it, the whole manuscript is used. */
export const POV_MIN_WORDS = 2_000

const cache = new Map<string, { version: number; profile: VoiceProfile }>()

/** The version the profile builder is on; the ghost-text context hash carries it. */
export const voiceProfileVersion = currentVoiceVersion

/**
 * The voice profile (F-14.1), built locally: the manuscript's stylometrics rendered as rules,
 * every exemplar, and the confidence. Cached per POV key until the version counter moves (an
 * exemplar write, a document save, or a project change), so ghost text, which calls this on
 * every request, pays for the walk once per edit burst rather than once per keystroke.
 */
export function buildVoiceProfile(db: TreeDb, opts: { pov?: string } = {}): VoiceProfile {
  const key = normalizePov(opts.pov)
  const hit = cache.get(key)
  if (hit?.version === currentVoiceVersion()) return hit.profile
  const profile = compute(db, key)
  cache.set(key, { version: currentVoiceVersion(), profile })
  return profile
}

/** Trimmed, lower-cased, '' for nothing: POV is free text, so "Mara" and "mara " are one person. */
export function normalizePov(pov: string | null | undefined): string {
  return (pov ?? '').trim().toLowerCase()
}

function compute(db: TreeDb, pov: string): VoiceProfile {
  const documents = manuscriptDocuments(db)
  let corpus = documents
  if (pov.length > 0) {
    // Each document's own scene_meta.pov, no ancestor walk: a folder-kind scene's POV covers
    // only documents that carry their own metadata, which is the seeded (document-kind) shape.
    const group = documents.filter(
      (row) => normalizePov(parseStoredSceneMeta(row.sceneMeta).pov) === pov
    )
    const words = group.reduce((sum, row) => sum + row.wordCount, 0)
    if (words >= POV_MIN_WORDS) corpus = group
  }
  const text = corpus
    .map(documentText)
    .filter((t) => t.length > 0)
    .join('\n\n')
  const stats = computeStylometrics(text)
  const exemplars = orderExemplars(listExemplars(db), pov)
  return {
    rules: renderVoiceRules(stats),
    stats,
    exemplars,
    confidence: voiceConfidence(stats.wordCount, exemplars.length),
    wordCount: stats.wordCount
  }
}

/** The document rows under the manuscript root, in tree order; the consistency report (F-14.7) walks the same rows. */
export function manuscriptDocuments(db: TreeDb): NodeRow[] {
  const rows = listNodes(db)
  const root = rows.find((row) => row.parentId === null && row.sectionType === 'manuscript')
  if (!root) return []
  const byId = new Map(rows.map((row) => [row.id, row]))
  const under = new Map<string, boolean>([[root.id, true]])
  const isUnder = (id: string): boolean => {
    const known = under.get(id)
    if (known !== undefined) return known
    const parent = byId.get(id)?.parentId
    const result = typeof parent === 'string' && isUnder(parent)
    under.set(id, result)
    return result
  }
  return rows.filter((row) => row.kind === 'document' && isUnder(row.id))
}

/** The plain text of a stored document; '' for an empty or unreadable row, never a throw (one corrupt row must not break every request). */
export function documentText(row: NodeRow): string {
  const json = documentJson(row)
  return json === null ? '' : docToText(json)
}

/** The stored document as Tiptap JSON; null for an empty or unreadable row, never a throw. The provenance report (F-14.6) parses the same way. */
export function documentJson(row: NodeRow): TiptapNodeT | null {
  if (row.content === null) return null
  let json: unknown
  try {
    json = JSON.parse(row.content)
  } catch {
    return null
  }
  const parsed = TiptapNode.safeParse(json)
  return parsed.success ? parsed.data : null
}

/** POV-matching exemplars first (when a POV was asked for), insertion order otherwise; stable. */
function orderExemplars(exemplars: VoiceExemplar[], pov: string): VoiceExemplar[] {
  if (pov.length === 0) return exemplars
  const matching = exemplars.filter((e) => normalizePov(e.pov) === pov)
  const rest = exemplars.filter((e) => normalizePov(e.pov) !== pov)
  return [...matching, ...rest]
}
