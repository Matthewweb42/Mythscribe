import type { VoiceConsistencyReport } from '@shared/ipc/contract'
import { computeStylometrics, RULE_MIN_WORDS } from '@shared/stylometry'
import { scoreDocumentDrift } from '@shared/voiceFidelity'
import type { TreeDb } from '../tree/treeStore'
import { buildVoiceProfile, documentText, manuscriptDocuments } from './profile'

/**
 * The whole-manuscript voice consistency report (F-14.7): the profile (cached, the same one
 * ghost text carries, narrowed to `pov` the same way) against every manuscript document's own
 * stylometrics, in tree order. A document under `RULE_MIN_WORDS` is reported as `short` and
 * not scored (the rate-based signals are noise there); one with violations is `drift`; the
 * rest are `ok`. Local and on demand: one stylometrics pass per document, no AI call, never
 * cached and never on a timer.
 */
export function buildConsistencyReport(
  db: TreeDb,
  opts: { pov?: string } = {}
): VoiceConsistencyReport {
  const profile = buildVoiceProfile(db, opts)
  const documents = manuscriptDocuments(db).map((row) => {
    const stats = computeStylometrics(documentText(row))
    if (stats.wordCount < RULE_MIN_WORDS) {
      return {
        id: row.id,
        title: row.title,
        wordCount: stats.wordCount,
        status: 'short' as const,
        violations: []
      }
    }
    const violations = scoreDocumentDrift(profile.stats, stats).violations.map((v) => v.message)
    return {
      id: row.id,
      title: row.title,
      wordCount: stats.wordCount,
      status: violations.length > 0 ? ('drift' as const) : ('ok' as const),
      violations
    }
  })
  return { profileWordCount: profile.wordCount, documents }
}
