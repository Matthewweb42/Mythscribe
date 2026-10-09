import { z } from 'zod'
import { ThreadEvent, THREAD_EVENT_LABEL } from './threads'

/**
 * Scene cards (F-9.14): a short, fixed-shape card per manuscript scene — who is in it, where and
 * when it happens, whose point of view, what changed, and which threads it opened, moved, or
 * closed. The AI part (`AiSceneCard`) rides the scene summary (`summary.v4`, stored in
 * `scene_summary.card`); the rest is put together at read time in main (`sceneCardFor`): the
 * author's own scene metadata wins over what the AI read, the cast comes from the local mention
 * index, and the threads from the scene's thread events. `renderCard` is the compact line the
 * chat agent will read (F-5.24), about 100 tokens at most.
 */

/** Longest where / when / POV value the card keeps. */
export const SCENE_CARD_FIELD_MAX = 80
/** Longest "what changed" line (the prompt asks for at most this). */
export const SCENE_CARD_CHANGED_MAX = 160
/** Most cast names a card lists. */
export const SCENE_CARD_CAST_MAX = 8
/** Most threads a card lists. */
export const SCENE_CARD_THREADS_MAX = 4
/** The rendered card's cap, in characters (about 100 tokens). */
export const SCENE_CARD_RENDER_MAX = 400

/** What the summary request reads for the card: each field as the scene states it, '' for none. */
export const AiSceneCard = z.object({
  where: z.string().max(SCENE_CARD_FIELD_MAX),
  when: z.string().max(SCENE_CARD_FIELD_MAX),
  pov: z.string().max(SCENE_CARD_FIELD_MAX),
  changed: z.string().max(SCENE_CARD_CHANGED_MAX)
})
export type AiSceneCard = z.infer<typeof AiSceneCard>

/** One card value and who stated it: the author's scene metadata, or the AI's reading. */
export const SceneCardValue = z.object({
  value: z.string(),
  origin: z.enum(['author', 'ai'])
})
export type SceneCardValue = z.infer<typeof SceneCardValue>

export const SceneCardThread = z.object({
  entityId: z.string(),
  name: z.string(),
  event: ThreadEvent
})
export type SceneCardThread = z.infer<typeof SceneCardThread>

/** The card as the windows show it. */
export const SceneCard = z.object({
  where: SceneCardValue.nullable(),
  when: SceneCardValue.nullable(),
  pov: SceneCardValue.nullable(),
  /** What changed by the end of the scene, as the AI read it; '' for none. */
  changed: z.string(),
  /** Who is in the scene: the records the mention index finds, else the summary's cast. */
  cast: z.array(z.string()),
  threads: z.array(SceneCardThread)
})
export type SceneCard = z.infer<typeof SceneCard>

/** Whether a card has anything to show. */
export function isEmptyCard(card: SceneCard): boolean {
  return (
    card.where === null &&
    card.when === null &&
    card.pov === null &&
    card.changed === '' &&
    card.cast.length === 0 &&
    card.threads.length === 0
  )
}

/**
 * The card as one compact block of text for a prompt (F-5.24 reads it): the title, then
 * `Who: …; Where: …; When: …; POV: …`, `Changed: …`, and `Threads: name (opened), …`, each line
 * only when it has something, cut to `SCENE_CARD_RENDER_MAX` characters (about 100 tokens).
 */
export function renderCard(title: string, card: SceneCard): string {
  const facts = [
    card.cast.length > 0 ? `Who: ${card.cast.join(', ')}` : '',
    card.where !== null ? `Where: ${card.where.value}` : '',
    card.when !== null ? `When: ${card.when.value}` : '',
    card.pov !== null ? `POV: ${card.pov.value}` : ''
  ].filter((part) => part !== '')
  const lines = [
    title,
    facts.join('; '),
    card.changed !== '' ? `Changed: ${card.changed}` : '',
    card.threads.length > 0
      ? `Threads: ${card.threads
          .map((thread) => `${thread.name} (${THREAD_EVENT_LABEL[thread.event].toLowerCase()})`)
          .join(', ')}`
      : ''
  ].filter((line) => line !== '')
  const text = lines.join('\n')
  return text.length <= SCENE_CARD_RENDER_MAX
    ? text
    : `${text.slice(0, SCENE_CARD_RENDER_MAX - 1).trimEnd()}…`
}
