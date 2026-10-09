import { createElement, type ReactNode } from 'react'
import {
  BookOpen,
  CalendarRange,
  FilePenLine,
  History,
  Library,
  ListTodo,
  ListTree,
  Tag,
  type LucideIcon
} from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { ALWAYS_SHOWN_CATEGORIES, categoryOf, type StoryCategory } from '@shared/categories'
import type { NovelFormat } from '@shared/ipc/contract'
import type { SidebarToolId } from '@shared/sidebarTabs'
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
import { useLibraryStore } from '@renderer/features/library/libraryStore'
import { ManuscriptTab } from '@renderer/features/manuscript/ManuscriptTab'
import { useTreeStore } from '@renderer/features/manuscript/treeStore'
import { OutlineTab } from '@renderer/features/outline/OutlineTab'
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
 * Index. Pure.
 */
export function buildSections(
  categories: readonly StoryCategory[],
  counts: SectionCounts
): SidebarSection[] {
  const listed = new Set(categories.map((category) => category.id))
  const strays = Object.keys(counts.sheets)
    .filter((kind) => !listed.has(kind))
    .map((kind) => categoryOf(kind, categories))
  const all = [...categories, ...strays]
  const threads = all.find((category) => category.id === THREAD_KIND)
  return [
    toolSection(MANUSCRIPT, counts, 'manuscript'),
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

/** The documents of the manuscript section (front and end matter are not counted). */
function manuscriptDocuments(state: ReturnType<typeof useTreeStore.getState>): number {
  let count = 0
  for (const node of Object.values(state.byId)) {
    if (node.kind === 'document' && state.sectionOf[node.id] === 'manuscript') count += 1
  }
  return count
}

/** The sections of the open project, from the stores; re-rendered as their counts change. */
export function useSidebarSections(): SidebarSection[] {
  const categories = useCategoryStore((s) => s.categories)
  const documents = useTreeStore(manuscriptDocuments)
  const tags = useTagStore((s) => s.ids.length)
  const timeline = useTimelineStore((s) => s.events.length)
  const edits = useEditPassStore((s) => s.ids.length)
  const library = useLibraryStore((s) => s.files.length)
  const changes = useChangesStore((s) => s.entries.length)
  const todo = useTodoStore((s) => s.items.length)
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
  return buildSections(categories, {
    documents,
    tags,
    timeline,
    edits,
    library,
    changes,
    todo,
    sheets
  })
}
