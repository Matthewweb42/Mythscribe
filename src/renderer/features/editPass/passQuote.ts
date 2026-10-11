import { DEFAULT_MODELS, outputBudget, type Tier } from '@shared/ai'
import type { AiSource } from '@shared/aiSettings'
import {
  EDIT_PASS_TIER,
  estimateEditPass,
  type EditPassEstimate,
  type EditPassType
} from '@shared/editPass'
import { hostedModelFor, hostedQuote, type HostedQuote } from '@shared/hostedPricing'
import type { PricingResult } from '@shared/cloudApi'
import { hostedPricingNow, useHostedPricing } from '@renderer/features/account/hostedPricing'
import { useAiSettingsStore } from '@renderer/features/ai/aiSettingsStore'
import { providerOf, routedTier, useAiStore } from '@renderer/features/ai/aiStore'
import { formatCount, formatUsd } from '@renderer/features/ai/usageFormat'

/**
 * What an edit pass would cost before it starts (F-14.15; the chat's edit choices, F-5.26, show
 * the same): the tier and model it goes out on for this project's source, its estimate, and on
 * MythScribe Cloud the server-priced quote whose threshold asks for a confirm.
 */

interface ModelInputs {
  source: AiSource
  status: ReturnType<typeof useAiStore.getState>['status']
  choice: ReturnType<typeof useAiStore.getState>['choice']
  pricing: PricingResult
}

/**
 * The tier and model a pass of this kind goes out on (F-5.11, F-15.4), after the author's model
 * choice (AI-BILLING-SPEC M8, R4). On MythScribe Cloud a tier left at its default follows the
 * server's routing table, as main does.
 */
function passModelOf(
  type: EditPassType,
  { source, status, choice, pricing }: ModelInputs
): { tier: Tier; model: string; source: AiSource } {
  const tier = routedTier(choice, source, 'editPass', EDIT_PASS_TIER[type])
  const chosen = status?.models[providerOf(status, source)][tier] ?? DEFAULT_MODELS[tier]
  const model = source === 'cloud' ? hostedModelFor(tier, chosen, pricing) : chosen
  return { tier, model, source }
}

/** The pass's model for the project's source, following the stores (the workspace and the chat card). */
export function usePassModel(type: EditPassType): { tier: Tier; model: string; source: AiSource } {
  const source = useAiSettingsStore((s) => s.settings?.source ?? 'ownKey')
  const status = useAiStore((s) => s.status)
  const choice = useAiStore((s) => s.choice)
  const pricing = useHostedPricing()
  return passModelOf(type, { source, status, choice, pricing })
}

export interface PassQuote {
  model: string
  estimate: EditPassEstimate
  /** The hosted quote on MythScribe Cloud; null on an own key or a local model. */
  quote: HostedQuote | null
}

/** A pass's estimate and quote for scenes of `sceneWords` words on `model`. */
export function quotePass(
  type: EditPassType,
  sceneWords: readonly number[],
  model: string,
  hosted: boolean,
  pricing: PricingResult
): PassQuote {
  const estimate = estimateEditPass(type, sceneWords, model, outputBudget('editPass'))
  // Hosted flow 2, R3, E4: quoted at the server's price for the sum of its chunks, padded by
  // the safety factor; above the threshold the start asks for a confirm first.
  const quote = hosted ? hostedQuote(pricing, model, estimate.tokensIn, estimate.tokensOut) : null
  return { model, estimate, quote }
}

/** The same, read once outside React (the chat starting a specific request at once). */
export function quotePassNow(type: EditPassType, sceneWords: readonly number[]): PassQuote {
  const source = useAiSettingsStore.getState().settings?.source ?? 'ownKey'
  const { status, choice } = useAiStore.getState()
  const pricing = hostedPricingNow()
  const { model } = passModelOf(type, { source, status, choice, pricing })
  return quotePass(type, sceneWords, model, source === 'cloud', pricing)
}

/** The estimate line: dollars on Cloud (AI-BILLING-SPEC C4), dollars and tokens otherwise. */
export function estimateLine({ model, estimate, quote }: PassQuote): string {
  if (quote !== null) {
    return quote.priced
      ? `With MythScribe: up to about ${formatUsd(quote.costUsd)} from your MythScribe Cloud balance on ${model}.`
      : `With MythScribe: MythScribe Cloud does not offer ${model}, so the pass cannot run on it.`
  }
  return estimate.priced
    ? `With MythScribe: about ${formatUsd(estimate.costUsd)} on ${model} (about ${formatCount(estimate.tokensIn)} tokens in, ${formatCount(estimate.tokensOut)} out at most).`
    : `With MythScribe: ${model} has no published price here, so the cost is not estimated (about ${formatCount(estimate.tokensIn)} tokens in).`
}

/** What the hosted confirm says before a pass above the threshold starts. */
export function confirmLine(quote: HostedQuote): string {
  return `This pass takes up to about ${formatUsd(quote.costUsd)} from your MythScribe Cloud balance. You pay only for what it uses.`
}
