import type { SceneStatus } from '@shared/sceneMeta'

/**
 * The background class of each writing status (F-11.1), spelled out so Tailwind sees every one.
 * `none` draws no colour: a transparent dot keeps rows aligned.
 */
export const STATUS_BG: Record<SceneStatus, string> = {
  none: 'bg-transparent',
  idea: 'bg-status-idea',
  draft: 'bg-status-draft',
  revised: 'bg-status-revised',
  final: 'bg-status-final'
}
