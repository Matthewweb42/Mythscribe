/**
 * A v2 scene card as the readers that used to read stored summaries read it (F-16.20, plan P2a
 * §5.1): `synopsis.v2` and `notesSuggest.v4` (the card in the summary's place), the chat agent's
 * tool outputs (`agent.v8`, data only), and the beta reader's map of earlier scenes. A card is the
 * AI's map of a scene (`MEMORY_MEANINGS` `map`): findable, never quotable, so every rendering says
 * so. Only what of the card still stands on the text is given (`heldCard` in main): a field whose
 * sentence was edited since is left out, never guessed. Pure.
 */

/** A scene's card as these readers take it. */
export interface PromptCard {
  /** The card's one line (at most 30 words). */
  line: string
  /** Its gist (60 to 80 words). */
  gist: string
  /** The place, the time and the POV record's name, where they stand on the text; else null. */
  where: string | null
  when: string | null
  pov: string | null
  mood: string
  theme: string
}

/** The heading `synopsis.v2` and `notesSuggest.v4` put over the card. */
export const CARD_PROMPT_HEADING = "Scene card (the AI's map of this scene, not quotable):"

/** What the agent's tools say a card is, wherever one is read out. */
export const CARD_MAP_NOTE = 'a map; read the scene to quote it'

/** `Where: …; When: …; POV: …` with whichever stand, '' for none. */
export function cardFacts(card: Pick<PromptCard, 'where' | 'when' | 'pov'>): string {
  return [
    card.where === null ? '' : `Where: ${card.where}`,
    card.when === null ? '' : `When: ${card.when}`,
    card.pov === null ? '' : `POV: ${card.pov}`
  ]
    .filter((part) => part !== '')
    .join('; ')
}

/** `Mood: …; Theme: …` with whichever is set, '' for neither. */
export function cardMood(card: Pick<PromptCard, 'mood' | 'theme'>): string {
  return [
    card.mood.trim() === '' ? '' : `Mood: ${card.mood.trim()}`,
    card.theme.trim() === '' ? '' : `Theme: ${card.theme.trim()}`
  ]
    .filter((part) => part !== '')
    .join('; ')
}

/**
 * The card as `synopsis.v2` and `notesSuggest.v4` send it: the heading, `Line:`, `Gist:` and the
 * standing facts, each line only when it says something.
 */
export function renderPromptCard(card: PromptCard): string {
  const facts = cardFacts(card)
  return [
    CARD_PROMPT_HEADING,
    `Line: ${card.line.trim()}`,
    card.gist.trim() === '' ? '' : `Gist: ${card.gist.trim()}`,
    facts
  ]
    .filter((line) => line !== '')
    .join('\n')
}

/**
 * A card as the agent's `cards` and `lookup` tools give it (v2): the scene's head, then
 * `Map (a map; read the scene to quote it): <line>`, the standing facts and the mood.
 */
export function renderToolCard(head: string, card: PromptCard): string {
  return [head, `Map (${CARD_MAP_NOTE}): ${card.line.trim()}`, cardFacts(card), cardMood(card)]
    .filter((line) => line !== '')
    .join('\n')
}

/** The open document's card as the agent's focus block carries it in its summary's place. */
export function cardMapText(card: Pick<PromptCard, 'line' | 'gist'>): string {
  const gist = card.gist.trim()
  return `${card.line.trim()}${gist === '' ? '' : ` ${gist}`} (${CARD_MAP_NOTE})`
}
