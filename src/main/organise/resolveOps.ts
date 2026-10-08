import { normalizeAliases } from '@shared/aliases'
import {
  categoryFromInput,
  categoryOf,
  customCategoryId,
  joinSheetText,
  type StoryCategory
} from '@shared/categories'
import { toEntityNameKey } from '@shared/entities'
import type { Entity, Tag } from '@shared/ipc/contract'
import {
  ORGANISE_NOTE_POINTS_MAX,
  ORGANISE_POINT_MAX,
  type OrganiseAction,
  type OrganiseChange,
  type OrganiseOp,
  type SheetPatch,
  type TagPatch
} from '@shared/organise'
import { TagCategory, toTagName } from '@shared/tags'
import { nodeByRef, resolveAgentEdit } from '../ai/agentTools'
import { notesText } from '../ai/context/scenePanel'
import { isEmptySheet, type OrganiseProject } from './organiseProject'

/**
 * Turns the model's operations (F-9.10, prompt `organise.v1`) into the plan's changes: refs to
 * real ids, field names to field ids, the values each change replaces read from the project (for
 * the plan screen's before/after and for Undo). An operation that names nothing, would undo an
 * earlier change of the plan, or breaks a rule (deleting a tag that is still used, a sheet that
 * has text, a folder that has documents) is skipped with the reason. One state per run, so the
 * chunks of a run see each other's changes.
 */
export class OrganiseResolver {
  readonly changes: OrganiseChange[] = []
  readonly skipped: string[] = []
  /** Tags and sheets merged away or deleted by an earlier change. */
  private readonly gone = new Set<string>()
  /** Categories proposed by this plan: their ids, by every name they answer to. */
  private readonly proposed = new Map<string, { category: StoryCategory; changeId: string }>()
  /** What an earlier change made a tag or sheet, so a later one builds on it. */
  private readonly tagState = new Map<string, Tag>()
  private readonly sheetState = new Map<string, Entity>()
  /** Folders an earlier change moves something into, and folders an earlier change deletes. */
  private readonly filledFolders = new Set<string>()
  private readonly deletedFolders = new Set<string>()
  private seq = 0

  constructor(private readonly project: OrganiseProject) {}

  /** Resolves one answer's operations onto the plan. */
  add(ops: readonly OrganiseOp[]): void {
    for (const op of ops) {
      const outcome = this.resolve(op)
      if (typeof outcome === 'string') {
        this.skipped.push(`${op.op}: ${outcome}`)
        continue
      }
      this.changes.push({
        id: `c${++this.seq}`,
        action: outcome.action,
        reason: (op.why ?? '').trim().slice(0, 300),
        requires: outcome.requires ?? []
      })
    }
  }

  private resolve(op: OrganiseOp): Resolved | string {
    switch (op.op) {
      case 'mergeTags':
        return this.mergeTags(op)
      case 'tag':
        return this.tag(op)
      case 'deleteTag':
        return this.deleteTag(op)
      case 'mergeSheets':
        return this.mergeSheets(op)
      case 'sheet':
        return this.sheet(op)
      case 'newSheet':
        return this.newSheet(op)
      case 'deleteSheet':
        return this.deleteSheet(op)
      case 'category':
        return this.category(op)
      case 'notes':
        return this.notes(op)
      case 'rename':
      case 'move':
      case 'merge':
        return this.binder(op)
      case 'delete':
        return this.deleteFolder(op)
    }
  }

  // -- Tags -----------------------------------------------------------------------------------

  private tagOf(ref: string): Tag | string {
    const tag = this.project.tagByRef.get(ref.trim().toLowerCase())
    if (tag === undefined) return `${ref} is not a listed tag`
    if (this.gone.has(tag.id)) return `#${tag.name} is merged or deleted by an earlier change`
    return this.tagState.get(tag.id) ?? tag
  }

  private mergeTags(op: Extract<OrganiseOp, { op: 'mergeTags' }>): Resolved | string {
    const target = this.tagOf(op.keep)
    if (typeof target === 'string') return target
    const sources: Tag[] = []
    for (const ref of op.merge) {
      const source = this.tagOf(ref)
      if (typeof source === 'string') return source
      if (source.id !== target.id && !sources.some((s) => s.id === source.id)) sources.push(source)
    }
    if (sources.length === 0) return 'nothing to merge'
    for (const source of sources) this.gone.add(source.id)
    return {
      action: {
        kind: 'mergeTags',
        target: { id: target.id, name: target.name },
        sources: sources.map(({ id, name }) => ({ id, name }))
      }
    }
  }

