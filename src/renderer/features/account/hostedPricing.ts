import type { PricingResult } from '@shared/cloudApi'
import { bundledPricing } from '@shared/hostedPricing'
import { useAiSettingsStore } from '@renderer/features/ai/aiSettingsStore'
import { useAccountStore } from './accountStore'

/**
 * The hosted price table as the renderer reads it (AI-BILLING-SPEC P5): what main last fetched
 * from `GET /pricing`, or the Worker's own defaults until then. One stable fallback object, so a
 * selector returning it never re-renders a component by itself.
 */
const BUNDLED: PricingResult = bundledPricing()

export function useHostedPricing(): PricingResult {
  return useAccountStore((s) => s.pricing) ?? BUNDLED
}

/** The same, outside React (a store action pricing a quote). */
export function hostedPricingNow(): PricingResult {
  return useAccountStore.getState().pricing ?? BUNDLED
}

/**
 * Whether this project's AI requests go through MythScribe Cloud: hosted users see dollars and
 * words, not tokens (AI-BILLING-SPEC C4), and hosted jobs are quoted at the server's price.
 */
export function useHostedSource(): boolean {
  return useAiSettingsStore((s) => s.settings?.source === 'cloud')
}
