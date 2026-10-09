import { z } from 'zod'
import { AgentEdit } from './agent'
import { AiErrorCode, AiUsage } from './ai'
import { aliasKey, AliasList } from './aliases'
import { CATEGORY_FIELD_LABEL_MAX, CATEGORY_FIELDS_MAX, CATEGORY_NAME_MAX } from './categories'
import { ENTITY_BODY_MAX, ENTITY_FIELD_MAX, ENTITY_NAME_MAX, EntityKind } from './entities'
import { isCloseSpelling } from './misspellings'
import { TAG_NAME_MAX, TagCategory } from './tags'

/**
 * Organise (F-9.10, plan `plan-organize.md` slice OR3, the author's decisions of 2026-10-08):
 * the AI goes through the tags, the story-bible sheets, the notes, and the binder and proposes a
 * plan of typed changes: merge duplicate tags into one tag with aliases, fix categories, nest
 * tags, remove unused ones; merge duplicate sheets, fill empty fields from notes and observed
 * facts, tidy page text, move a sheet into another category or a new one; move facts out of
 * scene notes into the right sheets and tidy notes into points; rename, reorder, and merge
 * documents. Organising never rewrites scene text (merging documents joins theirs, after Apply).
 *
 * The plan follows the chat mode (F-5.21): Ask lists every change with a checkbox; Auto applies
 * what can be undone at once (each with Undo, and one Undo for the whole reorganisation); Plan
 * only describes. A merge, a deletion, and a new category always ask (`needsAsk`).
 *
 * Before any AI runs, a cheap local pass (`findOrganiseCandidates`) finds likely duplicates
 * (shared names and aliases, a short name inside a longer one, close spellings), unused tags, and
 * empty sheets; it feeds the quiet offer and is handed to the AI as hints.
 */

/** What an organise run covers; none named means all four. */
export const ORGANISE_SCOPES = ['tags', 'sheets', 'notes', 'binder'] as const
export const OrganiseScope = z.enum(ORGANISE_SCOPES)
export type OrganiseScope = z.infer<typeof OrganiseScope>

export const ORGANISE_SCOPE_LABEL: Record<OrganiseScope, string> = {
  tags: 'Tags',
  sheets: 'Story bible',
  notes: 'Notes',
  binder: 'Binder'
}

/** The longest instruction a run carries ("put every ship in Ships"). */
export const ORGANISE_INSTRUCTION_MAX = 2_000

/** What starts a run: the author's words (empty for a plain "organise") and what it covers. */
export const OrganiseRequest = z.object({
  instruction: z.string().trim().max(ORGANISE_INSTRUCTION_MAX).default(''),
  scope: z.array(OrganiseScope).max(ORGANISE_SCOPES.length).default([])
})
export type OrganiseRequest = z.infer<typeof OrganiseRequest>

/** The scopes a request covers: what it names, or all of them. */
export function scopesOf(request: Pick<OrganiseRequest, 'scope'>): OrganiseScope[] {
  return request.scope.length === 0 ? [...ORGANISE_SCOPES] : [...new Set(request.scope)]
}

/** Operations one request's answer may carry; the rest are dropped and counted. */
export const ORGANISE_MAX_OPS = 40
/** Requests one run may send (one per chunk of the listing). */
export const ORGANISE_MAX_CHUNKS = 6
/** Characters of listing one request carries beside the rules and the name index. */
export const ORGANISE_CHUNK_CHARS = 14_000
/** Characters of the name index every request carries, so a chunk can name things in others. */
export const ORGANISE_INDEX_CHARS = 6_000
/** The `max_tokens` one request asks; the one retry of a cut-off answer asks twice that. */
export const ORGANISE_MAX_TOKENS = 2_500
export const ORGANISE_RETRY_MAX_TOKENS = 5_000
/**
 * organise.v2 (2026-10-08, "Organise at scale"): chunks one run may send before what is left is
 * named in the plan's skipped notes (never dropped silently), and the `max_tokens` one request
 * asks (reasoning is off for organise, so the whole cap is the answer). There is no retry turn: a
 * chunk whose answer is cut off or unreadable is halved, at most `ORGANISE_SPLIT_DEPTH` times.
 */
