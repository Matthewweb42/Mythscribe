import fs from 'node:fs'
import { asc } from 'drizzle-orm'
import type { NovelFormat } from '@shared/ipc/contract'
import { dismissedKey } from '@shared/memory/dismissed'
import { replaceInlineTags } from '@shared/memory/inlineTagReplace'
import { normName } from '@shared/memory/names'
import { STORY_YEAR_MAX, STORY_YEAR_MIN } from '@shared/memory/sceneDetails'
import type { SwitchoverConsent, SwitchoverCounts } from '@shared/memory/switchover'
import { pageFromLines, pinnedPage } from '@shared/memory/switchoverMapping'
import { EMPTY_DOC } from '@shared/tiptap'
import { dropAiPlanLinks } from '../../ai/planLinks'
import { contextFile, draftText } from '../../db/schema'
import { saveDocument } from '../../document/documentStore'
import { saveNotes } from '../../document/notesStore'
import { rewriteDraftText } from '../../draft/draftStore'
import { AppError } from '../../ipc/errors'
import { extractContextText } from '../../library/extract'
import { storedPath } from '../../library/libraryStore'
import { ensureResearchRoot } from '../../project/seed'
import { getStoryMemory, setStoryMemory } from '../../project/settingsStore'
import {
  createResearchNote,
  insertResearchUpload,
  researchPage,
  setResearchNotCanon,
  type ResearchPage
} from '../../research/researchStore'
import { listNodes, type TreeDb } from '../../tree/treeStore'
import { documentJson } from '../../voice/profile'
import { dismiss } from '../dismissedStore'
import { assignLabel, createLabel } from '../labelStore'
import { insertConvertedRecord, sameAs, unshareLoneConvertedNames } from '../recordStore'
import { setSceneDetails } from '../sceneDetailStore'
import { buildSwitchoverModel, plannedUploads } from './model'

/**
 * The switch-over's conversion (F-16.15, plan P1 §6.1 step 4; modelled on F-9.14's
 * `knowledge/conversion.ts`): `prepareSwitchover` reads the library originals and extracts their
 * text asynchronously, outside the transaction; `convertSwitchover` then writes every v2 table in
 * one transaction from the model built inside it, with the author's consent applied, and sets the
 * project's story memory to v2. Nothing of v1 is dropped (the old tables stay until P9), and
 * snapshots are never read or written.
 */

/** The uploads' pages, by library file id; null when the original could not be read. */
export interface PreparedSwitchover {
  pages: Map<string, ResearchPage | null>
}

/**
 * Reads and converts every upload's original (`researchPage`: Word, Markdown and text as pages,
 * a PDF's text layer, an image's empty caption page). A missing or unreadable original is null:
 * its document is made empty, with the original kept, and the conversion goes on.
 */
export async function prepareSwitchover(db: TreeDb, folder: string): Promise<PreparedSwitchover> {
  const uploads = new Set(plannedUploads(db).map((item) => item.contextFileId))
  const pages = new Map<string, ResearchPage | null>()
  const rows = db.select().from(contextFile).orderBy(asc(contextFile.created)).all()
  for (const row of rows) {
    if (!uploads.has(row.id)) continue
    try {
      const data = await fs.promises.readFile(storedPath(folder, row.stored))
      const text = row.type === 'pdf' ? await extractContextText('pdf', data) : null
      pages.set(row.id, await researchPage(row.type, data, text))
    } catch {
      pages.set(row.id, null)
    }
  }
  return { pages }
}

/** The message a second switch-over gets. */
export const ALREADY_SWITCHED =
  'This project already uses the new story memory; the switch-over runs once.'

/**
 * Converts the project in one transaction (see the module comment). In order: inline tags become
 * the consented words in every node's content and notes and every inactive draft; the records are
 * written with their names and pages; the labels with their links; Research (uploads and the
 * Project notes); the typed scene details; the dismissals that still apply; the merges the author
 * ticked (only pairs the dry run offered); the plan links the AI applied come off; then
 * `storyMemory` is v2. VALIDATION when the stored version is v2 already: it runs once.
 */
