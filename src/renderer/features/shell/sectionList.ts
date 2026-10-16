import { createElement, type ReactNode } from 'react'
import {
  BookOpen,
  CalendarRange,
  FilePenLine,
  History,
  KeyRound,
  Library,
  ListTodo,
  ListTree,
  NotebookPen,
  NotebookText,
  Tag,
  type LucideIcon
} from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { ALWAYS_SHOWN_CATEGORIES, categoryOf, type StoryCategory } from '@shared/categories'
import type { NovelFormat } from '@shared/ipc/contract'
import type { SidebarToolId } from '@shared/sidebarTabs'
import { SECRET_CATEGORY_ID } from '@shared/memory/topics'
import type { StoryMemoryVersion } from '@shared/storyMemory'
import { THREAD_KIND } from '@shared/threads'
import { ChangesTab } from '@renderer/features/changes/ChangesTab'
import { useChangesStore } from '@renderer/features/changes/changesStore'
import { EditPassTab } from '@renderer/features/editPass/EditPassTab'
import { useEditPassStore } from '@renderer/features/editPass/editPassStore'
import { CATEGORY_ICON } from '@renderer/features/entities/categoryIcons'
import { useCategoryStore } from '@renderer/features/entities/categoryStore'
import { EntityTab } from '@renderer/features/entities/EntityTab'
import { useEntityStore } from '@renderer/features/entities/entityStore'
import { LibraryTab } from '@renderer/features/library/LibraryTab'
import { NotesTab } from '@renderer/features/notebook/NotesTab'
import { useNotebookStore } from '@renderer/features/notebook/notebookStore'
import { useLibraryStore } from '@renderer/features/library/libraryStore'
import { ManuscriptTab } from '@renderer/features/manuscript/ManuscriptTab'
import { useTreeStore } from '@renderer/features/manuscript/treeStore'
import { OutlineTab } from '@renderer/features/outline/OutlineTab'
import { useStoryMemory } from '@renderer/features/project/storyMemory'
import { useIsArchived } from '@renderer/features/shell/archived'
import { RecordTab } from '@renderer/features/records/RecordTab'
import { useRecordStore } from '@renderer/features/records/recordStore'
import { ResearchTab } from '@renderer/features/research/ResearchTab'
import { TagsTab } from '@renderer/features/tags/TagsTab'
import { useTagStore } from '@renderer/features/tags/tagStore'
import { ThreadsTab } from '@renderer/features/threads/ThreadsTab'
import { TimelineTab } from '@renderer/features/timeline/TimelineTab'
import { TodoTab } from '@renderer/features/todo/TodoTab'
import { useTodoStore } from '@renderer/features/todo/todoStore'
import { useTimelineStore } from '@renderer/features/timeline/timelineStore'

/**
 * The sidebar's sections (F-9.11): what the section picker lists and the panel below it shows.
 * The Manuscript first, then the story-bible categories, then the tools. A section is `used` when
 * it has something in it; the picker lists the used ones and keeps the rest one click away under
 * "Show unused sections". Manuscript, Characters, Places, and Tags are always used (the author's
 * call); a category is used once it has a sheet; Timeline, Edits, and Library once they hold an
 * event, a pass, or a file; Outline once the manuscript has a document, since it is a view of it
 * (decided by Claude, unconfirmed; `QUESTIONS.md`).
 *
 * F-9.15 (the story-bible end state, decided by Claude, unconfirmed): Manuscript | Story bible
 * (its categories, then the tags as its Index: a record's tag beside its sheet, the labels apart)
 * | Threads | Outline | Timeline | Library | To do | Edits | Changes. The ids are unchanged
 * (`tags` is the Index, `thread` is Threads), so a stored section still opens.
 *
 * F-16.6 (story memory v2, decision P1-D8): Manuscript | the categories as record lists |
 * Secrets (F-16.22) | Research | Outline | Edits. A stored section v2 does not list opens on
 * Manuscript.
 */
export type SectionGroup = 'manuscript' | 'bible' | 'tools'

