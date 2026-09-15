import type { TiptapNodeT } from './tiptap'

/**
 * Provenance (F-14.6): accepted AI text carries the `aiOrigin` mark with the proposal it came
 * from, and this module is the one owner of how that text is counted. Counting is by
 * characters of text nodes, so inline tag tokens and block structure weigh nothing; a
 * percentage is `aiChars / totalChars` of the same document.
 */
export const AI_ORIGIN_MARK = 'aiOrigin'

/**
 * A proposal's marked text survives edits until less than this share of what the author
 * accepted is left in the document; then every span of that proposal loses the mark, because
 * what remains is the author's rewrite, not the AI's text.
 */
export const AI_ORIGIN_KEEP_RATIO = 0.5

export interface AiOriginAttrs {
  /** The `ai_proposal` row the text was accepted from (F-14.5). */
  proposalId: string
  /** How many characters the author accepted from that proposal, the baseline for the ratio. */
  accepted: number
}

export interface AiOriginStats {
  /** Characters of text carrying the mark. */
  aiChars: number
  /** Characters of every text node in the document. */
  totalChars: number
  /** Marked characters per proposal id, in document order of first appearance. */
  byProposal: Record<string, number>
}

/** Reads the mark's attrs off a stored mark, or null when they are not the expected shape. */
export function aiOriginAttrsOf(mark: {
  type: string
  attrs?: Record<string, unknown>
}): AiOriginAttrs | null {
  if (mark.type !== AI_ORIGIN_MARK) return null
  const proposalId = mark.attrs?.proposalId
  const accepted = mark.attrs?.accepted
  if (typeof proposalId !== 'string' || proposalId === '') return null
  if (typeof accepted !== 'number' || !Number.isFinite(accepted) || accepted < 0) return null
  return { proposalId, accepted }
}

/** Counts the AI-origin and total characters of a stored document. Never throws on odd shapes. */
export function aiOriginStats(doc: TiptapNodeT): AiOriginStats {
  const stats: AiOriginStats = { aiChars: 0, totalChars: 0, byProposal: {} }
  walk(doc, stats)
  return stats
}

function walk(node: TiptapNodeT, stats: AiOriginStats): void {
  if (typeof node.text === 'string') {
    const length = node.text.length
    stats.totalChars += length
    const attrs = node.marks?.map(aiOriginAttrsOf).find((a) => a !== null) ?? null
    if (attrs && length > 0) {
      stats.aiChars += length
      stats.byProposal[attrs.proposalId] = (stats.byProposal[attrs.proposalId] ?? 0) + length
    }
  }
  for (const child of node.content ?? []) walk(child, stats)
}

/** The AI-origin share as a whole percentage, 0 for an empty document. */
export function aiOriginPercent(stats: Pick<AiOriginStats, 'aiChars' | 'totalChars'>): number {
  if (stats.totalChars === 0) return 0
  return Math.round((stats.aiChars / stats.totalChars) * 100)
}