export const ORGANISE_V2_MAX_CHUNKS = 16
export const ORGANISE_V2_MAX_TOKENS = 6_000
export const ORGANISE_SPLIT_DEPTH = 2
/** Points one notes change may write. */
export const ORGANISE_NOTE_POINTS_MAX = 30
/** The longest point of a tidied note. */
export const ORGANISE_POINT_MAX = 600

const Ref = z.string().trim().min(1).max(80)
const Why = z.string().max(300).optional()
const Name = z.string().trim().min(1).max(ENTITY_NAME_MAX)
const Text = z.string().max(ENTITY_FIELD_MAX)
/** Field values keyed by field id or label; `page` is a blank sheet's page. */
const FieldMap = z.record(z.string().max(80), Text)

/**
 * One operation as the model writes it (prompt `organise.v1`): tags as `t3`, sheets as `s2`,
 * documents as `n7`, categories by id or name. Read leniently; `resolveOrganiseOps` in main checks
 * each against the project and turns it into an `OrganiseAction` or a skip with the reason.
 */
export const OrganiseOp = z.discriminatedUnion('op', [
  z.object({ op: z.literal('mergeTags'), keep: Ref, merge: z.array(Ref).min(1).max(20), why: Why }),
  z.object({
    op: z.literal('tag'),
    tag: Ref,
    name: z.string().trim().min(1).max(TAG_NAME_MAX).optional(),
    category: z.string().max(40).optional(),
    /** A tag ref to nest under, or "" for the top level. */
    parent: z.string().max(80).optional(),
    aliases: z.array(z.string()).max(40).optional(),
    why: Why
  }),
  z.object({ op: z.literal('deleteTag'), tag: Ref, why: Why }),
  z.object({
    op: z.literal('mergeSheets'),
    keep: Ref,
    merge: z.array(Ref).min(1).max(20),
    why: Why
  }),
  z.object({
    op: z.literal('sheet'),
    sheet: Ref,
    name: Name.optional(),
    category: z.string().max(80).optional(),
    /** Values that replace a field's text (a tidied page, a corrected value). */
    set: FieldMap.optional(),
    /** Text added to a field (an empty field filled, a fact moved in from the notes). */
    add: FieldMap.optional(),
    aliases: z.array(z.string()).max(40).optional(),
    why: Why
  }),
  z.object({
    op: z.literal('newSheet'),
    category: z.string().min(1).max(80),
    name: Name,
    fields: FieldMap.optional(),
    aliases: z.array(z.string()).max(40).optional(),
    why: Why
  }),
  z.object({ op: z.literal('deleteSheet'), sheet: Ref, why: Why }),
  z.object({
    op: z.literal('category'),
    name: z.string().trim().min(1).max(CATEGORY_NAME_MAX),
    singular: z.string().trim().min(1).max(CATEGORY_NAME_MAX).optional(),
    fields: z
      .array(z.string().trim().min(1).max(CATEGORY_FIELD_LABEL_MAX))
      .max(CATEGORY_FIELDS_MAX)
      .default([]),
    why: Why
  }),
  z.object({
    op: z.literal('notes'),
    id: Ref,
    points: z.array(z.string().max(ORGANISE_POINT_MAX)).max(ORGANISE_NOTE_POINTS_MAX),
    why: Why
  }),
  z.object({ op: z.literal('rename'), id: Ref, title: z.string().min(1).max(200), why: Why }),
  z.object({
    op: z.literal('move'),
    id: Ref,
    in: Ref,
    after: z.string().max(80).default(''),
    why: Why
  }),
  z.object({ op: z.literal('merge'), id: Ref, into: Ref, why: Why }),
  z.object({ op: z.literal('delete'), id: Ref, why: Why })
])
export type OrganiseOp = z.infer<typeof OrganiseOp>

/** A tag's organisable parts, as a change sets them and as they were (for Undo). */
export const TagPatch = z.object({
  name: z.string().optional(),
  category: TagCategory.optional(),
  parentId: z.string().nullable().optional(),
  aliases: AliasList.optional()
})
export type TagPatch = z.infer<typeof TagPatch>

/** A sheet's organisable parts. `kind` moves it into another category (F-9.11). */
export const SheetPatch = z.object({
  name: Name.optional(),
  kind: EntityKind.optional(),
  fields: z.record(z.string(), Text).optional(),
  body: z.string().max(ENTITY_BODY_MAX).nullable().optional(),
  aliases: AliasList.optional()
})
export type SheetPatch = z.infer<typeof SheetPatch>

