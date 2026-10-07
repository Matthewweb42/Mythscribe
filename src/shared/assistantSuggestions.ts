import type { AiFeatureId } from './ai'
import { BETA_READER_TEXT_MIN } from './betaReader'
import type { ConversationMode } from './chat'
import { CONTINUITY_TEXT_MIN } from './continuity'
import { CRITIQUE_TEXT_MIN } from './critique'
import { PROOFREAD_TEXT_MIN } from './proofread'
import { SCENE_SUGGEST_TEXT_MIN } from './sceneSuggest'
import { WHAT_NEXT_TEXT_MIN } from './whatNext'

/**
 * The rotating suggestions above the assistant's message box (2026-10-06, the author's AI panel
 * polish; they replace the panel's Actions menu): short prompts the author can click to fill the
 * box. Local and free: picked from this list by what the project and the open scene offer, never
 * by an AI call. In Auto mode the router sends a filled prompt to its feature like any message.
 */

/** The longest suggestion shown; one with a long character name in it is skipped instead. */
export const SUGGESTION_MAX_CHARS = 50
/** How long each suggestion stays before the next fades in. */
export const SUGGESTION_ROTATE_MS = 6_000

/** What the picker knows about the panel and the open scene. */
export interface SuggestionContext {
  /** The active conversation's mode. */
  mode: ConversationMode
  /** The AI features the dial and the project's toggles allow. */
  allowed: ReadonlySet<AiFeatureId>
  /** The open manuscript scene's text length, or null without one. */
  sceneLength: number | null
  /** The editor holds a non-empty selection. */
  selection: boolean
  /** The open scene's synopsis is known to be empty. */
  synopsisEmpty: boolean
  /** The open scene's notes are known to be empty. */
  notesEmpty: boolean
  /** The story bible's character names. */
  characters: readonly string[]
}

type Need = 'selection' | 'synopsisEmpty' | 'notesEmpty' | 'character' | 'noCharacter'

interface Entry {
  /** The text; `{name}` takes a character's name. */
  text: string
  /** The feature that answers it, whose dial level and toggle gate it. */
  feature: AiFeatureId
  modes: readonly ConversationMode[]
  /** The scene text it needs, in characters; null when it needs no open scene. */
  minLength: number | null
  need?: Need
}

const AUTO: readonly ConversationMode[] = ['auto']
const ASK: readonly ConversationMode[] = ['auto', 'query']
const TALK: readonly ConversationMode[] = ['auto', 'plan']
const AUTHOR: readonly ConversationMode[] = ['agent']

/** Features only Auto reaches, through the router (`route`). */
const ROUTED: ReadonlySet<AiFeatureId> = new Set<AiFeatureId>([
  'whatNext',
  'proofread',
  'critique',
  'betaReader',
  'continuity',
  'synopsis',
  'notesSuggest',
  'rewrite'
])

const ENTRIES: readonly Entry[] = [
  {
    text: 'What happens next here?',
    feature: 'whatNext',
    modes: AUTO,
    minLength: WHAT_NEXT_TEXT_MIN
  },
  {
    text: 'Rewrite the selection tighter',
    feature: 'rewrite',
    modes: AUTO,
    minLength: 0,
    need: 'selection'
  },
  {
    text: 'What does {name} look like?',
    feature: 'query',
    modes: ASK,
    minLength: null,
    need: 'character'
  },
  {
    text: 'Proofread this scene',
    feature: 'proofread',
    modes: AUTO,
    minLength: PROOFREAD_TEXT_MIN
  },
  {
    text: 'Who are the main characters so far?',
    feature: 'query',
    modes: ASK,
    minLength: null,
    need: 'noCharacter'
  },
  {
    text: "Give me editor's notes on this scene",
    feature: 'critique',
    modes: AUTO,
    minLength: CRITIQUE_TEXT_MIN
  },
  {
    text: 'Suggest a synopsis for this scene',
    feature: 'synopsis',
    modes: AUTO,
    minLength: SCENE_SUGGEST_TEXT_MIN,
    need: 'synopsisEmpty'
  },
  {
    text: 'Where did {name} last appear?',
    feature: 'query',
    modes: ASK,
    minLength: null,
    need: 'character'
  },
  {
    text: 'How would a beta reader react?',
    feature: 'betaReader',
    modes: AUTO,
    minLength: BETA_READER_TEXT_MIN
  },
  { text: 'What happened in this scene?', feature: 'query', modes: ASK, minLength: 1 },
  {
    text: 'Check this scene for continuity slips',
    feature: 'continuity',
    modes: AUTO,
    minLength: CONTINUITY_TEXT_MIN
  },
  {
    text: 'Suggest notes for this scene',
    feature: 'notesSuggest',
    modes: AUTO,
    minLength: SCENE_SUGGEST_TEXT_MIN,
    need: 'notesEmpty'
  },
  { text: 'What could raise the stakes here?', feature: 'chat', modes: TALK, minLength: 1 },
  { text: 'What is still unresolved in the story?', feature: 'query', modes: ASK, minLength: null },
  { text: 'Talk me through where the story goes', feature: 'chat', modes: TALK, minLength: null },
  { text: 'Continue the scene', feature: 'chat', modes: AUTHOR, minLength: 1 },
  { text: 'Write the next beat', feature: 'chat', modes: AUTHOR, minLength: 1 },
  {
    text: 'Write a line of dialogue for {name}',
    feature: 'chat',
    modes: AUTHOR,
    minLength: 1,
    need: 'character'
  }
]

function needMet(need: Need | undefined, context: SuggestionContext): boolean {
  switch (need) {
    case undefined:
      return true
    case 'selection':
      return context.selection
    case 'synopsisEmpty':
      return context.synopsisEmpty
    case 'notesEmpty':
      return context.notesEmpty
    case 'character':
      return context.characters.length > 0
    case 'noCharacter':
      return context.characters.length === 0
  }
}

/**
 * The suggestions that fit `context`, in display order. `seed` picks the character a `{name}`
 * suggestion names (the panel passes its rotation count, so the name changes as it rotates); a
 * suggestion the name pushes past `SUGGESTION_MAX_CHARS` is left out. Nothing without the
 * assistant chat allowed; an Auto suggestion answered by another feature also needs the router.
 */
export function assistantSuggestions(context: SuggestionContext, seed: number): string[] {
  const { allowed, mode, sceneLength, characters } = context
  if (!allowed.has('chat')) return []
  const name =
    characters.length === 0
      ? null
      : (characters[Math.abs(Math.trunc(seed)) % characters.length] ?? null)
  const out: string[] = []
  for (const entry of ENTRIES) {
    if (!entry.modes.includes(mode)) continue
    if (!allowed.has(entry.feature)) continue
    if (ROUTED.has(entry.feature) && !allowed.has('route')) continue
    if (entry.minLength !== null && (sceneLength === null || sceneLength < entry.minLength)) {
      continue
    }
    if (!needMet(entry.need, context)) continue
    const text = name === null ? entry.text : entry.text.replace('{name}', name.trim())
    if (text.includes('{name}') || text.length > SUGGESTION_MAX_CHARS) continue
    out.push(text)
  }
  return out
}
