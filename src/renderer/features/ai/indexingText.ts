import type { IndexQueueStatus } from '@shared/jobs'

/**
 * The indicator's words: v1's summary queue ("Indexing 3 of 12 scenes") or, in story memory v2,
 * the reader's ("Reading 3 of 12 scenes", "2 scenes could not be read", "Reading paused · why").
 */
export function indicatorText(status: IndexQueueStatus, as: 'indexing' | 'reading'): string {
  const { queued, running, failed, done, paused } = status
  const stalled = paused !== null || (failed > 0 && running === null && queued === 0)
  const total = done + queued + failed + (running === null ? 0 : 1)
  const at = done + (running === null ? 0 : 1)
  const scenes = `${failed} ${failed === 1 ? 'scene' : 'scenes'}`
  if (as === 'reading') {
    if (paused !== null) return `Reading paused · ${paused.message}`
    if (stalled) return `${scenes} could not be read`
    return `Reading ${at} of ${total} scenes`
  }
  if (paused !== null) return `Indexing paused · ${paused.message}`
  if (stalled) return `${scenes} could not be summarised`
  return `Indexing ${at} of ${total} scenes`
}