const Named = z.object({ id: z.string(), name: z.string() })

/** One change of the plan as main resolved it: real ids, the names it shows, the values it replaces. */
export const OrganiseAction = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('mergeTags'),
    target: Named,
    sources: z.array(Named).min(1)
  }),
  z.object({
    kind: z.literal('tag'),
    tagId: z.string(),
    name: z.string(),
    patch: TagPatch,
    before: TagPatch,
    /** The names of the parents involved, for the line ("under #houses"). */
    parentName: z.string().nullable().default(null),
    beforeParentName: z.string().nullable().default(null)
  }),
  z.object({
    kind: z.literal('deleteTag'),
    tagId: z.string(),
    name: z.string(),
    /**
     * The local "Not names — remove?" finding (the author's tag rule, 2026-10-08): an AI-made tag
     * the manuscript uses as an ordinary word. Removing it also keeps background tagging from
     * making it again (`DISMISSED_NAMES_KEY`).
     */
    notName: z.boolean().default(false)
  }),
  z.object({
    kind: z.literal('mergeSheets'),
    target: Named,
    sources: z.array(Named).min(1),
    /** Whether a sheet that goes away has any text: such a merge always asks (the author's call). */
    withText: z.boolean()
  }),
  z.object({
    kind: z.literal('sheet'),
    entityId: z.string(),
    name: z.string(),
    patch: SheetPatch,
    before: SheetPatch
  }),
  z.object({
    kind: z.literal('createSheet'),
    category: EntityKind,
    name: Name,
    fields: z.record(z.string(), Text),
    aliases: AliasList
  }),
  z.object({
    kind: z.literal('deleteSheet'),
    entityId: z.string(),
    name: z.string(),
    withText: z.boolean()
  }),
  /** A new category, proposed first (F-9.11); `id` is the one its sheets name until it exists. */
  z.object({
    kind: z.literal('category'),
    id: EntityKind,
    name: z.string(),
    noun: z.string(),
    fields: z.array(z.string())
  }),
  /** A document's notes rewritten as these points (the facts moved out, the rest tidied). */
  z.object({
    kind: z.literal('notes'),
    nodeId: z.string(),
    title: z.string(),
    before: z.string(),
    points: z.array(z.string()).max(ORGANISE_NOTE_POINTS_MAX)
  }),
  /** The binder: a chat-agent structure edit (rename, move, merge, delete of an empty folder). */
  z.object({ kind: z.literal('binder'), edit: AgentEdit })
])
export type OrganiseAction = z.infer<typeof OrganiseAction>

/**
 * The plan screen's groups (the review deck's rail, 2026-10-08): merges first, then the tags that
 * are not names, then the rest by the part of the project they change.
 */
export const ORGANISE_GROUPS = [
  'merges',
  'notNames',
  'categories',
  'tags',
  'sheets',
  'notes',
  'binder'
] as const
export type OrganiseGroup = (typeof ORGANISE_GROUPS)[number]

export const ORGANISE_GROUP_LABEL: Record<OrganiseGroup, string> = {
  merges: 'Merges',
  notNames: 'Not names',
  categories: 'Categories',
  tags: 'Tags',
  sheets: 'Story bible',
  notes: 'Notes',
  binder: 'Binder'
}

/** What one change of a group is called in the card's heading ("Merge 3 of 12"). */
export const ORGANISE_GROUP_NOUN: Record<OrganiseGroup, string> = {
  merges: 'Merge',
  notNames: 'Not a name',
  categories: 'New category',
  tags: 'Tag',
  sheets: 'Sheet',
  notes: 'Notes',
  binder: 'Binder'
}

export function groupOf(action: OrganiseAction): OrganiseGroup {
  switch (action.kind) {
    case 'mergeTags':
    case 'mergeSheets':
      return 'merges'
    case 'deleteTag':
      return action.notName ? 'notNames' : 'tags'
    case 'category':
      return 'categories'
    case 'tag':
      return 'tags'
    case 'sheet':
    case 'createSheet':
    case 'deleteSheet':
      return 'sheets'
    case 'notes':
      return 'notes'
    case 'binder':
      return 'binder'
  }
}

