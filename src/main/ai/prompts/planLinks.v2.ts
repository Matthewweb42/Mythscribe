import type { AiMessage } from '../providers/types'

/**
 * The plan-link prompt (F-16.21, story memory v2 only; decision 2, plan P2a §5.2), version 2:
 * code links a planned scene to the drafted scene that fulfils it when the match is clear
 * (`@shared/memory/planMatch`); this asks the fast model only for an ambiguous best two, and only
 * when a reading moved one of their card lines (at most one call per reading, cached). The answer
 * picks `S1`, `S2` or `none`. Reasoning off (`NO_REASONING_PROMPTS`). Prompt files are versioned
 * (F-5.12): a change to the text, the caps, or the message order is a new file.
 *
 * Order (CLAUDE.md, token efficiency rule 3): the rules alone in the system turn; the plan and the
 * two scenes in the user turn.
 */
export const PLAN_LINKS_PROMPT_V2_VERSION = 'planLinks.v2'

/** The answer's cap: a pick and one short sentence. */
export const PLAN_LINKS_V2_MAX_TOKENS = 100

/** The rules; the opening sentence is the e2e's sentinel for this version. */
export const PLAN_LINKS_V2_RULES =
  'You are the plan-link feature inside a novel-writing app, choosing which drafted scene ' +
  'fulfils one planned scene. The author planned the scene below before writing it, and two ' +
  "drafted scenes both look like it; each is given by its title and its card (the app's short " +
  'map of the scene). Pick the one that carries out the plan, or "none" when neither clearly ' +
  'does. Reply with JSON only: {"pick":"S1","why":"one short sentence"}, where "pick" is "S1", ' +
  '"S2" or "none".'

/** The opening sentence the e2e's fake provider keys on. */
export const PLAN_LINKS_V2_SENTINEL =
  'You are the plan-link feature inside a novel-writing app, choosing which drafted scene ' +
  'fulfils one planned scene.'

/** One drafted scene as sent: its title and its card's line and gist. */
export interface PlanLinkSceneV2 {
  title: string
  line: string
  gist: string
}

export interface BuildPlanLinksPromptV2Input {
  plan: { title: string; synopsis: string }
  scenes: readonly [PlanLinkSceneV2, PlanLinkSceneV2]
}

export interface BuiltPlanLinksPromptV2 {
  version: typeof PLAN_LINKS_PROMPT_V2_VERSION
  messages: AiMessage[]
  maxTokens: number
}

function sceneLine(label: string, scene: PlanLinkSceneV2): string {
  const gist = scene.gist.trim()
  return `${label} "${scene.title}": ${scene.line.trim()}${gist === '' ? '' : ` Gist: ${gist}`}`
}

export function buildPlanLinksPromptV2(input: BuildPlanLinksPromptV2Input): BuiltPlanLinksPromptV2 {
  const synopsis = input.plan.synopsis.trim()
  const user = [
    `Planned scene "${input.plan.title}"${synopsis === '' ? '' : `: ${synopsis}`}`,
    `Drafted scenes:\n${sceneLine('S1', input.scenes[0])}\n${sceneLine('S2', input.scenes[1])}`,
    'Pick the scene that fulfils the plan.'
  ]
  return {
    version: PLAN_LINKS_PROMPT_V2_VERSION,
    messages: [
      { role: 'system', content: PLAN_LINKS_V2_RULES },
      { role: 'user', content: user.join('\n\n') }
    ],
    maxTokens: PLAN_LINKS_V2_MAX_TOKENS
  }
}
