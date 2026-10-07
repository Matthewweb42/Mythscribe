import type { AiUsage } from '@shared/ai'
import { useHostedSource } from '@renderer/features/account/hostedPricing'
import { describeRequest } from './usageFormat'

/**
 * The line under an AI answer (F-5.9, CLAUDE.md rule 10) as text: model, cost, tokens, cached.
 * On MythScribe Cloud the token counts are left out (AI-BILLING-SPEC C4: hosted users see dollars;
 * the counts stay in the usage history). The one place that decides, so every panel agrees.
 */
export function RequestCost({
  request
}: {
  request: { model: string; costUsd: number; usage: AiUsage | null; cached: boolean }
}): React.JSX.Element {
  const hosted = useHostedSource()
  return <>{describeRequest(request, !hosted)}</>
}