/**
 * Whether a change waits for the author's tick even in Auto: every merge and deletion (nothing
 * can undo them; the author's rule covers sheets with text, decided by Claude for the rest) and
 * a new category (an invented category is proposed first, F-9.11).
 */
export function needsAsk(action: OrganiseAction): boolean {
  switch (action.kind) {
    case 'mergeTags':
    case 'deleteTag':
    case 'mergeSheets':
    case 'deleteSheet':
    case 'category':
      return true
    case 'binder':
      return action.edit.kind === 'merge' || action.edit.kind === 'delete'
    default:
      return false
  }
}

/** Whether applying the change can be undone (from the plan screen, for the session). */
export function canUndo(action: OrganiseAction): boolean {
  return !needsAsk(action)
}

/** One change of a plan, with what it depends on (a sheet moved into a proposed category). */
export const OrganiseChange = z.object({
  id: z.string(),
  action: OrganiseAction,
  /** The model's one-line reason, or ''. */
  reason: z.string(),
  /** Ids of changes that must be applied first; unticked or failed, this one is skipped. */
  requires: z.array(z.string()).default([])
})
export type OrganiseChange = z.infer<typeof OrganiseChange>

/** What an organise run found: the plan, the operations it could not use, and the local findings. */
export const OrganisePlan = z.object({
  /** The model's sentence per chunk, joined: what it changed, or why it could not. */
  reply: z.string(),
  changes: z.array(OrganiseChange),
  /** One line per operation that could not be used, with why. */
  skipped: z.array(z.string()),
  chunks: z.number().int().nonnegative()
})
export type OrganisePlan = z.infer<typeof OrganisePlan>

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`
const quoted = (text: string): string => `“${text}”`
const list = (names: readonly string[]): string => names.map(quoted).join(', ')

/**
 * One line naming the change, the way the plan screen heads it; `categoryName` names a category
 * id (the plan screen passes the project's and the plan's proposed names).
 */
export function describeOrganiseAction(
  action: OrganiseAction,
  categoryName: (id: string) => string = (id) => id
): string {
  switch (action.kind) {
    case 'mergeTags':
      return `Merge tags ${list(action.sources.map((s) => `#${s.name}`))} into #${action.target.name}`
    case 'tag': {
      const parts: string[] = []
      const { patch } = action
      if (patch.name !== undefined) parts.push(`rename to #${patch.name}`)
      if (patch.category !== undefined) parts.push(`category ${patch.category}`)
      if (patch.parentId !== undefined) {
        parts.push(
          action.parentName === null ? 'move to the top level' : `nest under #${action.parentName}`
        )
      }
      if (patch.aliases !== undefined) {
        parts.push(patch.aliases.length === 0 ? 'no aliases' : `aliases ${list(patch.aliases)}`)
      }
      return `Tag #${action.name}: ${parts.join('; ')}`
    }
    case 'deleteTag':
      return action.notName
        ? `Remove #${action.name}: not a name`
        : `Delete the unused tag #${action.name}`
    case 'mergeSheets':
      return `Merge ${list(action.sources.map((s) => s.name))} into the sheet ${quoted(action.target.name)}`
    case 'sheet': {
      const parts: string[] = []
      const { patch } = action
      if (patch.name !== undefined) parts.push(`rename to ${quoted(patch.name)}`)
      if (patch.kind !== undefined) parts.push(`move to ${categoryName(patch.kind)}`)
      const fields = Object.keys(patch.fields ?? {}).length + (patch.body === undefined ? 0 : 1)
      if (fields > 0) parts.push(plural(fields, 'field'))
      if (patch.aliases !== undefined) parts.push(`aliases ${list(patch.aliases)}`)
      return `Sheet ${quoted(action.name)}: ${parts.join('; ')}`
    }
    case 'createSheet':
      return `New sheet ${quoted(action.name)} in ${categoryName(action.category)}`
    case 'deleteSheet':
      return `Delete the sheet ${quoted(action.name)}`
    case 'category':
      return `New category ${quoted(action.name)}`
    case 'notes':
      return `Tidy the notes of ${action.title} into ${plural(action.points.length, 'point')}`
    case 'binder':
      return describeBinderEdit(action.edit)
  }
}

