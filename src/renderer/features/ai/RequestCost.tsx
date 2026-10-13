import type { AiUsage } from '@shared/ai'
import type { CostPart } from '@shared/chat'
import { useHostedSource } from '@renderer/features/account/hostedPricing'
import { describeCostParts, describeRequest } from './usageFormat'

/**
 * The line under an AI answer (F-5.9, CLAUDE.md rule 10) as text: model, cost, tokens, cached.
 * On MythScribe Cloud the token counts are left out (AI-BILLING-SPEC C4: hosted users see dollars;
 * the counts stay in the usage history). The one place that decides, so every panel agrees. A turn
 * that took several requests (P3-D23: Ms Scribe's navigator, answer and quote check) shows their
 * sum, its title listing the parts.
 */
export function RequestCost({
  request,
  parts = null
}: {
  request: { model: string; costUsd: number; usage: AiUsage | null; cached: boolean }
  parts?: readonly CostPart[] | null
}): React.JSX.Element {
  const hosted = useHostedSource()
  const text = describeRequest(request, !hosted)
  if (parts === null || parts.length < 2) return <>{text}</>
  const title = describeCostParts(parts)
  return (
    <span data-testid="request-cost-parts" title={title}>
      {text}
    </span>
  )
}
