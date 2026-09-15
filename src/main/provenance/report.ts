import type { ProvenanceReport } from '@shared/ipc/contract'
import { aiOriginPercent, aiOriginStats } from '@shared/provenance'
import type { TreeDb } from '../tree/treeStore'
import { documentJson, manuscriptDocuments } from '../voice/profile'

/**
 * The provenance report (F-14.6): every manuscript document's AI-origin characters (the
 * `aiOrigin` marks in its saved JSON, counted by `aiOriginStats`, the one owner of the
 * counting) in tree order, plus the project total. Local and on demand: one walk per
 * document, no AI call, never cached. An unreadable row counts as empty, never a throw.
 */
export function buildProvenanceReport(db: TreeDb): ProvenanceReport {
  let aiChars = 0
  let totalChars = 0
  const documents = manuscriptDocuments(db).map((row) => {
    const json = documentJson(row)
    const stats =
      json === null ? { aiChars: 0, totalChars: 0, byProposal: {} } : aiOriginStats(json)
    aiChars += stats.aiChars
    totalChars += stats.totalChars
    return {
      id: row.id,
      title: row.title,
      aiChars: stats.aiChars,
      totalChars: stats.totalChars,
      percent: aiOriginPercent(stats),
      proposals: Object.keys(stats.byProposal).length
    }
  })
  return {
    projectPercent: aiOriginPercent({ aiChars, totalChars }),
    aiChars,
    totalChars,
    documents
  }
}
