import { useEffect, useId, useRef, useState } from 'react'
import { ChevronDown, ChevronLeft, Eye, EyeOff, Plus } from 'lucide-react'
import type { NovelFormat } from '@shared/ipc/contract'
import { normalizeSectionId } from '@shared/sidebarTabs'
import { useCategoryStore } from '@renderer/features/entities/categoryStore'
import { useIsArchived } from '@renderer/features/shell/archived'
import { useLayoutStore } from '@renderer/features/shell/layoutStore'
import {
  useSidebarSections,
  type SectionGroup,
  type SidebarSection
} from '@renderer/features/shell/sectionList'

interface SidebarSectionsProps {
  format: NovelFormat
  /** The sections; defaults to the open project's. Injectable so tests can drive any set. */
  sections?: readonly SidebarSection[]
  /** Shown on the picker's row after the button: the sidebar's dock grip and menu. */
  controls?: React.ReactNode
}

/** The picker's two actions after the sections. */
const SHOW_UNUSED = 'action:unused'
const NEW_CATEGORY = 'action:new-category'

const GROUP_ORDER: readonly SectionGroup[] = ['manuscript', 'bible', 'tools']

/** The groups' names; only the story bible's is shown (F-9.15: the tools follow under a rule). */
const GROUP_LABEL: Record<SectionGroup, string> = {
  manuscript: 'Manuscript',
  bible: 'Story bible',
  tools: 'Tools'
}

interface Row {
  id: string
  section: SidebarSection | null
}

/**
 * The sidebar's sections and their panel. While the old story bible is archived (the fresh start,
 * structure A 2026-10-16) they are two tabs, Manuscript and Notes (`SectionTabs`); otherwise, with
 * the story bible on or in a v2 project, the section picker (`SectionPicker`).
 */
export function SidebarSections({
  format,
  sections,
  controls
}: SidebarSectionsProps): React.JSX.Element {
  const projectSections = useSidebarSections()
  const bibleArchived = useIsArchived('storyBible')
  const all = sections ?? projectSections
  return bibleArchived ? (
    <SectionTabs format={format} all={all} controls={controls} />
  ) : (
    <SectionPicker format={format} all={all} controls={controls} />
  )
}

interface SectionViewProps {
  format: NovelFormat
  all: readonly SidebarSection[]
  controls: React.ReactNode
}

/**
 * The sidebar's section picker and panel (F-9.11, replacing F-7.3's row of icon tabs): one
 * labelled button at the top shows the current section's icon and name; it opens a list of every
 * used section by name, with its icon and how many things it holds — the Manuscript, the
 * story-bible categories, then the tools — and two actions: show the unused sections, and add a
 * category. Picking one fills the panel below. The current section is app-wide layout state (the
 * project session restores it, F-1.7); an id with no section falls back to the first. The list
 * is an ARIA listbox: ArrowUp/ArrowDown move (and wrap), Home/End jump, Enter or Space picks,
 * Escape closes and returns focus to the button. F-9.15: only the story bible carries a heading;
 * the tools follow it under a rule, so the list reads as Manuscript, the story bible, then the
 * rest. `controls` (the dock grip and menu) share the button's row, so the sidebar spends no row
 * on them.
 */