export interface SidebarSection {
  id: string
  label: string
  icon: LucideIcon
  group: SectionGroup
  /** What the picker shows beside the name: documents, sheets, tags…; null for none. */
  count: number | null
  used: boolean
  /**
   * The section whose tab it opens under, when the sidebar shows tabs (the fresh start: Outline,
   * Timeline and Edits under Notes); undefined for a section of its own.
   */
  under?: string
  /** The section's panel content; the panel is a column flex box, so it may fill and scroll. */
  render: (format: NovelFormat) => ReactNode
}

/** What the sections hold, read from the stores. */
export interface SectionCounts {
  documents: number
  tags: number
  timeline: number
  edits: number
  library: number
  /** F-9.13: the Changes log rows held (the newest page). */
  changes: number
  /** F-9.16: the open To do items. */
  todo: number
  /** Sheets per category id. */
  sheets: Readonly<Record<string, number>>
  /** F-16.8: the documents of the Research section (story memory v2; 0 in v1, which has none). */
  research: number
  /** F-16.6: records per category id (story memory v2; empty in v1, which has none). */
  records: Readonly<Record<string, number>>
  /** Notes redesign phase 1: the note pages in the notebook. */
  notes: number
}

interface ToolDef {
  id: SidebarToolId
  label: string
  icon: LucideIcon
  render: (format: NovelFormat) => ReactNode
  count: (counts: SectionCounts) => number
  used: (counts: SectionCounts) => boolean
}

const MANUSCRIPT: ToolDef = {
  id: 'manuscript',
  label: 'Manuscript',
  icon: BookOpen,
  render: (format) => createElement(ManuscriptTab, { format }),
  count: (c) => c.documents,
  used: () => true
}

/**
 * Notes redesign phase 1 (2026-10-15): the notebook, right after the Manuscript in both story
 * memories; always used.
 */
const NOTES: ToolDef = {
  id: 'notes',
  label: 'Notes',
  icon: NotebookPen,
  render: () => createElement(NotesTab),
  count: (c) => c.notes,
  used: () => true
}

/** F-9.15: the tag bank as the story bible's Index, last in its group; always used. */
const INDEX: ToolDef = {
  id: 'tags',
  label: 'Index',
  icon: Tag,
  render: () => createElement(TagsTab),
  count: (c) => c.tags,
  used: () => true
}

/**
 * The tools in picker order, after Threads (F-9.15: Outline, Timeline, Library, To do, Edits,
 * Changes; To do, F-9.16, always shown).
 */
const TOOLS: readonly ToolDef[] = [
  {
    id: 'outline',
    label: 'Outline',
    icon: ListTree,
    render: () => createElement(OutlineTab),
    count: (c) => c.documents,
    used: (c) => c.documents > 0
  },
  {
    id: 'timeline',
    label: 'Timeline',
    icon: CalendarRange,
    render: () => createElement(TimelineTab),
    count: (c) => c.timeline,
    used: (c) => c.timeline > 0
  },
  {
    id: 'library',
    label: 'Library',
    icon: Library,
    render: () => createElement(LibraryTab),
    count: (c) => c.library,
    used: (c) => c.library > 0
  },
  {
    id: 'todo',
    label: 'To do',
    icon: ListTodo,
    render: () => createElement(TodoTab),
    count: (c) => c.todo,
    used: () => true
  },
  {
    id: 'edits',
    label: 'Edits',
    icon: FilePenLine,
    render: () => createElement(EditPassTab),
    count: (c) => c.edits,
    used: (c) => c.edits > 0
  },
  {
    id: 'changes',
    label: 'Changes',
    icon: History,
    render: () => createElement(ChangesTab),
    count: (c) => c.changes,
    used: (c) => c.changes > 0
  }
]

/** F-16.8 (story memory v2 only): always listed, after the categories. */
const RESEARCH: ToolDef = {
  id: 'research',
  label: 'Research',
  icon: NotebookText,
  render: (format) => createElement(ResearchTab, { format }),
  count: (c) => c.research,
  used: () => true
}

function toolSection(tool: ToolDef, counts: SectionCounts, group: SectionGroup): SidebarSection {
  return {
    id: tool.id,
    label: tool.label,
    icon: tool.icon,
    group,
    count: tool.count(counts),
    used: tool.used(counts),
    render: tool.render
  }
}

/**
 * F-16.6 (story memory v2): a category as a record list. The thread category is a plain list
 * too until P2b brings threads back as claims.
 */
