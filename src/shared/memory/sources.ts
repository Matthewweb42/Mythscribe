/**
 * The source taxonomy of story memory (F-16.3; design §2.2 "Meaning by place"): what a piece of
 * text means depends on where it is, never on what it says.
 * - The manuscript up to the open scene happened; later scenes are later in the book.
 * - Pinned sheet text, notes and Research are timeless canon, which never makes a plot event
 *   happen.
 * - Synopses, briefs, scene notes and planned cards are plans.
 * - Ideas, Try, chats, inactive drafts, Idea-status scenes, scenes left out of compile, and Not
 *   canon pages and paragraphs are never real and never read.
 *
 * - A card (F-16.18) is the AI's map of a scene: findable, never citable, never canon (`map`).
 *
 * Only manuscript scenes are read for claims (`readerMayRead`): the evidence reader (F-16.17)
 * refuses everything else, and `checkMemoryInvariants` reports a claim from anywhere else.
 */
export const MEMORY_SOURCES = [
  'scene',
  'pinned',
  'note',
  'research',
  'synopsis',
  'brief',
  'sceneNote',
  'plannedCard',
  'idea',
  'try',
  'chat',
  'inactiveDraft',
  'ideaScene',
  'excludedScene',
  'notCanon',
  'card'
] as const
export type MemorySource = (typeof MEMORY_SOURCES)[number]

export const MEMORY_MEANINGS = ['happened', 'later', 'canon', 'plan', 'never', 'map'] as const
export type MemoryMeaning = (typeof MEMORY_MEANINGS)[number]

const MEANING: Record<
  Exclude<MemorySource, 'scene'>,
  Exclude<MemoryMeaning, 'happened' | 'later'>
> = {
  pinned: 'canon',
  note: 'canon',
  research: 'canon',
  synopsis: 'plan',
  brief: 'plan',
  sceneNote: 'plan',
  plannedCard: 'plan',
  idea: 'never',
  try: 'never',
  chat: 'never',
  inactiveDraft: 'never',
  ideaScene: 'never',
  excludedScene: 'never',
  notCanon: 'never',
  card: 'map'
}

/**
 * What text from `source` means, seen from the open scene: a manuscript scene at or before the
 * open one (`order` ≤ `openOrder`, both in reading order) happened, a later one is later in the
 * book; every other source means the same wherever the author is.
 */
export function meaningOf(
  source: MemorySource,
  position: { order: number; openOrder: number }
): MemoryMeaning {
  if (source === 'scene') return position.order <= position.openOrder ? 'happened' : 'later'
  return MEANING[source]
}

/** Whether the evidence reader may read text from `source`: manuscript scenes only. */
export function readerMayRead(source: MemorySource): boolean {
  return source === 'scene'
}
