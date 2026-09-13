import {
  AI_DATA_SHARING,
  AI_DIAL_LABEL,
  isFeatureAllowed,
  type AiSettings
} from '@shared/aiSettings'
import type { AiFeatureId } from '@shared/ai'
import { AiDisabledError } from './providers/types'

/**
 * The main-process gate every AI feature calls before it builds a prompt (F-14.4): the throw
 * form of `isFeatureAllowed`, so a handler reads the project's settings, asserts, and only then
 * touches any text. The message names the feature and what to change; the next step comes
 * with the code (`AI_NEXT_STEP.DISABLED`).
 */
export function assertFeatureAllowed(settings: AiSettings, feature: AiFeatureId): void {
  if (isFeatureAllowed(settings, feature)) return
  const { label, minDial } = AI_DATA_SHARING[feature]
  const reason =
    settings.dial < minDial
      ? `needs the AI dial at ${AI_DIAL_LABEL[minDial]} or higher (it is at ${AI_DIAL_LABEL[settings.dial]})`
      : 'is turned off for this project'
  throw new AiDisabledError(`${label} ${reason}.`)
}
