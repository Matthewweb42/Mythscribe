import type { AiFeatureId, Tier } from './ai'
import { AI_DATA_SHARING, needsSwitchText, isFeatureAllowed, type AiSettings } from './aiSettings'
import type { WhatNextDirection } from './whatNext'

/**
 * Quick actions (F-5.17): one-click buttons in the assistant, each a fixed request on an
 * existing path, acting on the open scene or the selection. The ids, labels, tiers, the fixed
 * questions, and the one rule for when a button is off live here so the panel and its tests
 * read the same table.
 */

export const QUICK_ACTION_IDS = ['whatNext', 'proofread', 'continuity', 'recap'] as const
export type QuickActionId = (typeof QUICK_ACTION_IDS)[number]

export interface QuickAction {
  label: string
  /** The feature whose dial level and toggle gate the button. */
  feature: AiFeatureId
  /** The tier the request runs on, shown on the button. */
  tier: Tier
  /** What the button does, for its title when it is on. */
  description: string
}

export const QUICK_ACTIONS: Record<QuickActionId, QuickAction> = {
  whatNext: {
    label: 'What should come next?',
    feature: 'whatNext',
    tier: 'fast',
    description: 'Three short directions for the scene, in the chat'
  },
  proofread: {
    label: 'Proofread',
    feature: 'proofread',
    tier: 'fast',
    description: 'Spelling, typos, grammar, and punctuation fixes to accept one by one'
  },
  continuity: {
    label: 'Check consistency',
    feature: 'continuity',
    tier: 'strong',
    description: 'Compare the scene with the story bible'
  },
  recap: {
    label: 'What happened here?',
    feature: 'query',
    tier: 'strong',
    description: 'A cited recap of the scene, in the chat'
  }
}

/** The recap's selection is quoted in the question up to this many characters. */
export const RECAP_QUOTE_MAX = 600
/** A selection shorter than this is ignored and the whole scene is recapped. */
export const RECAP_SELECTION_MIN = 20

export const RECAP_SCENE_QUESTION =
  'What happens in this scene? Give a short recap, citing the passages.'

/** The fixed What happened here? question, about the selection when there is one worth quoting. */
export function recapQuestion(selection: string | null): string {
  const text = selection?.replace(/\s+/g, ' ').trim() ?? ''
  if (text.length < RECAP_SELECTION_MIN) return RECAP_SCENE_QUESTION
  const quote =
    text.length > RECAP_QUOTE_MAX ? `${text.slice(0, RECAP_QUOTE_MAX - 1).trimEnd()}…` : text
  return `What happens in this passage? Give a short recap, citing it: "${quote}"`
}

/** The user turn of a What should come next? run. */
export const WHAT_NEXT_QUESTION = 'What should come next?'

/** The Author-mode instruction a direction's Write this sends (F-5.17: one click to ghost text). */
export function directionMessage(direction: WhatNextDirection): string {
  return `Continue the scene in this direction: ${direction.title}. ${direction.text}`
}

export interface QuickActionState {
  /** The project's AI settings; null before they load. */
  settings: AiSettings | null
  /** An editor holds a manuscript scene. */
  scene: boolean
  /** The open scene's text length, in characters. */
  length: number
  /** The minimum text the action needs, in characters. */
  minLength: number
  /** Something else keeps the action from starting (a run in progress, focus mode), or null. */
  busy: string | null
}

/**
 * Why a quick action is off, or null when it can run: the dial first, then the toggle, then
 * the scene, then the text length, then whatever keeps it busy. The wording matches the
 * buttons it replaced (F-13.4's Check this scene).
 */
export function quickActionReason(id: QuickActionId, state: QuickActionState): string | null {
  return featureActionReason(QUICK_ACTIONS[id].feature, state)
}

/**
 * The same rule for any one-click AI action on the open scene (the assistant's actions menu,
 * 2026-10-06): why `feature` cannot run now, or null when it can.
 */
export function featureActionReason(feature: AiFeatureId, state: QuickActionState): string | null {
  const { minDial, label } = AI_DATA_SHARING[feature]
  const { settings } = state
  if (settings === null || settings.dial < minDial) {
    return `${needsSwitchText(label)} (Settings, AI tab)`
  }
  if (!isFeatureAllowed(settings, feature)) {
    return `${label} is turned off for this project (Settings, AI tab)`
  }
  if (!state.scene) return 'Open a manuscript scene first'
  if (state.length < state.minLength) {
    return `Write ${state.minLength.toLocaleString()} characters first`
  }
  return state.busy
}
