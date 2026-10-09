import { estimateTokens, priceFor } from '@shared/ai'
import { AI_COST_NOTES } from '@shared/aiCostNotes'
import type { AiSource } from '@shared/aiSettings'
import type { PricingResult } from '@shared/cloudApi'
import { bundledPricing, hostedQuote } from '@shared/hostedPricing'
import {
  CONVERSION_SECONDS_PER_SCENE,
  KNOWLEDGE_CARDS_VERSION,
  type KnowledgeConversion
} from '@shared/knowledge'
import { summaryPrompt, summarySource, summaryStaleness } from '../ai/summarize'
import { getKnowledgeModel, setKnowledgeModel } from '../project/settingsStore'
import type { TreeDb } from '../tree/treeStore'

/**
 * F-9.14's conversion pass (decision D11): re-reading every scene whose summary an older prompt
 * wrote, so the book gets its scene cards, relationships, and threads. It costs money on a paid
 * model, so it never starts on its own: on open the author sees how many scenes, what it will
 * cost on the configured model, and how long, and picks Update now or Later. Until then those
 * scenes are held back from the background pass (`staleSummaryNodeIds({ holdOutdated })`); a
 * scene the author edits is re-read as usual. Before it starts the handler takes a full backup
 * (the Settings › Backups path). Nothing here reads or writes scene text beyond building the
 * prompts it estimates.
 */

/** What the estimate needs from outside the project: where requests go and at what price. */
export interface ConversionContext {
  /** Whether the background summary may run at all: Use AI on, summaries on, a provider set up. */
  available: boolean
  source: AiSource
  /** The fast tier's model, or '' with no provider. */
  model: string
  /** The hosted price table (`GET /pricing`), null until it has answered. */
  pricing: PricingResult | null
  /** The author chose Later in this session. */
  deferred: boolean
}

/** Whether the author has not yet confirmed the pass (scenes stale only by version are held back). */
export function conversionPending(db: TreeDb): boolean {
  return getKnowledgeModel(db).cards < KNOWLEDGE_CARDS_VERSION
}

/**
 * The cost of re-reading `nodeIds` (F-9.14): the input tokens of each scene's prompt exactly as
 * it would be sent now (local estimate, four characters a token), and the output at the summary's
 * typical answer size (`AI_COST_NOTES.summary.typicalOutTokens`), priced on the configured model:
 * a local model is free; MythScribe Cloud is the hosted quote (provider price plus the markup,
 * padded by the safety factor, `hostedQuote`); an own key is the provider's price (`priceFor`).
 */
export function estimateScenes(
  db: TreeDb,
  nodeIds: readonly string[],
  context: Pick<ConversionContext, 'source' | 'model' | 'pricing'>
): { tokensIn: number; tokensOut: number; costUsd: number; priced: boolean } {
  let tokensIn = 0
  for (const id of nodeIds) {
    const source = summarySource(db, id)
    if (source === null) continue
    const prompt = summaryPrompt(db, source)
    tokensIn += estimateTokens(prompt.messages.map((message) => message.content).join('\n'))
  }
  const tokensOut = nodeIds.length * AI_COST_NOTES.summary.typicalOutTokens
  return { tokensIn, tokensOut, ...estimateCost(context, tokensIn, tokensOut) }
}

/**
 * What `tokensIn` and `tokensOut` cost on the configured model: nothing on a local model, the
 * hosted quote on MythScribe Cloud (`hostedQuote`), the provider's price on an own key
 * (`priceFor`). F-9.16's check estimate prices the same way.
 */
export function estimateCost(
  context: Pick<ConversionContext, 'source' | 'model' | 'pricing'>,
  tokensIn: number,
  tokensOut: number
): { costUsd: number; priced: boolean } {
  if (context.source === 'local') return { costUsd: 0, priced: true }
  if (context.source === 'cloud') {
    const quote = hostedQuote(
      context.pricing ?? bundledPricing(),
      context.model,
      tokensIn,
      tokensOut
    )
    return { costUsd: quote.costUsd, priced: quote.priced }
  }
  const price = priceFor(context.model, tokensIn, tokensOut)
  return { costUsd: price.costUsd, priced: price.priced }
}

/**
 * Where the pass stands and what it would cost (`knowledge:conversion`). `none` when the AI cannot
 * run here (no dialog with Use AI off) or no scene waits on it; `done` once the author confirmed.
 */
export function estimateConversion(db: TreeDb, context: ConversionContext): KnowledgeConversion {
  const base: KnowledgeConversion = {
    state: 'none',
    scenes: 0,
    costUsd: 0,
    priced: true,
    model: context.model,
    source: context.source,
    minutes: 0,
    deferred: context.deferred
  }
  if (!conversionPending(db)) return { ...base, state: 'done' }
  if (!context.available) return base
  const { outdated } = summaryStaleness(db)
  if (outdated.length === 0) return base
  const estimate = estimateScenes(db, outdated, context)
  return {
    ...base,
    state: 'pending',
    scenes: outdated.length,
    costUsd: estimate.costUsd,
    priced: estimate.priced,
    minutes: Math.max(1, Math.ceil((outdated.length * CONVERSION_SECONDS_PER_SCENE) / 60))
  }
}

/** Records the author's go-ahead: from now on the background pass re-reads outdated scenes too. */
export function confirmConversion(db: TreeDb): void {
  setKnowledgeModel(db, { cards: KNOWLEDGE_CARDS_VERSION })
}