function describeBinderEdit(edit: AgentEdit): string {
  switch (edit.kind) {
    case 'rename':
      return `Rename ${edit.title} to ${quoted(edit.after)}`
    case 'move':
      return `Move ${edit.title} into ${edit.parentTitle}`
    case 'merge':
      return `Merge ${edit.title} into ${edit.intoTitle}`
    case 'delete':
      return `Delete the empty ${edit.name}`
    default:
      return 'Change the binder'
  }
}

// ---------------------------------------------------------------------------------------------
// Local detection: no AI, cheap enough to run after every upload and as tags and sheets build up.
// ---------------------------------------------------------------------------------------------

/** A tag as the local pass reads it. */
export interface CandidateTag {
  id: string
  name: string
  aliases: readonly string[]
  /** Documents tagged with it. */
  usageCount: number
  /** Documents whose text mentions it (F-4.12). */
  mentions: number
  /** Tags nested under it. */
  children: number
  /** Sheets linked to it (F-9.4). */
  sheets: number
  /**
   * The author's tag rule (2026-10-08, `classifyTagTerm`): the manuscript uses the name as an
   * ordinary word. Such a tag is never a duplicate of another; an AI-made one is offered for removal.
   */
  ordinary?: boolean
  /** Made by background tagging (F-4.13) and not taken over by the author since. */
  aiMade?: boolean
}

/** A sheet as the local pass reads it. */
export interface CandidateSheet {
  id: string
  kind: string
  name: string
  aliases: readonly string[]
  /** Whether it has no field value, no page text, and no picture. */
  empty: boolean
}

/** Things that look like one another: a group of ids of one sort. */
export const OrganiseDuplicate = z.object({
  of: z.enum(['tag', 'sheet']),
  ids: z.array(z.string()).min(2),
  names: z.array(z.string()).min(2)
})
export type OrganiseDuplicate = z.infer<typeof OrganiseDuplicate>

/** What the local pass found (`organise:candidates`). */
export const OrganiseCandidates = z.object({
  duplicates: z.array(OrganiseDuplicate),
  unusedTags: z.array(Named),
  emptySheets: z.array(Named),
  /** AI-made tags the manuscript uses as ordinary words ("Not names — remove?", 2026-10-08). */
  notNames: z.array(Named).default([])
})
export type OrganiseCandidates = z.infer<typeof OrganiseCandidates>

/** The shortest word a contained name may be made of: "war" inside "Ashfall War" is not a duplicate. */
const CONTAINED_WORD_MIN = 4

const wordsOf = (key: string): string[] => key.split('-').filter((word) => word !== '')

/**
 * Whether two names read as the same thing: the same key; every word of the shorter one (each of
 * at least four letters) among the longer one's ("Rynna" in "Rynna Falsire"); or the same number
 * of words, each the same or a close spelling ("Rynna Falseer" and "Rynna Falsire").
 */
export function namesLookAlike(a: string, b: string): boolean {
  const ka = aliasKey(a)
  const kb = aliasKey(b)
  if (ka === '' || kb === '') return false
  if (ka === kb) return true
  const wa = wordsOf(ka)
  const wb = wordsOf(kb)
  const [short, long] = wa.length <= wb.length ? [wa, wb] : [wb, wa]
  if (
    short.length < long.length &&
    short.every((word) => [...word].length >= CONTAINED_WORD_MIN && long.includes(word))
  ) {
    return true
  }
  if (wa.length !== wb.length) return false
  let differs = false
  for (let i = 0; i < wa.length; i++) {
    const x = wa[i] ?? ''
    const y = wb[i] ?? ''
    if (x === y) continue
    if (!isCloseSpelling(x, y) && !isCloseSpelling(y, x)) return false
    differs = true
  }
  return differs
}

interface NamedItem {
  id: string
  name: string
  aliases: readonly string[]
}

/** Groups of items any of whose names look alike, each group in the given order. */
function alikeGroups(items: readonly NamedItem[]): NamedItem[][] {
  const parent = items.map((_, i) => i)
  const find = (i: number): number => {
    let root = i
    while (parent[root] !== root) root = parent[root] ?? root
    return root
  }
  const namesOf = (item: NamedItem): string[] => [item.name, ...item.aliases]
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i]
      const b = items[j]
      if (a === undefined || b === undefined || find(i) === find(j)) continue
      if (namesOf(a).some((x) => namesOf(b).some((y) => namesLookAlike(x, y)))) {
        parent[find(j)] = find(i)
      }
    }
  }
  const groups = new Map<number, NamedItem[]>()
  items.forEach((item, i) => {
    const root = find(i)
    groups.set(root, [...(groups.get(root) ?? []), item])
  })
  return [...groups.values()].filter((group) => group.length > 1)
}

