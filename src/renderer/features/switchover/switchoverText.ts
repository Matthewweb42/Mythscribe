import type { RebuildEstimate } from '@shared/memory/switchover'
import { formatCount, formatUsd } from '@renderer/features/ai/usageFormat'

/** The rebuild's line: what *Rebuild memory* will cost after the switch, and how long. */
export function rebuildLine(rebuild: RebuildEstimate): string {
  if (rebuild.scenes === 0) return 'Rebuild memory: nothing to read yet.'
  const scenes = formatCount(rebuild.scenes, 'scene')
  const time = `about ${formatCount(rebuild.minutes, 'minute')}`
  if (rebuild.source === 'local')
    return `Rebuild memory: ${scenes}, free on your local model, ${time}.`
  const cost = rebuild.priced
    ? `about ${formatUsd(rebuild.costUsd)}`
    : 'a cost not yet known (a model is not in the price table)'
  const where =
    rebuild.source === 'cloud' ? 'from your MythScribe Cloud balance' : 'on your own key'
  return `Rebuild memory: ${scenes}, ${cost} ${where}, ${time}. It asks before it starts.`
}