function recordSection(category: StoryCategory, records: number): SidebarSection {
  return {
    id: category.id,
    label: category.name,
    icon: CATEGORY_ICON[category.icon],
    group: 'bible',
    count: records,
    used: ALWAYS_SHOWN_CATEGORIES.includes(category.id) || records > 0,
    render: () => createElement(RecordTab, { categoryId: category.id })
  }
}

/** The categories plus any category a sheet or record names that the list does not carry. */
function withStrays(
  categories: readonly StoryCategory[],
  held: Readonly<Record<string, number>>
): StoryCategory[] {
  const listed = new Set(categories.map((category) => category.id))
  const strays = Object.keys(held)
    .filter((kind) => !listed.has(kind))
    .map((kind) => categoryOf(kind, categories))
  return [...categories, ...strays]
}

/**
 * Story memory v2's list (F-16.6, decision P1-D8): Manuscript, the categories as record lists,
 * Research, Outline and Edits. Index, Threads, Timeline, Library, To do and Changes are not in
 * it; the This scene | Book panel and the Book views bring their content back (P1 slice 4, P2b–P4).
 */
const V2_TOOLS: readonly SidebarToolId[] = ['outline', 'edits']

/**
 * F-16.22 (P2b-D1): the Secrets section, after the categories: the `secret` records as a list
 * (each with "readers since 5.2 · 3 know") and *New secret*. Listed in the picker once a secret
 * exists; one click away under "Show unused sections" before that.
 */
function secretsSection(records: number): SidebarSection {
  return {
    id: SECRET_CATEGORY_ID,
    label: 'Secrets',
    icon: KeyRound,
    group: 'bible',
    count: records,
    used: records > 0,
    render: () => createElement(RecordTab, { categoryId: SECRET_CATEGORY_ID })
  }
}

function buildV2Sections(
  categories: readonly StoryCategory[],
  counts: SectionCounts
): SidebarSection[] {
  // Secrets have their own section, never a stray category's.
  const named = Object.fromEntries(
    Object.entries(counts.records).filter(([id]) => id !== SECRET_CATEGORY_ID)
  )
  return [
    toolSection(MANUSCRIPT, counts, 'manuscript'),
    toolSection(NOTES, counts, 'manuscript'),
    ...withStrays(categories, named).map((category) =>
      recordSection(category, counts.records[category.id] ?? 0)
    ),
    secretsSection(counts.records[SECRET_CATEGORY_ID] ?? 0),
    toolSection(RESEARCH, counts, 'tools'),
    ...TOOLS.filter((tool) => V2_TOOLS.includes(tool.id)).map((tool) =>
      toolSection(tool, counts, 'tools')
    )
  ]
}

function categorySection(
  category: StoryCategory,
  sheets: number,
  group: SectionGroup
): SidebarSection {
  return {
    id: category.id,
    label: category.name,
    icon: CATEGORY_ICON[category.icon],
    group,
    count: sheets,
    used: ALWAYS_SHOWN_CATEGORIES.includes(category.id) || sheets > 0,
    // F-9.14: the thread category is the Threads section, not a sheet list.
    render: () =>
      category.id === THREAD_KIND
        ? createElement(ThreadsTab)
        : createElement(EntityTab, { kind: category.id })
  }
}

/**
 * Every section in picker order, used or not. A category a sheet names that the list does not
 * carry (never expected) still gets its section, so no sheet is ever out of reach. F-9.15: the
 * thread category is Threads, the first of the tools, and the tags close the story bible as its
 * Index. Story memory v2 has its own list (`buildV2Sections`); v1's is as it was (pinned by a
 * snapshot in the tests). Pure.
 */
export function buildSections(
  categories: readonly StoryCategory[],
  counts: SectionCounts,
  memory: StoryMemoryVersion,
  options: { storyBibleArchived?: boolean } = {}
): SidebarSection[] {
  if (memory === 'v2') return buildV2Sections(categories, counts)
  if (options.storyBibleArchived === true) return buildFreshStartSections(counts)
  const all = withStrays(categories, counts.sheets)
  const threads = all.find((category) => category.id === THREAD_KIND)
  return [
    toolSection(MANUSCRIPT, counts, 'manuscript'),
    toolSection(NOTES, counts, 'manuscript'),
    ...all
      .filter((category) => category !== threads)
      .map((category) => categorySection(category, counts.sheets[category.id] ?? 0, 'bible')),
    toolSection(INDEX, counts, 'bible'),
    ...(threads === undefined
      ? []
      : [categorySection(threads, counts.sheets[threads.id] ?? 0, 'tools')]),
    ...TOOLS.map((tool) => toolSection(tool, counts, 'tools'))
  ]
}

