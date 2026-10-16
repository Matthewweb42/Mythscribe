import {
  NOTEBOOK_TEMPLATES,
  isNotebookTemplateId,
  myTemplatePages
} from '@shared/notebookTemplates'
import type { MenuItem } from '@renderer/features/manuscript/contextMenuItems'
import type { NotebookIndex } from './notebookIndex'
import type { NotebookTemplateChoice } from './notebookStore'

const MINE = 'template-mine:'
const BUILT_IN = 'template-built-in:'

/**
 * The New from template menu (note templates, phase 6): the author's own templates (the pages in a
 * Templates folder, in the tree's order) under "My templates", then the built-ins; the headings
 * show only when she has templates of her own.
 */
export function templateMenuItems(index: NotebookIndex): MenuItem[] {
  const mine = myTemplatePages(Object.values(index.byId))
  const builtIns = NOTEBOOK_TEMPLATES.map((template) => ({
    id: `${BUILT_IN}${template.id}`,
    label: template.name
  }))
  if (mine.length === 0) return builtIns
  return [
    { id: 'heading-mine', label: 'My templates', heading: true },
    ...mine.map((page) => ({ id: `${MINE}${page.id}`, label: page.title })),
    { id: 'heading-built-in', label: 'Built-in', heading: true },
    ...builtIns
  ]
}

/** The template a menu item stands for, or null. */
export function templateChoiceOf(itemId: string): NotebookTemplateChoice | null {
  if (itemId.startsWith(MINE)) return { kind: 'mine', pageId: itemId.slice(MINE.length) }
  if (itemId.startsWith(BUILT_IN)) {
    const id = itemId.slice(BUILT_IN.length)
    return isNotebookTemplateId(id) ? { kind: 'builtIn', id } : null
  }
  return null
}
