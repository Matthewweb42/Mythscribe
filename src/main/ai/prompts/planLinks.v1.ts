import { outputBudget } from '@shared/ai'
import type { AiMessage } from '../providers/types'

/**
 * The plan-link prompt (F-11.1d), version 1: the author's open plans (planned scenes with their
 * synopses, empty structure beats with their hints) against the written scenes' stored summaries
 * (F-5.6); the model names the clear matches by label. Prompt files are versioned (F-5.12): a
 * change to the text, the caps, or the message order is a new file with its own golden test.
 *
 * Order (CLAUDE.md, token efficiency rule 3): the rules alone in the system turn (identical for
 * every request); the plans and the scenes, which change, in the user turn.
 */
export const PLAN_LINKS_PROMPT_VERSION = 'planLinks.v1'

/** The rules; the opening sentence is the one the e2e's fake provider keys on. */
export const PLAN_LINKS_RULES =
  'You are the plan-link feature inside a novel-writing app. The author planned scenes and ' +
  'story beats before writing them. Match a plan to the one written scene that clearly carries ' +
  'it out, judged by the scene summary; leave a plan unmatched when unsure. A plan gets at most ' +
  'one scene and a scene fulfils at most one beat. Reply with JSON only: ' +
  '{"links":[{"plan":"P1","scene":"S3","why":"one short sentence"}]}; with no clear match, ' +
  '{"links":[]}.'

/** One plan as sent: its label (`P1`), what it is, its title, and its synopsis or the beat's hint. */
export interface PlanLinkPlanLine {
  label: string
  kind: 'scene' | 'beat'
  title: string
  text: string
}

/** One written scene as sent: its label (`S1`), its title, and its stored summary. */
export interface PlanLinkSceneLine {
  label: string
  title: string
  summary: string
}

export interface BuildPlanLinksPromptInput {
  plans: readonly PlanLinkPlanLine[]
  scenes: readonly PlanLinkSceneLine[]
}

export interface BuiltPlanLinksPrompt {
  version: typeof PLAN_LINKS_PROMPT_VERSION
  messages: AiMessage[]
  maxTokens: number
}

export function planLine(plan: PlanLinkPlanLine): string {
  const what = plan.kind === 'scene' ? 'Planned scene' : 'Beat'
  return `${plan.label} ${what} "${plan.title}"${plan.text ? `: ${plan.text}` : ''}`
}

export function sceneLine(scene: PlanLinkSceneLine): string {
  return `${scene.label} "${scene.title}": ${scene.summary}`
}

export function buildPlanLinksPrompt(input: BuildPlanLinksPromptInput): BuiltPlanLinksPrompt {
  const user = [
    `Plans:\n${input.plans.map(planLine).join('\n')}`,
    `Written scenes:\n${input.scenes.map(sceneLine).join('\n')}`,
    'Link the plans.'
  ]
  return {
    version: PLAN_LINKS_PROMPT_VERSION,
    messages: [
      { role: 'system', content: PLAN_LINKS_RULES },
      { role: 'user', content: user.join('\n\n') }
    ],
    maxTokens: outputBudget('planLinks')
  }
}
