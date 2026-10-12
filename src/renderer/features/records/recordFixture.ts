import type { CaseRule, RecordAlias, StoryRecord, StoryRecordSummary } from '@shared/memory/records'
import { recordKindOf } from '@shared/memory/records'
import type { Label } from '@shared/storyLabels'

/**
 * Test fixtures for story memory v2's renderer (F-16.6, F-16.7): records with their names, the
 * way `record:list` answers them, and labels. Names are `{ text, caseRule?, shared? }`; the first
 * is the record's own name.
 */

export interface NameSpec {
  text: string
  caseRule?: CaseRule
  shared?: boolean
}

const normOf = (text: string): string => text.normalize('NFC').trim().toLowerCase()

export function recordFixture(
  id: string,
  categoryId: string,
  names: readonly (string | NameSpec)[],
  over: Partial<StoryRecordSummary> = {}
): StoryRecordSummary {
  const aliases: RecordAlias[] = names.map((name, index) => {
    const spec = typeof name === 'string' ? { text: name } : name
    return {
      id: `${id}-a${index}`,
      recordId: id,
      text: spec.text,
      norm: normOf(spec.text),
      isMain: index === 0,
      caseRule: spec.caseRule ?? 'auto',
      origin: 'author',
      shared: spec.shared ?? false,
      created: `2026-10-12T09:00:0${index}.000Z`
    }
  })
  return {
    id,
    categoryId,
    kind: recordKindOf(categoryId),
    name: aliases[0]?.text ?? '',
    image: null,
    origin: 'author',
    aliases,
    created: '2026-10-12T09:00:00.000Z',
    modified: '2026-10-12T09:00:00.000Z',
    ...over
  }
}

/** A record as `record:get` answers it: the summary with empty pages. */
export function withPages(record: StoryRecordSummary): StoryRecord {
  return { ...record, pinned: null, ideas: null }
}

export function labelFixture(
  id: string,
  name: string,
  position: number,
  over: Partial<Label> = {}
): Label {
  return {
    id,
    name,
    colour: '#aa5500',
    kind: 'tone',
    position,
    created: '2026-10-12T09:00:00.000Z',
    modified: '2026-10-12T09:00:00.000Z',
    ...over
  }
}
