import type { KnowledgeConversion } from '@shared/knowledge'
import { formatUsd } from '@renderer/features/ai/usageFormat'

/** The estimate's cost line (CLAUDE.md rule 10: the cost is visible before anything is sent). */
export function costLine(conversion: KnowledgeConversion): string {
  if (conversion.source === 'local') return 'Free: it runs on your local model.'
  const model = conversion.model === '' ? 'the fast model' : conversion.model
  if (!conversion.priced) return `Cost unknown: ${model} is not in the price table.`
  const cost = `about ${formatUsd(conversion.costUsd)}`
  return conversion.source === 'cloud'
    ? `Estimated cost: ${cost} from your MythScribe Cloud balance (${model}).`
    : `Estimated cost: ${cost} on your own key (${model}).`
}