  private tag(op: Extract<OrganiseOp, { op: 'tag' }>): Resolved | string {
    const tag = this.tagOf(op.tag)
    if (typeof tag === 'string') return tag
    const patch: TagPatch = {}
    const before: TagPatch = {}
    let parentName: string | null = null
    let beforeParentName: string | null = null
    if (op.name !== undefined) {
      const name = toTagName(op.name)
      const taken = this.project.tags.some((other) => other.id !== tag.id && other.name === name)
      if (name !== '' && name !== tag.name && !taken) {
        patch.name = name
        before.name = tag.name
      }
    }
    if (op.category !== undefined) {
      const category = TagCategory.safeParse(op.category.trim())
      if (category.success && category.data !== tag.category) {
        patch.category = category.data
        before.category = tag.category
      }
    }
    if (op.parent !== undefined) {
      const parent = op.parent.trim() === '' ? null : this.tagOf(op.parent)
      if (typeof parent === 'string') return parent
      const parentId = parent?.id ?? null
      if (parentId !== tag.parentId) {
        if (parentId !== null && this.isUnder(parentId, tag.id)) {
          return `#${tag.name} cannot go under its own descendant`
        }
        patch.parentId = parentId
        before.parentId = tag.parentId
        parentName = parent?.name ?? null
        beforeParentName = this.project.tags.find((t) => t.id === tag.parentId)?.name ?? null
      }
    }
    if (op.aliases !== undefined) {
      const aliases = normalizeAliases(op.aliases, patch.name ?? tag.name)
      if (JSON.stringify(aliases) !== JSON.stringify(tag.aliases)) {
        patch.aliases = aliases
        before.aliases = [...tag.aliases]
      }
    }
    if (Object.keys(patch).length === 0) return `#${tag.name} already reads that way`
    this.tagState.set(tag.id, {
      ...tag,
      ...(patch.name === undefined ? {} : { name: patch.name }),
      ...(patch.category === undefined ? {} : { category: patch.category }),
      ...(patch.parentId === undefined ? {} : { parentId: patch.parentId }),
      ...(patch.aliases === undefined ? {} : { aliases: patch.aliases })
    })
    return {
      action: {
        kind: 'tag',
        tagId: tag.id,
        name: tag.name,
        patch,
        before,
        parentName,
        beforeParentName
      }
    }
  }

  /** Whether `id` is `ancestor` or nested somewhere under it. */
  private isUnder(id: string, ancestor: string): boolean {
    const parentOf = new Map(
      this.project.tags.map((tag) => [tag.id, this.tagState.get(tag.id)?.parentId ?? tag.parentId])
    )
    for (let at: string | null | undefined = id, n = 0; at && n < 1000; n++) {
      if (at === ancestor) return true
      at = parentOf.get(at)
    }
    return false
  }

  private deleteTag(op: Extract<OrganiseOp, { op: 'deleteTag' }>): Resolved | string {
    const tag = this.tagOf(op.tag)
    if (typeof tag === 'string') return tag
    const used =
      tag.usageCount > 0 ||
      (this.project.mentions.get(tag.id) ?? 0) > 0 ||
      (this.project.children.get(tag.id) ?? 0) > 0 ||
      (this.project.sheetsOfTag.get(tag.id) ?? 0) > 0
    if (used) return `#${tag.name} is still used`
    this.gone.add(tag.id)
    return { action: { kind: 'deleteTag', tagId: tag.id, name: tag.name } }
  }

  // -- Sheets ---------------------------------------------------------------------------------

  private sheetOf(ref: string): Entity | string {
    const sheet = this.project.sheetByRef.get(ref.trim().toLowerCase())
    if (sheet === undefined) return `${ref} is not a listed sheet`
    if (this.gone.has(sheet.id)) return `${sheet.name} is merged or deleted by an earlier change`
    return this.sheetState.get(sheet.id) ?? sheet
  }

  private mergeSheets(op: Extract<OrganiseOp, { op: 'mergeSheets' }>): Resolved | string {
    const target = this.sheetOf(op.keep)
    if (typeof target === 'string') return target
    const sources: Entity[] = []
    for (const ref of op.merge) {
      const source = this.sheetOf(ref)
      if (typeof source === 'string') return source
      if (source.id !== target.id && !sources.some((s) => s.id === source.id)) sources.push(source)
    }
    if (sources.length === 0) return 'nothing to merge'
    for (const source of sources) this.gone.add(source.id)
    // The tags of the sources go with them (the merge merges them into the target's).
    for (const source of sources) if (source.tagId !== null) this.gone.add(source.tagId)
    return {
      action: {
        kind: 'mergeSheets',
        target: { id: target.id, name: target.name },
        sources: sources.map(({ id, name }) => ({ id, name })),
        withText: sources.some((source) => !isEmptySheet(source))
      }
    }
  }

