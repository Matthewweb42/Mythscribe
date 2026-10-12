import { normName } from '@shared/memory/names'
import type { NamedInRow } from '@shared/memory/nameScan'
import type { CaseRule, RecordAlias, StoryRecordSummary } from '@shared/memory/records'
import type { TwinGateResult, TwinRule } from '@shared/memory/twinGate'
import type { AliasesInput } from './recordStore'

/**
 * What the record views say (F-16.4, F-16.6; story memory v2), kept pure so the words and the
 * rules are tested once: the twin gate's warning, the case-rule choices, who shares a name, the
 * list's search, and the *Same as…* preview.
 */

/** How a name is matched in the prose, as the sheet offers it (identity rule 3). */
export const CASE_RULE_LABEL: Record<CaseRule, string> = {
  auto: 'As a name',
  exact: 'Exact case',
  any: 'Any case'
}

/** What each case rule means, for the choice's tooltip. */
export const CASE_RULE_HINT: Record<CaseRule, string> = {
  auto: 'Matched where it is capitalised, and in its exact case when the book also writes it in lower case',
  exact: 'Matched only exactly as written here',
  any: 'Matched in any case'
}

const GATE_REASON: Record<Exclude<TwinRule, 'dismissed'>, (matched: string) => string> = {
  alias: (matched) => `already called “${matched}”`,
  subset: (matched) => `shares a name with “${matched}”`,
  prefix: (matched) => `starts the same as “${matched}”`,
  edit: (matched) => `spelled almost like “${matched}”`
}

/** The warning the twin gate gives a name being created (decision P1-D4: never a silent block). */
export function gateWarning(
  verdict: Extract<TwinGateResult, { outcome: 'blocked' }>,
  recordName: string | undefined
): string {
  if (verdict.rule === 'dismissed' || recordName === undefined) {
    return `“${verdict.matched}” is on your Dismissed list as not a name.`
  }
  return `Looks like ${recordName} (${GATE_REASON[verdict.rule](verdict.matched)}).`
}

/** Whether a record's name or one of its nicknames holds the (lower-cased) search text. */
export function matchesRecordQuery(record: StoryRecordSummary, needle: string): boolean {
  if (needle === '') return true
  return record.aliases.some((entry) => entry.text.toLowerCase().includes(needle))
}

/** The other names of a record, in the order they were added (its own name left out). */
export function nicknamesOf(record: StoryRecordSummary): RecordAlias[] {
  return record.aliases.filter((entry) => !entry.isMain)
}

/** The other records holding this name shared (identity rule 4), by name. */
export function sharedWith(
  entry: RecordAlias,
  records: readonly StoryRecordSummary[]
): StoryRecordSummary[] {
  return records.filter(
    (other) =>
      other.id !== entry.recordId &&
      other.aliases.some((name) => name.norm === entry.norm && name.shared)
  )
}

/** The other records that already answer to `text` (by its normal form), each with that name. */
export function holdersOf(
  text: string,
  records: readonly StoryRecordSummary[],
  exceptId: string
): { record: StoryRecordSummary; entry: RecordAlias }[] {
  const norm = normName(text)
  return records.flatMap((record) => {
    if (record.id === exceptId) return []
    const entry = record.aliases.find((name) => name.norm === norm)
    return entry === undefined ? [] : [{ record, entry }]
  })
}

/** A record's names as `setAliases` takes them, with the one whose normal form is `norm` shared. */
export function sharingInput(record: StoryRecordSummary, norm: string): AliasesInput {
  const input = aliasesInputOf(record)
  const main = record.aliases.find((entry) => entry.isMain)
  return {
    name: main?.norm === norm ? { ...input.name, shared: true } : input.name,
    aliases: nicknamesOf(record).map((entry, index) => {
      const each = input.aliases[index] ?? { text: entry.text }
      return entry.norm === norm ? { ...each, shared: true } : each
    })
  }
}

/** "named in 3 scenes", "named in 1 scene", "not named yet". */
export function namedInLabel(scenes: number): string {
  if (scenes === 0) return 'not named yet'
  return `named in ${scenes} ${scenes === 1 ? 'scene' : 'scenes'}`
}

/** What *Same as…* would do, counted for its confirmation. */
export interface MergePreview {
  /** Names the kept record gains (the merged one's own name included). */
  names: number
  /** Scenes that name the merged record, which will name the kept one. */
  scenes: number
}

export function mergePreview(
  keep: StoryRecordSummary,
  merge: StoryRecordSummary,
  namedIn: readonly NamedInRow[]
): MergePreview {
  const have = new Set(keep.aliases.map((entry) => entry.norm))
  return {
    names: merge.aliases.filter((entry) => !have.has(entry.norm)).length,
    scenes: namedIn.filter((row) => row.recordId === merge.id).length
  }
}

/** "Merge Tomas into Mara: 2 names and 3 scenes move over; its Pinned and Ideas are added below." */
export function mergeSummary(
  keep: StoryRecordSummary,
  merge: StoryRecordSummary,
  preview: MergePreview
): string {
  const names = `${preview.names} ${preview.names === 1 ? 'name' : 'names'}`
  const scenes = `${preview.scenes} ${preview.scenes === 1 ? 'scene' : 'scenes'}`
  return `${merge.name} becomes part of ${keep.name}: ${names} and the mentions in ${scenes} move over, and its Pinned and Ideas are added below this one’s.`
}

/** A record's names as `setAliases` takes them, unchanged. */
export function aliasesInputOf(record: StoryRecordSummary): AliasesInput {
  const main = record.aliases.find((entry) => entry.isMain)
  return {
    name: { text: record.name, caseRule: main?.caseRule, shared: main?.shared ?? false },
    aliases: nicknamesOf(record).map((entry) => ({
      text: entry.text,
      caseRule: entry.caseRule,
      shared: entry.shared
    }))
  }
}
