import { z } from 'zod'
import { toTagName } from './tags'

/**
 * Aliases (F-4.14): one tag, many names. A tag (and the story-bible sheet linked to it, F-9.4)
 * has one main name — the full name — plus aliases: nicknames, titles, other spellings the
 * author keeps ("Rynna", "High Crown Falsire" for `rynna-falsire`). Any alias in the prose is a
 * mention of the tag (F-4.12), `#alias` typed inline resolves to it (F-4.6), and the AI tagging
 * and the context import map an alias to the tag rather than making a second one.
 *
 * One owner: a sheet linked to a tag reads and writes the tag's aliases; only a sheet with no
 * tag keeps its own. Aliases are stored as the author typed them (trimmed, inner whitespace
 * collapsed), compared by `aliasKey`, which is the tag-name normalization: "High  Crown" and
 * "high-crown" are the same alias.
 *
 * Not to be confused with the merge redirects of F-4.9 (`TagAliases` in `tagExchange.ts`, an id
 * → id map that keeps old inline tokens pointing at the tag they were merged into): a merge
 * writes both — the redirect for the token ids, and the merged tags' names as aliases here.
 */

/** Longest alias, measured after trimming. */
export const ALIAS_MAX = 60
/** Most aliases one tag or sheet keeps. */
export const ALIASES_MAX = 30

/** One alias as a channel accepts it. */
export const Alias = z.string().trim().min(1).max(ALIAS_MAX)
/** A full alias list as a patch carries it (it replaces the stored list). */
export const AliasList = z.array(Alias).max(ALIASES_MAX)

/** The key aliases and names are compared by: the kebab-cased tag name ('' for "???"). */
export function aliasKey(name: string): string {
  return toTagName(name)
}

/** The alias as stored: trimmed, inner whitespace collapsed, NFC. */
export function cleanAlias(name: string): string {
  return name.normalize('NFC').trim().replace(/\s+/gu, ' ')
}

/**
 * The list as it is stored: each alias cleaned and cut to `ALIAS_MAX`, those with no letter or
 * digit dropped, duplicates (by key) and the main name itself dropped, the first spelling kept,
 * at most `ALIASES_MAX`, in the given order.
 */
export function normalizeAliases(names: readonly string[], mainName: string): string[] {
  const seen = new Set([aliasKey(mainName)])
  const kept: string[] = []
  for (const raw of names) {
    const alias = cleanAlias(raw).slice(0, ALIAS_MAX).trim()
    const key = aliasKey(alias)
    if (key === '' || seen.has(key)) continue
    seen.add(key)
    kept.push(alias)
    if (kept.length === ALIASES_MAX) break
  }
  return kept
}

/** A stored `aliases` cell, read leniently: anything that is not a list of strings reads as none. */
export function parseAliases(stored: string | null | undefined): string[] {
  if (stored === null || stored === undefined || stored === '') return []
  try {
    const parsed: unknown = JSON.parse(stored)
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

/** Every key a named thing answers to: its main name's and each alias's, empties left out. */
export function nameKeys(name: string, aliases: readonly string[]): string[] {
  return [name, ...aliases].map(aliasKey).filter((key) => key !== '')
}

/** Anything with a name and aliases: a tag, a sheet. */
export interface Named {
  name: string
  aliases: readonly string[]
}

/**
 * The first of `items` whose main name or one of whose aliases has the key of `name`; a main
 * name wins over another item's alias. Undefined when none does (or `name` has no key).
 */
export function findByNameOrAlias<T extends Named>(
  items: readonly T[],
  name: string
): T | undefined {
  const key = aliasKey(name)
  if (key === '') return undefined
  return (
    items.find((item) => aliasKey(item.name) === key) ??
    items.find((item) => item.aliases.some((alias) => aliasKey(alias) === key))
  )
}

/**
 * A kebab-case tag name as words for an alias ("high-crown" → "High Crown"): what a merged tag's
 * name becomes on the tag it was merged into, when no sheet spells it better.
 */
export function tagNameAsAlias(name: string): string {
  return name
    .split('-')
    .filter((word) => word.length > 0)
    .map((word) => word.charAt(0).toLocaleUpperCase() + word.slice(1))
    .join(' ')
}