function SectionPicker({ format, all, controls }: SectionViewProps): React.JSX.Element {
  const stored = useLayoutStore((s) => s.layout.sidebar.tab)
  const setSidebarTab = useLayoutStore((s) => s.setSidebarTab)
  const [open, setOpen] = useState(false)
  const [showUnused, setShowUnused] = useState(false)
  const [activeRow, setActiveRow] = useState(0)
  const listId = useId()
  const button = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const wrapper = useRef<HTMLDivElement>(null)

  const currentId = normalizeSectionId(stored)
  const current = all.find((section) => section.id === currentId) ?? all[0]
  const shown = all
    .filter((section) => section.used || section.id === current?.id)
    .sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group))
  const unused = all.filter((section) => !section.used && section.id !== current?.id)

  const rows: Row[] = [
    ...shown.map((section) => ({ id: section.id, section })),
    ...(unused.length > 0 ? [{ id: SHOW_UNUSED, section: null }] : []),
    ...(showUnused ? unused.map((section) => ({ id: section.id, section })) : []),
    { id: NEW_CATEGORY, section: null }
  ]
  const optionId = (id: string): string => `${listId}-${id}`

  useEffect(() => {
    if (!open) return
    list.current?.focus()
    const onDown = (event: MouseEvent): void => {
      if (event.target instanceof Node && wrapper.current?.contains(event.target)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  useEffect(() => {
    if (!open) return
    const row = rows[activeRow]
    if (row === undefined) return
    document.getElementById(optionId(row.id))?.scrollIntoView?.({ block: 'nearest' })
  })

  const openList = (): void => {
    const at = rows.findIndex((row) => row.id === current?.id)
    setActiveRow(at === -1 ? 0 : at)
    // Each opening starts with the unused sections folded away again.
    setShowUnused(false)
    setOpen(true)
  }

  const close = (refocus: boolean): void => {
    setOpen(false)
    if (refocus) button.current?.focus()
  }

  const choose = (row: Row): void => {
    if (row.id === SHOW_UNUSED) {
      setShowUnused((value) => !value)
      return
    }
    if (row.id === NEW_CATEGORY) {
      close(true)
      useCategoryStore.getState().startCreate()
      return
    }
    setSidebarTab(row.id)
    close(true)
  }

  const onListKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const last = rows.length - 1
    switch (event.key) {
      case 'ArrowDown':
        setActiveRow((at) => (at >= last ? 0 : at + 1))
        break
      case 'ArrowUp':
        setActiveRow((at) => (at <= 0 ? last : at - 1))
        break
      case 'Home':
        setActiveRow(0)
        break
      case 'End':
        setActiveRow(last)
        break
      case 'Enter':
      case ' ': {
        const row = rows[activeRow]
        if (row !== undefined) choose(row)
        break
      }
      case 'Escape':
        close(true)
        break
      case 'Tab':
        setOpen(false)
        return
      default:
        return
    }
    event.preventDefault()
    event.stopPropagation()
  }

  const onButtonKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    openList()
  }

  const Icon = current?.icon
  const activeId = rows[activeRow]?.id

  const renderRow = (row: Row, index: number): React.JSX.Element => {
    const isActive = index === activeRow
    if (row.section === null) {
      const label =
        row.id === SHOW_UNUSED
          ? showUnused
            ? 'Hide unused sections'
            : `Show unused sections (${unused.length})`
          : 'New category…'
      const ActionIcon = row.id === NEW_CATEGORY ? Plus : showUnused ? EyeOff : Eye
      return (
        <div
          key={row.id}
          id={optionId(row.id)}
          role="option"
          aria-selected={false}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => choose(row)}
          onMouseMove={() => setActiveRow(index)}
          data-active={isActive || undefined}
          className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-xs text-fg-muted data-active:bg-surface-raised data-active:text-fg"
        >
          <ActionIcon size={14} aria-hidden="true" className="shrink-0" />
          {label}
        </div>
      )
    }
    const section = row.section
    const RowIcon = section.icon
    return (
      <div
        key={row.id}
        id={optionId(row.id)}
        role="option"
        aria-selected={section.id === current?.id}
        aria-label={section.label}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => choose(row)}
        onMouseMove={() => setActiveRow(index)}
        data-active={isActive || undefined}
        className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm aria-selected:font-medium data-active:bg-surface-raised"
      >
        <RowIcon size={15} aria-hidden="true" className="shrink-0 text-fg-muted" />
        <span className="min-w-0 flex-1 truncate">{section.label}</span>
        {section.count !== null ? (
          <span aria-hidden="true" className="shrink-0 text-xs text-fg-muted tabular-nums">
            {section.count}
          </span>
        ) : null}
      </div>
    )
  }

  /** The rows in their groups: Manuscript, Story bible, Tools, then the actions and the unused. */
  const grouped = (): React.JSX.Element[] => {
    const out: React.JSX.Element[] = []
    let index = 0
    for (const group of GROUP_ORDER) {
      const start = index
      while (index < shown.length && shown[index]?.group === group) index += 1
      if (index === start) continue
      const items = rows.slice(start, index).map((row, i) => renderRow(row, start + i))
      out.push(
        <div
          key={group}
          role="group"
          aria-label={GROUP_LABEL[group]}
          className={group === 'tools' ? 'mt-1 border-t border-line pt-1' : undefined}
        >
          {group === 'bible' ? (
            <div
              role="presentation"
              className="px-3 pt-2 pb-1 text-[11px] font-semibold tracking-wide text-fg-muted uppercase"
            >
              {GROUP_LABEL[group]}
            </div>
          ) : null}
          {items}
        </div>
      )
    }
    const tail = rows.slice(index).map((row, i) => renderRow(row, index + i))
    if (tail.length === 0) return out
    out.push(
      <div key="actions" role="group" aria-label="More" className="mt-1 border-t border-line pt-1">
        {tail}
      </div>
    )
    return out
  }

  return (
    <>
      <div
        ref={wrapper}
        className="relative flex shrink-0 items-center gap-1 border-b border-line bg-panel-title py-1.5 pr-1 pl-2"
      >
        <button
          ref={button}
          type="button"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-label={`Section: ${current?.label ?? ''}`}
          onClick={() => (open ? close(false) : openList())}
          onKeyDown={onButtonKeyDown}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1 text-sm font-medium hover:bg-surface-raised focus-visible:bg-surface-raised focus-visible:outline-none"
        >
          {Icon ? <Icon size={15} aria-hidden="true" className="shrink-0 text-fg-muted" /> : null}
          <span className="min-w-0 flex-1 truncate text-left">{current?.label}</span>
          <ChevronDown size={14} aria-hidden="true" className="shrink-0 text-fg-muted" />
        </button>
        {open ? (
          <div
            ref={list}
            id={listId}
            role="listbox"
            aria-label="Sections"
            tabIndex={0}
            aria-activedescendant={activeId === undefined ? undefined : optionId(activeId)}
            onKeyDown={onListKeyDown}
            className="absolute inset-x-2 top-full z-30 mt-1 max-h-[70vh] overflow-y-auto rounded-md border border-line bg-surface py-1 shadow-panel focus:outline-none"
          >
            {grouped()}
          </div>
        ) : null}
        {controls}
      </div>
      <div
        role="region"
        id="sidebar-panel"
        aria-label={`${current?.label ?? 'Sidebar'} section`}
        className="flex min-h-0 flex-1 flex-col"
      >
        {current?.render(format)}
      </div>
    </>
  )
}

