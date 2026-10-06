import { NovelFormat } from './ipc/contract'
import {
  HIERARCHY_LEVELS,
  NODE_KINDS,
  defaultNodeTitle,
  levelLabel,
  type HierarchyLevel
} from './labels'
import { toTagName } from './tags'

/**
 * Auto-tag from titles (F-2.8): a part, chapter, or scene the author has named ("Fallen
 * Creator") is offered as the tag `fallen-creator`, so it can be referenced inline. Nothing is
 * created by the offer; the tag bar shows it and the author accepts or dismisses it.
 */

/** Every title the tree gives a new node, in any format, in its tag-name form ("untitled-arc"). */
const DEFAULT_TITLES: ReadonlySet<string> = new Set(
  NovelFormat.options.flatMap((format) =>
    NODE_KINDS.flatMap((kind) =>
      [...HIERARCHY_LEVELS, null].map((level) => toTagName(defaultNodeTitle(format, kind, level)))
    )
  )
)

/** The level words of every format ("part", "arc", "chapter", "scene"), in tag-name form. */
const LEVEL_WORDS: ReadonlySet<string> = new Set(
  NovelFormat.options.flatMap((format) =>
    HIERARCHY_LEVELS.map((level) => toTagName(levelLabel(format, level)))
  )
)

/** A number the seed or the author puts after a level word: "1", "12", "iii". */
const ORDINAL = /^(\d+|[ivxlcdm]+)$/

/**
 * Whether a tag-name form is a placeholder title: one the tree generates ("untitled-chapter"),
 * or a level word plus a number or roman numeral, as the seeded skeleton names nodes ("scene-1",
 * "chapter-2", "arc-1", "part-iii").
 */
function isDefaultTitle(name: string): boolean {
  if (DEFAULT_TITLES.has(name)) return true
  const cut = name.lastIndexOf('-')
  if (cut <= 0) return false
  return LEVEL_WORDS.has(name.slice(0, cut)) && ORDINAL.test(name.slice(cut + 1))
}

/**
 * The tag name a node's title offers, or null: only a node with a hierarchy level offers one,
 * and never a title that kebab-cases to nothing, a placeholder title, a name the bank already
 * holds, or a name the author dismissed (the F-4.12b dismissed names, already kebab-cased).
 */
export function titleTagProposal(
  node: { title: string; hierarchyLevel: HierarchyLevel | null },
  bankNames: ReadonlySet<string>,
  dismissed: readonly string[]
): string | null {
  if (node.hierarchyLevel === null) return null
  const name = toTagName(node.title)
  if (name === '' || isDefaultTitle(name)) return null
  if (bankNames.has(name) || dismissed.includes(name)) return null
  return name
}
