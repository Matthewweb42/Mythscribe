import { z } from 'zod'
import { STRUCTURE_BEAT_ID_MAX, StructureTemplateId } from './structure'

/**
 * Plan links (F-11.1d): the author's planned outline items tied to the written scene that
 * fulfils them, so the outline and the AI know which plans are done. A plan is either a planned
 * scene (a manuscript document with no text yet) or a structure beat (F-11.1b) of the project's
 * template that no document sits on. The plan-link job (`src/main/ai/planLinks.ts`, fast tier,
 * in the background) proposes links: at chat mode Auto they apply at once, otherwise they wait
 * here as suggestions for the author to confirm or dismiss. A confirmed link to a planned scene
 * is `SceneMeta.fulfilledBy` on that scene; to a beat, the scene's own `SceneMeta.beats` entry.
 * Plot threads (F-11.1c) are tags, which F-4.13's auto-applied tags already link to scenes.
 */

/** The settings key the suggestions and the dismissed links live under (no migration). */
export const PLAN_LINKS_KEY = 'planLinks'
/** At most this many plans and written scenes go in one request (token rule 2). */
export const PLAN_LINKS_PLANS_MAX = 30
export const PLAN_LINKS_SCENES_MAX = 40
/** A plan's synopsis and a scene's summary as sent, in characters. */
export const PLAN_LINKS_TEXT_MAX = 240
/** The model's reason for a link, as stored and shown. */
export const PLAN_LINKS_REASON_MAX = 160
/** Suggestions kept at once, and dismissed links remembered. */
export const PLAN_LINKS_SUGGESTIONS_MAX = 60
export const PLAN_LINKS_DISMISSED_MAX = 500
/** The background job waits this long after the last summary before it asks. */
export const PLAN_LINKS_DEBOUNCE_MS = 20_000

const NodeId = z.string().min(1).max(64)

export const PlanRef = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('scene'), nodeId: NodeId }),
  z.object({
    kind: z.literal('beat'),
    template: StructureTemplateId,
    beatId: z.string().min(1).max(STRUCTURE_BEAT_ID_MAX)
  })
])
export type PlanRef = z.infer<typeof PlanRef>

/** One proposed link: the plan, the written scene that fulfils it, and why. */
export const PlanLinkSuggestion = z.object({
  plan: PlanRef,
  sceneId: NodeId,
  reason: z.string().max(PLAN_LINKS_REASON_MAX)
})
export type PlanLinkSuggestion = z.infer<typeof PlanLinkSuggestion>

export const PlanLinkState = z.object({
  suggestions: z.array(PlanLinkSuggestion).max(PLAN_LINKS_SUGGESTIONS_MAX),
  /** `planLinkKey`s the author dismissed or unlinked: never proposed again. */
  dismissed: z.array(z.string()).max(PLAN_LINKS_DISMISSED_MAX),
  /** `planLinkKey`s the job applied itself at chat mode Auto: the outline marks them as AI-made. */
  aiApplied: z
    .array(z.string())
    .max(PLAN_LINKS_DISMISSED_MAX)
    .default(() => [])
})
export type PlanLinkState = z.infer<typeof PlanLinkState>

export function emptyPlanLinkState(): PlanLinkState {
  return { suggestions: [], dismissed: [], aiApplied: [] }
}

/** A plan's identity: `scene:<id>` or `beat:<template>:<beat>`. */
export function planKey(plan: PlanRef): string {
  return plan.kind === 'scene' ? `scene:${plan.nodeId}` : `beat:${plan.template}:${plan.beatId}`
}

/** A link's identity: the plan and the scene. */
export function planLinkKey(link: { plan: PlanRef; sceneId: string }): string {
  return `${planKey(link.plan)}>${link.sceneId}`
}

/** `key` added to the dismissed list, the oldest forgotten past the cap. */
export function withDismissed(dismissed: readonly string[], key: string): string[] {
  const next = [...dismissed.filter((each) => each !== key), key]
  return next.slice(Math.max(0, next.length - PLAN_LINKS_DISMISSED_MAX))
}

/** `key` in or out of a capped key list (the dismissed or the AI-applied links). */
export function withKey(keys: readonly string[], key: string, present: boolean): string[] {
  return present ? withDismissed(keys, key) : keys.filter((each) => each !== key)
}

/** What the outline reads (`planLinks:get`): the open suggestions, and the links the AI applied itself. */
export const PlanLinkView = z.object({
  suggestions: z.array(PlanLinkSuggestion),
  /** `planLinkKey`s of the links applied at chat mode Auto, which the outline marks as AI-made. */
  aiApplied: z.array(z.string())
})
export type PlanLinkView = z.infer<typeof PlanLinkView>

/** What one run of the plan-link job did (`planLinks:run`). */
export const PlanLinksRunResult = z.object({
  /** New suggestions waiting for the author (Ask and Plan). */
  suggested: z.number().int().nonnegative(),
  /** Links applied at once (Auto). */
  applied: z.number().int().nonnegative(),
  /** Nodes whose scene metadata the run rewrote; the renderer reloads them. */
  changedNodeIds: z.array(z.string()),
  /** Whether a request went out: false when there was no open plan or no written scene. */
  requested: z.boolean(),
  costUsd: z.number().nonnegative()
})
export type PlanLinksRunResult = z.infer<typeof PlanLinksRunResult>
