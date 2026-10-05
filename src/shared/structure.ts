import { z } from 'zod'

/** Settings-table key under which the project's structure template choice (F-11.1b) is stored as JSON. */
export const STRUCTURE_KEY = 'structure'

/** The act/beat templates a project can lay its scenes against (F-11.1b). */
export const STRUCTURE_TEMPLATE_IDS = ['threeAct', 'saveTheCat', 'herosJourney'] as const
export const StructureTemplateId = z.enum(STRUCTURE_TEMPLATE_IDS)
export type StructureTemplateId = z.infer<typeof StructureTemplateId>

/** The longest beat id a scene may store; every template id is far shorter. */
export const STRUCTURE_BEAT_ID_MAX = 64

/** One beat of a template: a kebab-case id unique within the template, its name, and a one-line hint. */
export interface StructureBeat {
  id: string
  name: string
  hint: string
}

/** One act (or stage) of a template, its beats in story order. */
export interface StructureAct {
  name: string
  beats: readonly StructureBeat[]
}

export interface StructureTemplate {
  name: string
  acts: readonly StructureAct[]
}

const beat = (id: string, name: string, hint: string): StructureBeat => ({ id, name, hint })

/** The built-in templates (F-11.1b), acts and beats in story order. */
export const STRUCTURE_TEMPLATES: Record<StructureTemplateId, StructureTemplate> = {
  threeAct: {
    name: 'Three-act structure',
    acts: [
      {
        name: 'Act 1',
        beats: [
          beat('setup', 'Setup', 'The hero, their world, and what they lack.'),
          beat('inciting-incident', 'Inciting incident', 'The event that upsets the status quo.'),
          beat('plot-point-1', 'Plot point 1', 'The hero commits and the story turns.')
        ]
      },
      {
        name: 'Act 2',
        beats: [
          beat('rising-action', 'Rising action', 'Obstacles mount and the stakes rise.'),
          beat('midpoint', 'Midpoint', 'A reversal or revelation changes the goal.'),
          beat('plot-point-2', 'Plot point 2', 'The lowest point sends the story into its end.')
        ]
      },
      {
        name: 'Act 3',
        beats: [
          beat('climax', 'Climax', 'The final confrontation decides the story.'),
          beat('resolution', 'Resolution', 'The new normal after the climax.')
        ]
      }
    ]
  },
  saveTheCat: {
    name: 'Save the Cat',
    acts: [
      {
        name: 'Act 1',
        beats: [
          beat('opening-image', 'Opening image', 'A snapshot of the hero before the change.'),
          beat('theme-stated', 'Theme stated', 'Someone hints at the lesson the hero must learn.'),
          beat('set-up', 'Set-up', "The hero's world, flaws, and what is at stake."),
          beat('catalyst', 'Catalyst', 'The event that sets the story in motion.'),
          beat('debate', 'Debate', 'The hero hesitates over what to do.')
        ]
      },
      {
        name: 'Act 2',
        beats: [
          beat('break-into-two', 'Break into two', 'The hero chooses to enter a new world.'),
          beat('b-story', 'B story', 'A new relationship that carries the theme.'),
          beat('fun-and-games', 'Fun and games', 'The promise of the premise, explored.'),
          beat('midpoint', 'Midpoint', 'A false victory or false defeat raises the stakes.'),
          beat(
            'bad-guys-close-in',
            'Bad guys close in',
            'Pressure builds from outside and within.'
          ),
          beat('all-is-lost', 'All is lost', "The hero's lowest point."),
          beat(
            'dark-night-of-the-soul',
            'Dark night of the soul',
            'The hero wallows, then finds the truth.'
          )
        ]
      },
      {
        name: 'Act 3',
        beats: [
          beat('break-into-three', 'Break into three', 'The hero finds the way forward.'),
          beat('finale', 'Finale', 'The hero applies the lesson and wins or loses.'),
          beat('final-image', 'Final image', 'A mirror of the opening image, showing the change.')
        ]
      }
    ]
  },
  herosJourney: {
    name: "Hero's Journey",
    acts: [
      {
        name: 'Departure',
        beats: [
          beat('ordinary-world', 'Ordinary world', 'The hero at home, before the adventure.'),
          beat('call-to-adventure', 'Call to adventure', 'A challenge or quest appears.'),
          beat('refusal-of-the-call', 'Refusal of the call', 'The hero hesitates or declines.'),
          beat(
            'meeting-the-mentor',
            'Meeting the mentor',
            'Someone gives advice, a gift, or courage.'
          ),
          beat(
            'crossing-the-threshold',
            'Crossing the threshold',
            'The hero leaves the known world.'
          )
        ]
      },
      {
        name: 'Initiation',
        beats: [
          beat(
            'tests-allies-enemies',
            'Tests, allies, enemies',
            "The hero learns the new world's rules."
          ),
          beat(
            'approach-to-the-inmost-cave',
            'Approach to the inmost cave',
            'Preparing for the central ordeal.'
          ),
          beat('the-ordeal', 'The ordeal', 'The hero faces their greatest fear.'),
          beat('reward', 'Reward', 'The hero seizes what they came for.')
        ]
      },
      {
        name: 'Return',
        beats: [
          beat('the-road-back', 'The road back', 'The hero turns for home, pursued.'),
          beat('resurrection', 'Resurrection', 'A final test proves the hero has changed.'),
          beat(
            'return-with-the-elixir',
            'Return with the elixir',
            'The hero comes home with something to share.'
          )
        ]
      }
    ]
  }
}

/**
 * The project's structure choice (F-11.1b): at most one template, or none. The beat each scene
 * sits on is stored per template in its `SceneMeta.beats`, so switching templates loses nothing.
 */
export const ProjectStructure = z.object({
  template: StructureTemplateId.nullable()
})
export type ProjectStructure = z.infer<typeof ProjectStructure>

export function defaultProjectStructure(): ProjectStructure {
  return { template: null }
}

/** Every beat of a template in story order, the acts flattened. */
export function templateBeats(id: StructureTemplateId): StructureBeat[] {
  return STRUCTURE_TEMPLATES[id].acts.flatMap((act) => act.beats)
}

/** True when `beatId` names a beat of the template. */
export function isTemplateBeat(id: StructureTemplateId, beatId: string): boolean {
  return templateBeats(id).some((b) => b.id === beatId)
}

export interface BeatGroup {
  beat: StructureBeat
  /** The nodes on this beat, in the order the rows came in (reading order). */
  nodeIds: string[]
}

export interface BeatBoard {
  acts: { name: string; beats: BeatGroup[] }[]
  /** How many beats have at least one node. */
  filled: number
  /** How many beats the template has. */
  total: number
}

/**
 * Lays nodes against a template's beats (F-11.1b): each row is a node and the beat it carries in
 * this template (or none). Rows come in reading order and keep it under each beat; a beat id the
 * template does not have reads as unassigned.
 */
export function groupByBeat(
  templateId: StructureTemplateId,
  rows: readonly { id: string; beat: string | undefined }[]
): BeatBoard {
  const byBeat = new Map<string, string[]>()
  for (const row of rows) {
    if (row.beat === undefined) continue
    const list = byBeat.get(row.beat)
    if (list) list.push(row.id)
    else byBeat.set(row.beat, [row.id])
  }
  let filled = 0
  let total = 0
  const acts = STRUCTURE_TEMPLATES[templateId].acts.map((act) => ({
    name: act.name,
    beats: act.beats.map((b) => {
      const nodeIds = byBeat.get(b.id) ?? []
      total++
      if (nodeIds.length > 0) filled++
      return { beat: b, nodeIds }
    })
  }))
  return { acts, filled, total }
}
