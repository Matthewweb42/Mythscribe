import type { CardField } from './claims'

/**
 * Whether a scene is a flashback (F-16.11, F-16.23; the author's decision 2026-10-14): the one
 * resolver every reader of a scene's flashback goes through (the story years and ages, the
 * Timeline, the contradiction rules and the judge, *Check the book*'s hidden list, Ms Scribe's
 * computed years, the scene details). The author's Flashback switch wins over the book's reading
 * in both directions: set, it is the answer; unset (null), the card's flashback counts only when
 * the checker confirmed it (the caller passes the field as it stands on the text, or null); else
 * the scene is not a flashback. A disagreement is never asked about: the author's setting wins.
 * Pure; nothing here reaches a prompt.
 */

/** A card's flashback field as the resolver reads it: its value (`yes` or `no`) and its check. */
export type CardFlashbackField = Pick<CardField, 'value' | 'verified'>

/** Where a scene's flashback comes from: the author's switch, the card's checked reading, or neither. */
export type FlashbackSource = 'typed' | 'card' | 'none'

export interface SceneFlashback {
  flashback: boolean
  source: FlashbackSource
}

/**
 * The book's reading of a scene: true or false when the checker confirmed the card's flashback
 * field, null when there is none or it was not confirmed (an unchecked reading counts for nothing).
 */
export function cardFlashback(field: CardFlashbackField | null | undefined): boolean | null {
  if (field?.verified !== true) return null
  return field.value === 'yes'
}

/**
 * A scene's flashback: the author's switch (`typed`) when set, else the card's checked reading
 * (`card`: the field standing on the text), else not a flashback.
 */
export function sceneFlashback(
  typed: boolean | null,
  card: CardFlashbackField | null | undefined
): SceneFlashback {
  if (typed !== null) return { flashback: typed, source: 'typed' }
  const read = cardFlashback(card)
  return read === null ? { flashback: false, source: 'none' } : { flashback: read, source: 'card' }
}

/** `sceneFlashback`'s answer alone. */
export const isFlashback = (
  typed: boolean | null,
  card: CardFlashbackField | null | undefined
): boolean => sceneFlashback(typed, card).flashback