  /** A category by id, name, or singular: the project's, the library's, or one this plan proposes. */
  private categoryOf(text: string): { category: StoryCategory; requires: string[] } | null {
    const key = text.trim().toLowerCase()
    const known = this.project.categories.find(
      (c) => c.id === key || c.name.toLowerCase() === key || c.noun.toLowerCase() === key
    )
    if (known !== undefined) return { category: known, requires: [] }
    const proposed = this.proposed.get(key)
    return proposed === undefined
      ? null
      : { category: proposed.category, requires: [proposed.changeId] }
  }

  /** A field of the category by id or label (any case); `page` is the blank page. */
  private fieldOf(category: StoryCategory, key: string): string | null {
    const wanted = key.trim().toLowerCase()
    if (wanted === 'page' || wanted === 'body') return 'page'
    const field = category.fields.find(
      (f) => f.id.toLowerCase() === wanted || f.label.toLowerCase() === wanted
    )
    return field?.id ?? null
  }

  private nameTaken(kind: string, name: string, exceptId: string | null): boolean {
    const key = toEntityNameKey(name)
    return this.project.sheets.some(
      (sheet) =>
        sheet.id !== exceptId &&
        !this.gone.has(sheet.id) &&
        (this.sheetState.get(sheet.id)?.kind ?? sheet.kind) === kind &&
        toEntityNameKey(this.sheetState.get(sheet.id)?.name ?? sheet.name) === key
    )
  }

  private sheet(op: Extract<OrganiseOp, { op: 'sheet' }>): Resolved | string {
    const sheet = this.sheetOf(op.sheet)
    if (typeof sheet === 'string') return sheet
    const patch: SheetPatch = {}
    const before: SheetPatch = {}
    const requires: string[] = []
    let category = categoryOf(sheet.kind, this.project.categories)
    if (op.category !== undefined) {
      const found = this.categoryOf(op.category)
      if (found === null) return `no category "${op.category}"`
      if (found.category.id !== sheet.kind) {
        patch.kind = found.category.id
        before.kind = sheet.kind
        category = found.category
        requires.push(...found.requires)
      }
    }
    const name = op.name?.trim()
    if (name !== undefined && name !== '' && name !== sheet.name) {
      patch.name = name
      before.name = sheet.name
    }
    if (
      (patch.name !== undefined || patch.kind !== undefined) &&
      this.nameTaken(category.id, patch.name ?? sheet.name, sheet.id)
    ) {
      return `a ${category.noun} named “${patch.name ?? sheet.name}” already exists`
    }
    const fields: Record<string, string> = {}
    const beforeFields: Record<string, string> = {}
    let body: string | undefined
    const write = (key: string, value: string, add: boolean): string | null => {
      const id = this.fieldOf(category, key)
      if (id === null) return `“${key}” is not a field of a ${category.noun}`
      const current = id === 'page' ? (sheet.body ?? '') : (fields[id] ?? sheet.fields[id] ?? '')
      const next = add ? joinSheetText(current, value) : value.trim()
      if (next === current.trim()) return null
      if (id === 'page') body = next
      else {
        fields[id] = next
        beforeFields[id] = sheet.fields[id] ?? ''
      }
      return null
    }
    for (const [key, value] of Object.entries(op.set ?? {})) {
      const problem = write(key, value, false)
      if (problem !== null) return problem
    }
    for (const [key, value] of Object.entries(op.add ?? {})) {
      const problem = write(key, value, true)
      if (problem !== null) return problem
    }
    if (Object.keys(fields).length > 0) {
      patch.fields = fields
      before.fields = beforeFields
    }
    if (patch.kind !== undefined) {
      // Undo moves it back: every value of the old template, as it was, rides along.
      const old = categoryOf(sheet.kind, this.project.categories)
      before.fields = Object.fromEntries(old.fields.map((f) => [f.id, sheet.fields[f.id] ?? '']))
    }
    if (body !== undefined) {
      patch.body = body
      before.body = sheet.body
    }
    if (op.aliases !== undefined) {
      const aliases = normalizeAliases(op.aliases, patch.name ?? sheet.name)
      if (JSON.stringify(aliases) !== JSON.stringify(sheet.aliases)) {
        patch.aliases = aliases
        before.aliases = [...sheet.aliases]
      }
    }
    if (Object.keys(patch).length === 0) return `${sheet.name} already reads that way`
    this.sheetState.set(sheet.id, {
      ...sheet,
      kind: patch.kind ?? sheet.kind,
      name: patch.name ?? sheet.name,
      fields: { ...sheet.fields, ...fields },
      body: body ?? sheet.body,
      aliases: patch.aliases ?? sheet.aliases
    })
    return {
      action: { kind: 'sheet', entityId: sheet.id, name: sheet.name, patch, before },
      requires
    }
  }