/**
 * The local pass: tags and sheets whose names or aliases look alike, tags nothing uses (no
 * document, mention, sheet, or child), sheets with nothing in them, and AI-made tags that are
 * ordinary words. A tag named by an ordinary word is never part of a duplicate ("custom" and
 * "customs" are two words, not one character spelled twice), whoever made it.
 */
export function findOrganiseCandidates(
  tags: readonly CandidateTag[],
  sheets: readonly CandidateSheet[]
): OrganiseCandidates {
  const notNames = tags.filter((t) => t.ordinary === true && t.aiMade === true)
  const isNotName = (id: string): boolean => notNames.some((t) => t.id === id)
  const duplicates: OrganiseDuplicate[] = [
    ...alikeGroups(tags.filter((t) => t.ordinary !== true)).map((group) => ({
      of: 'tag' as const,
      ids: group.map((tag) => tag.id),
      names: group.map((tag) => tag.name)
    })),
    ...alikeGroups(sheets).map((group) => ({
      of: 'sheet' as const,
      ids: group.map((sheet) => sheet.id),
      names: group.map((sheet) => sheet.name)
    }))
  ]
  return {
    duplicates,
    unusedTags: tags
      .filter((t) => t.usageCount === 0 && t.mentions === 0 && t.children === 0 && t.sheets === 0)
      .filter((t) => !isNotName(t.id))
      .map(({ id, name }) => ({ id, name })),
    emptySheets: sheets.filter((s) => s.empty).map(({ id, name }) => ({ id, name })),
    notNames: notNames.map(({ id, name }) => ({ id, name }))
  }
}

/** Unused tags and empty sheets it takes, without a duplicate, before the offer shows. */
export const ORGANISE_OFFER_LOOSE_ENDS = 3

/** Whether the local findings are worth a quiet offer: any duplicate, or a few loose ends. */
export function worthOffering(found: OrganiseCandidates): boolean {
  return (
    found.duplicates.length > 0 ||
    found.unusedTags.length + found.emptySheets.length + found.notNames.length >=
      ORGANISE_OFFER_LOOSE_ENDS
  )
}

/** A key of the findings, so an offer the author waved away stays away until something changes. */
export function candidatesKey(found: OrganiseCandidates): string {
  return [
    ...found.duplicates.map((d) => `${d.of}:${[...d.ids].sort().join('+')}`),
    ...found.unusedTags.map((t) => `u:${t.id}`),
    ...found.emptySheets.map((s) => `e:${s.id}`),
    ...found.notNames.map((t) => `x:${t.id}`)
  ]
    .sort()
    .join('|')
}

/** The offer's line ("2 possible duplicates, 3 unused tags"). */
export function describeCandidates(found: OrganiseCandidates): string {
  const parts: string[] = []
  if (found.duplicates.length > 0) {
    parts.push(plural(found.duplicates.length, 'possible duplicate'))
  }
  if (found.unusedTags.length > 0) parts.push(plural(found.unusedTags.length, 'unused tag'))
  if (found.emptySheets.length > 0) parts.push(plural(found.emptySheets.length, 'empty sheet'))
  if (found.notNames.length > 0) {
    parts.push(
      `${plural(found.notNames.length, 'tag')} that ${found.notNames.length === 1 ? 'is' : 'are'} not a name`
    )
  }
  return parts.join(', ')
}

/** What `organise:plan` answers: the plan with what it cost, or an expected AI failure as data. */
export const OrganisePlanResult = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    plan: OrganisePlan,
    usage: AiUsage,
    costUsd: z.number().nonnegative(),
    cached: z.boolean(),
    model: z.string(),
    proposalId: z.string(),
    requestId: z.string()
  }),
  z.object({
    ok: z.literal(false),
    code: AiErrorCode,
    message: z.string(),
    nextStep: z.string(),
    requestId: z.string()
  })
])
export type OrganisePlanResult = z.infer<typeof OrganisePlanResult>