export function convertSwitchover(
  db: TreeDb,
  format: NovelFormat,
  prepared: PreparedSwitchover,
  consent: SwitchoverConsent,
  now: Date
): SwitchoverCounts {
  if (getStoryMemory(db).version === 'v2') throw new AppError('VALIDATION', ALREADY_SWITCHED)
  const replacements = new Map(consent.replacements.map((row) => [row.key, row.text]))
  return db.transaction((tx) => {
    const model = buildSwitchoverModel(tx, { replacements })
    const counts: SwitchoverCounts = {
      records: 0,
      labels: 0,
      research: 0,
      scenesWithDetails: 0,
      dismissals: 0,
      merged: 0,
      tokens: 0,
      documents: 0
    }

    // 1. Inline tags as words: contents, notes, inactive drafts. Snapshots are never touched.
    for (const row of listNodes(tx)) {
      const content = documentJson({ content: row.content })
      if (content !== null && row.kind === 'document') {
        const out = replaceInlineTags(content, model.tokenText)
        if (out.replaced > 0) {
          saveDocument(tx, row.id, out.doc)
          counts.tokens += out.replaced
          counts.documents += 1
        }
      }
      const notes = documentJson({ content: row.notes })
      if (notes !== null && row.parentId !== null) {
        const out = replaceInlineTags(notes, model.tokenText)
        if (out.replaced > 0) {
          saveNotes(tx, row.id, out.doc)
          counts.tokens += out.replaced
          counts.documents += 1
        }
      }
    }
    for (const row of tx.select().from(draftText).all()) {
      const doc = documentJson({ content: row.content })
      if (doc === null) continue
      const out = replaceInlineTags(doc, model.tokenText)
      if (out.replaced === 0) continue
      rewriteDraftText(tx, row.draftId, row.nodeId, out.doc)
      counts.tokens += out.replaced
      counts.documents += 1
    }

    // 2. Records, their names and pages.
    const ids = new Map<string, string>()
    const shared = (text: string): boolean => model.sharedNorms.has(normName(text))
    for (const planned of model.records) {
      const id = insertConvertedRecord(
        tx,
        {
          name: planned.name,
          categoryId: planned.categoryId,
          image: planned.image,
          aliases: planned.aliases.map((text) => ({ text, shared: shared(text) })),
          mainShared: shared(planned.name),
          pinned: pinnedPage(planned.pinned, planned.filedIn === 'pinned' ? planned.filedByAi : []),
          ideas: pinnedPage(planned.ideas, planned.filedIn === 'ideas' ? planned.filedByAi : []),
          legacyEntityId: planned.legacyEntityId,
          legacyTagId: planned.legacyTagId
        },
        now
      )
      ids.set(planned.key, id)
      counts.records += 1
    }
    const idOf = (key: string | null): string | null =>
      key === null ? null : (ids.get(key) ?? null)

    // 3. Labels and their links.
    for (const item of model.labels) {
      const made = createLabel(
        tx,
        { name: item.name, kind: item.kind, colour: item.colour, legacyTagId: item.tagId },
        now
      )
      for (const nodeId of item.nodeIds) assignLabel(tx, made.id, nodeId)
      counts.labels += 1
    }

    // 4. Research: uploads with their originals, and the Project notes as a written note.
    const root = ensureResearchRoot(tx, now)
    for (const item of model.research) {
      if (item.kind === 'upload') {
        const page = prepared.pages.get(item.contextFileId) ?? { doc: EMPTY_DOC, converted: false }
        insertResearchUpload(
          tx,
          format,
          root,
          { name: item.name, contextFileId: item.contextFileId, fileType: item.type, page },
          now
        )
      } else {
        const note = createResearchNote(tx, format, { parentId: root, title: item.title }, now)
        saveDocument(tx, note.id, pageFromLines(item.lines) ?? EMPTY_DOC)
        if (item.notCanon) setResearchNotCanon(tx, note.id, true, now)
      }
      counts.research += 1
    }

    // 5. Typed scene details.
    for (const details of model.details) {
      const year = details.storyYear
      setSceneDetails(
        tx,
        details.nodeId,
        {
          povRecordId: idOf(details.povKey),
          place: { recordId: idOf(details.placeKey), text: details.placeText },
          time: { text: details.timeText },
          storyYear:
            year !== null && year >= STORY_YEAR_MIN && year <= STORY_YEAR_MAX ? year : null,
          alsoHere: details.alsoHere.flatMap((key) => idOf(key) ?? []),
          flashback: details.flashback
        },
        now
      )
      counts.scenesWithDetails += 1
    }

    // 6. Dismissals that still apply.
    for (const item of model.dismissals) {
      if (item.kind === 'name') {
        dismiss(tx, { kind: 'name', key: dismissedKey(item), label: item.label }, now)
      } else if (item.kind === 'notSame') {
        const a = idOf(item.a)
        const b = idOf(item.b)
        if (a === null || b === null) continue
        dismiss(
          tx,
          { kind: 'notSame', key: dismissedKey({ kind: 'notSame', a, b }), label: item.label },
          now
        )
      } else {
        dismiss(
          tx,
          {
            kind: 'unlink',
            key: dismissedKey(item),
            nodeId: item.nodeId,
            label: item.label
          },
          now
        )
      }
      counts.dismissals += 1
    }

    // 7. The merges the author ticked, only among the pairs the dry run offered.
    const offered = new Set(model.merges.map((pair) => [pair.keep, pair.merge].sort().join('|')))
    const into = new Map<string, string>()
    const current = (id: string): string => {
      let at = id
      for (let next = into.get(at); next !== undefined; next = into.get(at)) at = next
      return at
    }
    for (const merge of consent.merges) {
      if (!offered.has([merge.keep, merge.merge].sort().join('|'))) continue
      const keepId = idOf(merge.keep)
      const mergeId = idOf(merge.merge)
      if (keepId === null || mergeId === null) continue
      const keep = current(keepId)
      const gone = current(mergeId)
      if (keep === gone) continue
      sameAs(tx, keep, gone, now)
      into.set(gone, keep)
      counts.merged += 1
    }
    unshareLoneConvertedNames(tx)

    // 8. The plan links the AI made come off (design Part 3); hers stay.
    dropAiPlanLinks(tx)

    // 9. The switch.
    setStoryMemory(tx, 'v2', now)
    return counts
  })
}