  private newSheet(op: Extract<OrganiseOp, { op: 'newSheet' }>): Resolved | string {
    const found = this.categoryOf(op.category)
    if (found === null) return `no category "${op.category}"`
    const name = op.name.trim()
    if (this.nameTaken(found.category.id, name, null)) {
      return `a ${found.category.noun} named “${name}” already exists`
    }
    const fields: Record<string, string> = {}
    for (const [key, value] of Object.entries(op.fields ?? {})) {
      const id = this.fieldOf(found.category, key)
      // A value with no field of its own goes into Notes, as a move between categories does.
      const target = id === null || id === 'page' ? 'notes' : id
      const line = id === null ? `${key}: ${value.trim()}` : value.trim()
      if (line !== '') fields[target] = joinSheetText(fields[target], line)
    }
    return {
      action: {
        kind: 'createSheet',
        category: found.category.id,
        name,
        fields,
        aliases: normalizeAliases(op.aliases ?? [], name)
      },
      requires: found.requires
    }
  }

  private deleteSheet(op: Extract<OrganiseOp, { op: 'deleteSheet' }>): Resolved | string {
    const sheet = this.sheetOf(op.sheet)
    if (typeof sheet === 'string') return sheet
    if (!isEmptySheet(sheet)) return `${sheet.name} has text; merge it instead`
    this.gone.add(sheet.id)
    return {
      action: { kind: 'deleteSheet', entityId: sheet.id, name: sheet.name, withText: false }
    }
  }

  private category(op: Extract<OrganiseOp, { op: 'category' }>): Resolved | string {
    if (this.categoryOf(op.name) !== null) return `the category “${op.name}” exists`
    const taken = [
      ...this.project.categories.map((c) => c.id),
      ...[...this.proposed.values()].map((p) => p.category.id)
    ]
    const id = customCategoryId(op.name, taken)
    const category = categoryFromInput(
      id,
      {
        name: op.name,
        ...(op.singular === undefined ? {} : { noun: op.singular }),
        fields: op.fields
      },
      'ai'
    )
    const changeId = `c${this.seq + 1}`
    for (const key of [id, category.name.toLowerCase(), category.noun.toLowerCase()]) {
      this.proposed.set(key, { category, changeId })
    }
    return {
      action: {
        kind: 'category',
        id,
        name: category.name,
        noun: category.noun,
        fields: category.fields.filter((f) => f.id !== 'notes').map((f) => f.label)
      }
    }
  }

  // -- Notes and the binder -------------------------------------------------------------------

  private notes(op: Extract<OrganiseOp, { op: 'notes' }>): Resolved | string {
    const row = nodeByRef(this.project.agent, op.id)
    if (row?.kind !== 'document' || row.parentId === null) return `${op.id} is not a document`
    const points = op.points
      .map((point) => point.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
      .filter((point) => point !== '')
      .map((point) => point.slice(0, ORGANISE_POINT_MAX))
      .slice(0, ORGANISE_NOTE_POINTS_MAX)
    const before = notesText(row.notes, row.id)
    if (points.join('\n') === before.trim()) return 'the notes already read that way'
    if (points.length === 0 && before === '') return 'no notes to tidy'
    return {
      action: {
        kind: 'notes',
        nodeId: row.id,
        title: this.project.agent.titleOf(row.id) || row.title,
        before,
        points
      }
    }
  }

  private binder(op: Extract<OrganiseOp, { op: 'rename' | 'move' | 'merge' }>): Resolved | string {
    const raw =
      op.op === 'rename'
        ? { edit: 'rename', id: op.id, title: op.title }
        : op.op === 'move'
          ? { edit: 'move', id: op.id, in: op.in, after: op.after }
          : { edit: 'merge', id: op.id, into: op.into }
    const resolved = resolveAgentEdit(this.project.agent, raw)
    if ('error' in resolved) return resolved.error
    if (resolved.edit.kind === 'move') {
      // Deleting a folder deletes what is in it: never move into one this plan deletes.
      if (this.deletedFolders.has(resolved.edit.parentId)) {
        return `${resolved.edit.parentTitle} is deleted by this plan`
      }
      this.filledFolders.add(resolved.edit.parentId)
    }
    return { action: { kind: 'binder', edit: resolved.edit } }
  }

  private deleteFolder(op: Extract<OrganiseOp, { op: 'delete' }>): Resolved | string {
    const row = nodeByRef(this.project.agent, op.id)
    if (row?.kind !== 'folder' || row.parentId === null) return `${op.id} is not a folder`
    if (
      this.filledFolders.has(row.id) ||
      this.project.agent.rows.some((other) => other.parentId === row.id)
    ) {
      return `${row.title} is not empty`
    }
    this.deletedFolders.add(row.id)
    return {
      action: {
        kind: 'binder',
        edit: {
          kind: 'delete',
          target: 'node',
          id: row.id,
          name: this.project.agent.titleOf(row.id) || row.title
        }
      }
    }
  }
}

interface Resolved {
  action: OrganiseAction
  requires?: string[]
}