/**
 * The fresh start's two tabs (structure A, 2026-10-16): the sections of their own (Manuscript,
 * Notes) side by side on the dock controls' row, the current one's panel below. A section that
 * lives under a tab (Outline, Timeline, Edits under Notes) keeps that tab selected and shows its
 * view with a back row to the tab's own panel. The layout store's sidebar tab stays the one state:
 * `edits` selects Notes with Edits open, `notes` its tree; an id with no section falls back to the
 * first tab. Clicking the selected tab while a view under it is open goes back to the tab's own
 * panel. An ARIA tablist: Left/Right move and wrap, Home/End jump, each selecting as it moves.
 */
function SectionTabs({ format, all, controls }: SectionViewProps): React.JSX.Element {
  const stored = useLayoutStore((s) => s.layout.sidebar.tab)
  const setSidebarTab = useLayoutStore((s) => s.setSidebarTab)
  const baseId = useId()
  const tabRefs = useRef(new Map<string, HTMLButtonElement>())

  const tabs = all.filter((section) => section.under === undefined)
  const currentId = normalizeSectionId(stored)
  const current = all.find((section) => section.id === currentId) ?? tabs[0]
  const selected =
    current?.under === undefined ? current : tabs.find((tab) => tab.id === current.under)
  const tabId = (id: string): string => `${baseId}-tab-${id}`

  const select = (index: number): void => {
    const tab = tabs[(index + tabs.length) % tabs.length]
    if (tab === undefined) return
    setSidebarTab(tab.id)
    tabRefs.current.get(tab.id)?.focus()
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const at = tabs.findIndex((tab) => tab.id === selected?.id)
    switch (event.key) {
      case 'ArrowRight':
        select(at + 1)
        break
      case 'ArrowLeft':
        select(at - 1)
        break
      case 'Home':
        select(0)
        break
      case 'End':
        select(tabs.length - 1)
        break
      default:
        return
    }
    event.preventDefault()
    event.stopPropagation()
  }

  return (
    <>
      <div className="flex shrink-0 items-center gap-1 border-b border-line bg-panel-title py-1.5 pr-1 pl-2">
        <div
          role="tablist"
          aria-label="Sections"
          onKeyDown={onKeyDown}
          className="flex min-w-0 flex-1 items-center gap-1"
        >
          {tabs.map((tab) => {
            const isSelected = tab.id === selected?.id
            return (
              <button
                key={tab.id}
                ref={(node) => {
                  if (node === null) tabRefs.current.delete(tab.id)
                  else tabRefs.current.set(tab.id, node)
                }}
                id={tabId(tab.id)}
                type="button"
                role="tab"
                aria-selected={isSelected}
                aria-controls="sidebar-panel"
                tabIndex={isSelected ? 0 : -1}
                onClick={() => setSidebarTab(tab.id)}
                // Names only, sized to their words: with three tabs and the dock controls on the
                // row, icons cut "Manuscript" short at the default sidebar width.
                className="flex min-w-0 flex-auto items-center justify-center rounded-md px-1.5 py-1 text-sm text-fg-muted hover:bg-surface-raised focus-visible:bg-surface-raised focus-visible:outline-none aria-selected:bg-surface-raised aria-selected:font-medium aria-selected:text-fg"
              >
                <span className="min-w-0 truncate">{tab.label}</span>
              </button>
            )
          })}
        </div>
        {controls}
      </div>
      <div
        role="tabpanel"
        id="sidebar-panel"
        aria-labelledby={selected === undefined ? undefined : tabId(selected.id)}
        className="flex min-h-0 flex-1 flex-col"
      >
        {current !== undefined && current !== selected && selected !== undefined ? (
          <>
            <button
              type="button"
              aria-label={`Back to ${selected.label}`}
              onClick={() => setSidebarTab(selected.id)}
              className="flex shrink-0 items-center gap-1 border-b border-line px-2 py-1 text-xs text-fg-muted hover:bg-surface-raised hover:text-fg focus-visible:bg-surface-raised focus-visible:outline-none"
            >
              <ChevronLeft size={14} aria-hidden="true" className="shrink-0" />
              {selected.label}
            </button>
            <div
              role="region"
              aria-label={`${current.label} section`}
              className="flex min-h-0 flex-1 flex-col"
            >
              {current.render(format)}
            </div>
          </>
        ) : (
          current?.render(format)
        )}
      </div>
    </>
  )
}
