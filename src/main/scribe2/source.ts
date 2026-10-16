import { categoryOf } from '@shared/categories'
import type { Entity } from '@shared/ipc/contract'
import type { NotebookItem } from '@shared/notebook'
import { parseStoredSceneMeta } from '@shared/sceneMeta'
import { getSummary } from '../document/summaryStore'
import { listCategories } from '../entity/categoryStore'
import { listContextFiles, getContextFileRow, readContextText } from '../library/libraryStore'
import { listNotebook, listNotebookPages } from '../notebook/notebookStore'
import { storyBibleArchivedIn } from '../project/settingsStore'
import type { TreeDb } from '../tree/treeStore'
import { documentText } from '../voice/profile'
import { loadAgentProject, type AgentProject } from '../ai/agentTools'
import { notesText } from '../ai/context/scenePanel'
import type { ScribePage, ScribeScene } from './context'

/**
 * What Ms Scribe's v1 context is made of, read from the open project (notes redesign phase 1):
 * the notebook's pages, and while the old story bible is switched back on (Settings › Archived
 * features; archived by default since the fresh start) its sheets and the Library's uploads as
 * pages too; the manuscript's scenes in reading order under the agent's refs; and the
 * names to look for (page titles, sheet names and their other names).
 */
export interface ScribeMaterial {
  project: AgentProject
  pages: ScribePage[]
  scenes: ScribeScene[]
  names: string[]
}

/** "Characters › Minor" for an item in nested folders; '' at the top. */
export function folderPath(items: readonly NotebookItem[], parentId: string | null): string {
  const byId = new Map(items.map((item) => [item.id, item]))
  const path: string[] = []
  const seen = new Set<string>()
  for (let at = parentId; at !== null && !seen.has(at);) {
    seen.add(at)
    const item = byId.get(at)
    if (item === undefined) break
    path.unshift(item.title)
    at = item.parentId
  }
  return path.join(' › ')
}

/** A story-bible sheet as a page: its kind, other names, fields and page. */
export function sheetText(db: TreeDb, entity: Entity): string {
  const category = categoryOf(entity.kind, listCategories(db))
  const lines = [`Kind: ${category.name}`]
  if (entity.aliases.length > 0) lines.push(`Also called: ${entity.aliases.join(', ')}`)
  for (const field of category.fields) {
    const value = entity.fields[field.id]?.trim() ?? ''
    if (value !== '') lines.push(`${field.label}: ${value}`)
  }
  const body = entity.body?.trim() ?? ''
  if (body !== '') lines.push(body)
  return lines.join('\n')
}

/** The text of the Library's uploads (the text last filed, else read from the original). */
async function libraryPages(
  db: TreeDb,
  folder: string
): Promise<{ id: string; title: string; text: string }[]> {
  const pages: { id: string; title: string; text: string }[] = []
  for (const file of listContextFiles(db)) {
    if (file.type === 'image') continue
    const row = getContextFileRow(db, file.id)
    if (row === undefined) continue
    let text = row.processedText
    if (text === null) {
      try {
        text = await readContextText(folder, row)
      } catch {
        text = null
      }
    }
    if (text !== null && text.trim() !== '') pages.push({ id: file.id, title: file.name, text })
  }
  return pages
}

export async function loadScribeSources(
  db: TreeDb,
  folder: string,
  nodeId: string | null
): Promise<ScribeMaterial> {
  const project = loadAgentProject(db, nodeId, 'v1')
  // Notes redesign (fresh start): while the old story bible is archived its sheets and the
  // Library's uploads are not read; the notes and the manuscript are all she gets.
  const bible = !storyBibleArchivedIn(db, 'v1')
  const items = listNotebook(db)
  let n = 0
  const ref = (): string => `p${++n}`
  const pages: ScribePage[] = listNotebookPages(db).map((page) => ({
    ref: ref(),
    id: page.id,
    kind: 'note',
    title: page.title,
    folder: folderPath(items, page.parentId),
    text: page.plain
  }))
  for (const entity of bible ? project.entities : []) {
    pages.push({
      ref: ref(),
      id: entity.id,
      kind: 'sheet',
      title: entity.name,
      folder: '',
      text: sheetText(db, entity)
    })
  }
  for (const upload of bible ? await libraryPages(db, folder) : []) {
    pages.push({
      ref: ref(),
      id: upload.id,
      kind: 'library',
      title: upload.title,
      folder: '',
      text: upload.text
    })
  }
  const scenes: ScribeScene[] = project.time.order.flatMap((id) => {
    const row = project.byId.get(id)
    if (row?.kind !== 'document') return []
    return [
      {
        ref: project.refOf.get(id) ?? '',
        nodeId: id,
        title: project.titleOf(id) || row.title,
        synopsis: parseStoredSceneMeta(row.sceneMeta).synopsis,
        notes: notesText(row.notes, row.id),
        summary: getSummary(db, id)?.summary ?? '',
        text: documentText(row)
      }
    ]
  })
  const names = [
    ...pages.filter((page) => page.kind !== 'library').map((page) => page.title),
    ...(bible ? project.entities.flatMap((entity) => entity.aliases) : [])
  ]
  return { project, pages, scenes, names }
}