/**
 * Notes redesign, fresh start (the author 2026-10-15): with the old story bible archived, a v1
 * project lists Manuscript, Notes, Outline, Timeline and Edits. The categories, the Index,
 * Threads, Library, To do and Changes are hidden; a stored section among them opens on Manuscript.
 * Two tabs (structure A, 2026-10-16): Manuscript and Notes; Outline, Timeline and Edits live under
 * Notes, always listed as rows above its tree (an empty one shows its own empty state), their ids
 * unchanged so a stored or requested `edits` opens Notes with Edits.
 */
const FRESH_START_TOOLS: readonly SidebarToolId[] = ['outline', 'timeline', 'edits']

function buildFreshStartSections(counts: SectionCounts): SidebarSection[] {
  const views = TOOLS.filter((tool) => FRESH_START_TOOLS.includes(tool.id)).map(
    (tool): SidebarSection => ({
      ...toolSection(tool, counts, 'tools'),
      used: true,
      under: NOTES.id
    })
  )
  const rows = views.map(({ id, label, icon }) => ({ id, label, icon }))
  return [
    toolSection(MANUSCRIPT, counts, 'manuscript'),
    {
      ...toolSection(NOTES, counts, 'manuscript'),
      render: () => createElement(NotesTab, { views: rows })
    },
    ...views
  ]
}

/** The documents of the manuscript section (front and end matter are not counted). */
function manuscriptDocuments(state: ReturnType<typeof useTreeStore.getState>): number {
  return documentsIn(state, 'manuscript')
}

/** F-16.8: the documents of the Research section. */
function researchDocuments(state: ReturnType<typeof useTreeStore.getState>): number {
  return documentsIn(state, 'research')
}

function documentsIn(
  state: ReturnType<typeof useTreeStore.getState>,
  section: 'manuscript' | 'research'
): number {
  let count = 0
  for (const node of Object.values(state.byId)) {
    if (node.kind === 'document' && state.sectionOf[node.id] === section) count += 1
  }
  return count
}

/** The sections of the open project, from the stores; re-rendered as their counts change. */
export function useSidebarSections(): SidebarSection[] {
  const categories = useCategoryStore((s) => s.categories)
  const documents = useTreeStore(manuscriptDocuments)
  const research = useTreeStore(researchDocuments)
  const memory = useStoryMemory()
  const tags = useTagStore((s) => s.ids.length)
  const timeline = useTimelineStore((s) => s.events.length)
  const edits = useEditPassStore((s) => s.ids.length)
  const library = useLibraryStore((s) => s.files.length)
  const changes = useChangesStore((s) => s.entries.length)
  const todo = useTodoStore((s) => s.items.length)
  const notes = useNotebookStore((s) => {
    let pages = 0
    for (const item of Object.values(s.byId)) if (item.kind === 'page') pages += 1
    return pages
  })
  const sheets = useEntityStore(
    useShallow((s) => {
      const counts: Record<string, number> = {}
      for (const id of s.ids) {
        const kind = s.byId[id]?.kind
        if (kind !== undefined) counts[kind] = (counts[kind] ?? 0) + 1
      }
      return counts
    })
  )
  const records = useRecordStore(
    useShallow((s) => {
      const counts: Record<string, number> = {}
      for (const id of s.ids) {
        const categoryId = s.byId[id]?.categoryId
        if (categoryId !== undefined) counts[categoryId] = (counts[categoryId] ?? 0) + 1
      }
      return counts
    })
  )
  const storyBibleArchived = useIsArchived('storyBible')
  return buildSections(
    categories,
    { documents, tags, timeline, edits, library, changes, todo, sheets, research, records, notes },
    memory,
    { storyBibleArchived }
  )
}
