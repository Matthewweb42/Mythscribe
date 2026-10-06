import {
  IMPORT_TITLE_MAX,
  isDefaultSceneTitle,
  type ImportAiMarks,
  type ImportChapter,
  type ImportDraft,
  type ImportPart,
  type ImportPlacement,
  type ImportScene
} from '@shared/import'
import { flattenDraft, type StructureSuggestions } from '@shared/importStructure'

/**
 * Every edit the review dialog (F-12.2) makes to a structure draft, as pure functions: the draft
 * is a value main handed over and the renderer hands back, so nothing here mutates it and
 * nothing here talks to main. An edit that cannot apply (the first chapter moved up, a scene
 * merged with nothing before it, a split outside the paragraph range) answers the same draft
 * object, which is also how the dialog tells whether a button does anything.
 */

/** Where a node sits in the draft: its kind and the chain of containers above it. */
export type ImportLocation =
  | { kind: 'part'; part: ImportPart; partIndex: number }
  | {
      kind: 'chapter'
      part: ImportPart
      partIndex: number
      chapter: ImportChapter
      chapterIndex: number
    }
  | {
      kind: 'scene'
      part: ImportPart
      partIndex: number
      chapter: ImportChapter
      chapterIndex: number
      scene: ImportScene
      sceneIndex: number
    }

/** The node with that id and its place in the draft, or null when the id is not in it. */
export function findNode(draft: ImportDraft, id: string): ImportLocation | null {
  for (const [partIndex, part] of draft.parts.entries()) {
    if (part.id === id) return { kind: 'part', part, partIndex }
    for (const [chapterIndex, chapter] of part.chapters.entries()) {
      if (chapter.id === id) return { kind: 'chapter', part, partIndex, chapter, chapterIndex }
      for (const [sceneIndex, scene] of chapter.scenes.entries()) {
        if (scene.id === id) {
          return { kind: 'scene', part, partIndex, chapter, chapterIndex, scene, sceneIndex }
        }
      }
    }
  }
  return null
}

/** The part with the chapter list replaced. */
const withChapters = (part: ImportPart, chapters: ImportChapter[]): ImportPart => ({
  ...part,
  chapters
})

/** The chapter with the scene list replaced. */
const withScenes = (chapter: ImportChapter, scenes: ImportScene[]): ImportChapter => ({
  ...chapter,
  scenes
})

/** The draft with one part replaced at `index`. */
function replacePart(draft: ImportDraft, index: number, part: ImportPart): ImportDraft {
  const parts = [...draft.parts]
  parts[index] = part
  return { ...draft, parts }
}

/** The draft with one chapter replaced, inside its part. */
function replaceChapter(
  draft: ImportDraft,
  at: { partIndex: number; chapterIndex: number },
  chapter: ImportChapter
): ImportDraft {
  const part = draft.parts[at.partIndex]
  if (!part) return draft
  const chapters = [...part.chapters]
  chapters[at.chapterIndex] = chapter
  return replacePart(draft, at.partIndex, withChapters(part, chapters))
}

/** The item list with the item at `index` moved by `by`, or null when that would leave the list. */
function moved<T>(items: readonly T[], index: number, by: -1 | 1): T[] | null {
  const to = index + by
  if (to < 0 || to >= items.length) return null
  const next = [...items]
  const [item] = next.splice(index, 1)
  if (!item) return null
  next.splice(to, 0, item)
  return next
}

/** Renames a part, chapter, or scene. A blank title, or one that did not change, leaves the draft alone. */
export function renameNode(draft: ImportDraft, id: string, title: string): ImportDraft {
  const trimmed = title.trim().slice(0, IMPORT_TITLE_MAX)
  const found = findNode(draft, id)
  if (!found || trimmed.length === 0) return draft
  switch (found.kind) {
    case 'part':
      if (found.part.title === trimmed) return draft
      return replacePart(draft, found.partIndex, { ...found.part, title: trimmed })
    case 'chapter':
      if (found.chapter.title === trimmed) return draft
      return replaceChapter(draft, found, { ...found.chapter, title: trimmed })
    case 'scene': {
      if (found.scene.title === trimmed) return draft
      const scenes = [...found.chapter.scenes]
      scenes[found.sceneIndex] = { ...found.scene, title: trimmed }
      return replaceChapter(draft, found, withScenes(found.chapter, scenes))
    }
  }
}

/**
 * Sends a chapter to the manuscript, the front matter, or the back matter (F-2.6's sections).
 * A chapter already in the project stays in the manuscript: it is a folder with its own scenes,
 * tags, and notes, not text to flatten into one matter document.
 */
export function setPlacement(
  draft: ImportDraft,
  chapterId: string,
  placement: ImportPlacement
): ImportDraft {
  const found = findNode(draft, chapterId)
  if (found?.kind !== 'chapter' || found.chapter.placement === placement) return draft
  if (found.chapter.existing === true) return draft
  return replaceChapter(draft, found, { ...found.chapter, placement })
}

/** Moves a node one place up (-1) or down (1) among its siblings; at either end nothing happens. */
export function moveNode(draft: ImportDraft, id: string, by: -1 | 1): ImportDraft {
  const found = findNode(draft, id)
  if (!found) return draft
  switch (found.kind) {
    case 'part': {
      const parts = moved(draft.parts, found.partIndex, by)
      return parts ? { ...draft, parts } : draft
    }
    case 'chapter': {
      const chapters = moved(found.part.chapters, found.chapterIndex, by)
      return chapters
        ? replacePart(draft, found.partIndex, withChapters(found.part, chapters))
        : draft
    }
    case 'scene': {
      const scenes = moved(found.chapter.scenes, found.sceneIndex, by)
      return scenes ? replaceChapter(draft, found, withScenes(found.chapter, scenes)) : draft
    }
  }
}

/**
 * Nests a chapter under the part before it (as that part's last chapter) or after it (as that
 * part's first). Without a neighbouring part nothing happens; a part left with no chapters stays
 * in the draft — it is dropped at commit, and the author may still move chapters back into it.
 */
export function nestChapter(
  draft: ImportDraft,
  chapterId: string,
  to: 'prev' | 'next'
): ImportDraft {
  const found = findNode(draft, chapterId)
  if (found?.kind !== 'chapter') return draft
  const targetIndex = found.partIndex + (to === 'prev' ? -1 : 1)
  const target = draft.parts[targetIndex]
  if (!target) return draft
  const from = withChapters(
    found.part,
    found.part.chapters.filter((_, i) => i !== found.chapterIndex)
  )
  const into = withChapters(
    target,
    to === 'prev' ? [...target.chapters, found.chapter] : [found.chapter, ...target.chapters]
  )
  const parts = [...draft.parts]
  parts[found.partIndex] = from
  parts[targetIndex] = into
  return { ...draft, parts }
}

/** Every chapter of the draft in reading order, with the part it sits in. */
function chapterOrder(draft: ImportDraft): { partIndex: number; chapterIndex: number }[] {
  return draft.parts.flatMap((part, partIndex) =>
    part.chapters.map((_, chapterIndex) => ({ partIndex, chapterIndex }))
  )
}

/**
 * Moves a scene into the chapter before it (as that chapter's last scene) or after it (as its
 * first), across a part boundary as well. Without a neighbouring chapter nothing happens.
 */
export function moveScene(draft: ImportDraft, sceneId: string, to: 'prev' | 'next'): ImportDraft {
  const found = findNode(draft, sceneId)
  if (found?.kind !== 'scene') return draft
  const order = chapterOrder(draft)
  const at = order.findIndex(
    (entry) => entry.partIndex === found.partIndex && entry.chapterIndex === found.chapterIndex
  )
  const target = order[at + (to === 'prev' ? -1 : 1)]
  if (!target) return draft
  const targetChapter = draft.parts[target.partIndex]?.chapters[target.chapterIndex]
  if (!targetChapter) return draft
  const without = withScenes(
    found.chapter,
    found.chapter.scenes.filter((_, i) => i !== found.sceneIndex)
  )
  const into = withScenes(
    targetChapter,
    to === 'prev' ? [...targetChapter.scenes, found.scene] : [found.scene, ...targetChapter.scenes]
  )
  return replaceChapter(replaceChapter(draft, found, without), target, into)
}

/**
 * Merges a scene into the one before it in the same chapter: the paragraphs are appended and the
 * previous scene keeps its title (the author named the opening, not the tail). The first scene of
 * a chapter has nothing to merge with; move it to the previous chapter first.
 */
export function mergeScene(draft: ImportDraft, sceneId: string): ImportDraft {
  const found = findNode(draft, sceneId)
  if (found?.kind !== 'scene' || found.sceneIndex === 0) return draft
  const previous = found.chapter.scenes[found.sceneIndex - 1]
  if (!previous) return draft
  const scenes = [...found.chapter.scenes]
  scenes[found.sceneIndex - 1] = absorb(previous, [found.scene])
  scenes.splice(found.sceneIndex, 1)
  return replaceChapter(draft, found, withScenes(found.chapter, scenes))
}

/**
 * Merges a chapter into the one before it in the same part: its scenes are appended and the
 * previous chapter keeps its title and placement. The first chapter of a part has nothing to
 * merge with; move it to the previous part first.
 */
export function mergeChapter(draft: ImportDraft, chapterId: string): ImportDraft {
  const found = findNode(draft, chapterId)
  if (found?.kind !== 'chapter' || found.chapterIndex === 0) return draft
  const previous = found.part.chapters[found.chapterIndex - 1]
  if (!previous) return draft
  const chapters = [...found.part.chapters]
  chapters[found.chapterIndex - 1] = withScenes(previous, [
    ...previous.scenes,
    ...found.chapter.scenes
  ])
  chapters.splice(found.chapterIndex, 1)
  return replacePart(draft, found.partIndex, withChapters(found.part, chapters))
}

/** What a scene split off another is called; no renumbering, so the author sees where it came from. */
export const splitTitle = (title: string): string => `${title} (split)`.slice(0, IMPORT_TITLE_MAX)

/**
 * Splits a scene before the paragraph at `paragraphIndex`: the paragraphs from there on become a
 * new scene right after it, titled after the original, with an id minted from the draft's
 * counter. An index outside `1 … length - 1` leaves the draft alone (a split at 0 would only
 * rename the scene, one at the end would make an empty one).
 */
export function splitScene(
  draft: ImportDraft,
  sceneId: string,
  paragraphIndex: number
): ImportDraft {
  const found = findNode(draft, sceneId)
  if (found?.kind !== 'scene') return draft
  const { scene } = found
  if (!Number.isInteger(paragraphIndex)) return draft
  if (paragraphIndex < 1 || paragraphIndex >= scene.paragraphs.length) return draft
  const tail: ImportScene = {
    id: `${scene.id}-x${draft.nextId}`,
    title: splitTitle(scene.title),
    excluded: scene.excluded,
    paragraphs: scene.paragraphs.slice(paragraphIndex),
    tags: []
  }
  const scenes = [...found.chapter.scenes]
  scenes[found.sceneIndex] = { ...scene, paragraphs: scene.paragraphs.slice(0, paragraphIndex) }
  scenes.splice(found.sceneIndex + 1, 0, tail)
  const next = replaceChapter(draft, found, withScenes(found.chapter, scenes))
  return { ...next, nextId: draft.nextId + 1 }
}

/** The draft with one scene replaced, inside its chapter. */
function replaceScene(
  draft: ImportDraft,
  found: Extract<ImportLocation, { kind: 'scene' }>,
  scene: ImportScene
): ImportDraft {
  const scenes = [...found.chapter.scenes]
  scenes[found.sceneIndex] = scene
  return replaceChapter(draft, found, withScenes(found.chapter, scenes))
}

/** The scene with `sceneId` after `change`; an id that is not a scene leaves the draft alone. */
function updateScene(
  draft: ImportDraft,
  sceneId: string,
  change: (scene: ImportScene) => ImportScene
): ImportDraft {
  const found = findNode(draft, sceneId)
  if (found?.kind !== 'scene') return draft
  return replaceScene(draft, found, change(found.scene))
}

/**
 * Splits a chapter before `sceneId`: that scene and the ones after it become a new chapter right
 * after it in the same part, with the same placement and an id minted from the draft's counter.
 * A scene that already opens its chapter leaves the draft alone — the boundary is already there.
 */
function splitChapterAt(draft: ImportDraft, sceneId: string, ai: ImportAiMarks): ImportDraft {
  const found = findNode(draft, sceneId)
  if (found?.kind !== 'scene' || found.sceneIndex === 0) return draft
  const { chapter } = found
  const tail: ImportChapter = {
    id: `${chapter.id}-x${draft.nextId}`,
    title: splitTitle(chapter.title),
    excluded: chapter.excluded,
    placement: chapter.placement,
    scenes: chapter.scenes.slice(found.sceneIndex),
    ai
  }
  const chapters = [...found.part.chapters]
  chapters[found.chapterIndex] = withScenes(chapter, chapter.scenes.slice(0, found.sceneIndex))
  chapters.splice(found.chapterIndex + 1, 0, tail)
  const next = replacePart(draft, found.partIndex, withChapters(found.part, chapters))
  return { ...next, nextId: draft.nextId + 1 }
}

/** What `applyStructure` changed, for the dialog's "4 breaks added, 12 scenes titled" line. */
export interface StructureApplied {
  draft: ImportDraft
  /** Breaks that produced a new scene or chapter; one already on a boundary counts for nothing. */
  added: number
  /** Scenes whose default title the model's title replaced. */
  titled: number
}

/**
 * Merges the AI pass's suggestions (F-12.3) into the draft, as one more pure edit. Paragraph
 * indices are global over `flattenDraft`, so the breaks are applied from the highest down: a
 * split never moves the paragraphs before it, and every lower index still points at the same
 * paragraph. A scene or chapter the pass created is marked `ai.break` (with the model's reason)
 * so the dialog can badge it and offer Reject; a title only replaces a default `Scene N` one and
 * is marked `ai.title`. Tags are kept as candidates on the scene — nothing is linked here.
 */
export function applyStructure(
  draft: ImportDraft,
  suggestions: StructureSuggestions
): StructureApplied {
  let next = draft
  let added = 0
  const breaks = [...suggestions.breaks].sort((a, b) => b.before - a.before)
  for (const suggestion of breaks) {
    const at = flattenDraft(next)[suggestion.before]
    if (at === undefined) continue
    const ai: ImportAiMarks = { break: true, title: false, reason: suggestion.reason }
    let changed = next
    let sceneId = at.sceneId
    if (at.local > 0) {
      // The break falls inside a scene: cut it there, and the tail is the scene the pass added.
      const tailId = `${at.sceneId}-x${next.nextId}`
      const split = splitScene(next, at.sceneId, at.local)
      if (split !== next) {
        changed = updateScene(split, tailId, (scene) => ({ ...scene, ai }))
        sceneId = tailId
      }
    }
    if (suggestion.kind === 'chapter') changed = splitChapterAt(changed, sceneId, ai)
    // Nothing moved: the boundary the model asked for was already in the draft.
    if (changed === next) continue
    next = changed
    added += 1
  }

  let titled = 0
  const flat = flattenDraft(next)
  for (const scene of suggestions.scenes) {
    const at = flat[scene.start]
    // A title is for a scene that starts there; anything else is an index the splits moved past.
    if (at?.sceneStart !== true) continue
    const found = findNode(next, at.sceneId)
    if (found?.kind !== 'scene') continue
    const held = found.scene
    const title = scene.title === null ? '' : scene.title.trim().slice(0, IMPORT_TITLE_MAX)
    const tags = [...new Set(scene.tags)]
    const takesTitle = title.length > 0 && isDefaultSceneTitle(held.title)
    if (!takesTitle && tags.length === 0) continue
    next = replaceScene(next, found, {
      ...held,
      title: takesTitle ? title : held.title,
      tags: tags.length > 0 ? tags : held.tags,
      ai: takesTitle
        ? { break: held.ai?.break ?? false, title: true, reason: held.ai?.reason ?? null }
        : held.ai
    })
    if (takesTitle) titled += 1
  }
  return { draft: next, added, titled }
}

/**
 * Rejects one suggestion the pass made (F-12.3): the scene or chapter it added is merged back
 * into the one before it, so the text is exactly where it was. Anything else (a part, an id the
 * draft no longer holds) leaves the draft alone.
 */
export function rejectSuggestion(draft: ImportDraft, id: string): ImportDraft {
  const found = findNode(draft, id)
  if (found?.kind === 'scene') return mergeScene(draft, id)
  if (found?.kind === 'chapter') return mergeChapter(draft, id)
  return draft
}

/**
 * `into` with `from` appended in order: the paragraphs follow on, `into` keeps its id, title,
 * tags, and AI marks (the author named the opening, not the tail), and the existing scenes among
 * `from` (and whatever they had absorbed) are recorded as absorbed, so Import deletes those
 * nodes once their text is here and the dialog counts them as merged, not deleted.
 */
function absorb(into: ImportScene, from: readonly ImportScene[]): ImportScene {
  const absorbed = [
    ...(into.absorbed ?? []),
    ...from.flatMap((scene) => [
      ...(scene.existing === true ? [scene.id] : []),
      ...(scene.absorbed ?? [])
    ])
  ]
  return {
    ...into,
    paragraphs: [...into.paragraphs, ...from.flatMap((scene) => scene.paragraphs)],
    ...(absorbed.length > 0 ? { absorbed } : {})
  }
}

/** Every scene id in reading order. */
export function sceneIds(draft: ImportDraft): string[] {
  return draft.parts.flatMap((part) =>
    part.chapters.flatMap((chapter) => chapter.scenes.map((scene) => scene.id))
  )
}

/** Every chapter id in reading order. */
export function chapterIds(draft: ImportDraft): string[] {
  return draft.parts.flatMap((part) => part.chapters.map((chapter) => chapter.id))
}

/** The ids of one level in reading order: what a shift-click range selects over. */
export function idsOfKind(draft: ImportDraft, kind: ImportLocation['kind']): string[] {
  switch (kind) {
    case 'part':
      return draft.parts.map((part) => part.id)
    case 'chapter':
      return chapterIds(draft)
    case 'scene':
      return sceneIds(draft)
  }
}

/**
 * Takes parts, chapters, and scenes out of the draft (the row's ×, Delete selected). Whatever is
 * inside a removed container goes with it. Imported text removed here is simply not imported;
 * an existing node removed here is deleted at Import, which the dialog spells out first
 * (`existingChanges`). Ids not in the draft are ignored; removing nothing answers the same draft.
 */
export function removeNodes(draft: ImportDraft, ids: readonly string[]): ImportDraft {
  const gone = new Set(ids)
  let changed = false
  const parts = draft.parts.flatMap((part): ImportPart[] => {
    if (gone.has(part.id)) {
      changed = true
      return []
    }
    let partChanged = false
    const chapters = part.chapters.flatMap((chapter): ImportChapter[] => {
      if (gone.has(chapter.id)) {
        partChanged = true
        return []
      }
      const scenes = chapter.scenes.filter((scene) => !gone.has(scene.id))
      if (scenes.length === chapter.scenes.length) return [chapter]
      partChanged = true
      return [withScenes(chapter, scenes)]
    })
    if (!partChanged) return [part]
    changed = true
    return [withChapters(part, chapters)]
  })
  return changed ? { ...draft, parts } : draft
}

/**
 * Merges scenes into one (Merge into one scene): their paragraphs in reading order, wherever
 * they sit, become the first one's, which keeps its place, title, and id; the others leave the
 * draft (`absorb` records the existing ones). Fewer than two scenes answers the same draft.
 */
export function mergeScenes(draft: ImportDraft, ids: readonly string[]): ImportDraft {
  const wanted = new Set(ids)
  const order = sceneIds(draft).filter((id) => wanted.has(id))
  const [firstId, ...restIds] = order
  if (firstId === undefined || restIds.length === 0) return draft
  const rest = restIds.flatMap((id) => {
    const found = findNode(draft, id)
    return found?.kind === 'scene' ? [found.scene] : []
  })
  const without = removeNodes(draft, restIds)
  return updateScene(without, firstId, (scene) => absorb(scene, rest))
}

/**
 * Merges chapters into one: the first keeps its place, title, and placement, and the scenes of
 * the others follow its own in reading order; the other chapters leave the draft. Fewer than two
 * chapters answers the same draft.
 */
export function mergeChapters(draft: ImportDraft, ids: readonly string[]): ImportDraft {
  const wanted = new Set(ids)
  const order = chapterIds(draft).filter((id) => wanted.has(id))
  const [firstId, ...restIds] = order
  if (firstId === undefined || restIds.length === 0) return draft
  const moving = restIds.flatMap((id) => {
    const found = findNode(draft, id)
    return found?.kind === 'chapter' ? found.chapter.scenes : []
  })
  const without = removeNodes(draft, restIds)
  const found = findNode(without, firstId)
  if (found?.kind !== 'chapter') return draft
  return replaceChapter(
    without,
    found,
    withScenes(found.chapter, [...found.chapter.scenes, ...moving])
  )
}

/**
 * Merge with next: a scene takes in the scene after it in reading order (across a chapter
 * boundary too), a chapter the chapter after it. The last one has nothing to merge with.
 */
export function mergeWithNext(draft: ImportDraft, id: string): ImportDraft {
  const found = findNode(draft, id)
  if (found?.kind === 'scene') {
    const order = sceneIds(draft)
    const next = order[order.indexOf(id) + 1]
    return next === undefined ? draft : mergeScenes(draft, [id, next])
  }
  if (found?.kind === 'chapter') {
    const order = chapterIds(draft)
    const next = order[order.indexOf(id) + 1]
    return next === undefined ? draft : mergeChapters(draft, [id, next])
  }
  return draft
}

/**
 * Move up / Move down, the keyboard alternative to dragging: among its siblings first, and at
 * either end across into the neighbouring container (a scene to the end of the previous chapter
 * or the start of the next, a chapter likewise between parts). At the very ends nothing happens.
 */
export function shiftNode(draft: ImportDraft, id: string, by: -1 | 1): ImportDraft {
  const found = findNode(draft, id)
  if (!found) return draft
  const within = moveNode(draft, id, by)
  if (within !== draft || found.kind === 'part') return within
  const to = by < 0 ? 'prev' : 'next'
  return found.kind === 'scene' ? moveScene(draft, id, to) : nestChapter(draft, id, to)
}

/** Where a dragged row lands relative to the row it was dropped on. */
export type DropZone = 'before' | 'after' | 'into'

/**
 * Drag and drop: `id` lands before or after `targetId` when both are the same level, or at the
 * end of `targetId` when that is the level above (`into`: a scene into a chapter, a chapter into
 * a part). Anything else (a chapter dropped on a scene, a row on itself) answers the same draft.
 */
export function moveTo(
  draft: ImportDraft,
  id: string,
  targetId: string,
  zone: DropZone
): ImportDraft {
  if (id === targetId) return draft
  const source = findNode(draft, id)
  const target = findNode(draft, targetId)
  if (!source || !target) return draft
  const without = removeNodes(draft, [id])
  const at = findNode(without, targetId)
  if (!at) return draft

  if (source.kind === 'scene') {
    if (zone === 'into' && at.kind === 'chapter') {
      return replaceChapter(
        without,
        at,
        withScenes(at.chapter, [...at.chapter.scenes, source.scene])
      )
    }
    if (zone !== 'into' && at.kind === 'scene') {
      const scenes = [...at.chapter.scenes]
      scenes.splice(at.sceneIndex + (zone === 'after' ? 1 : 0), 0, source.scene)
      return replaceChapter(without, at, withScenes(at.chapter, scenes))
    }
    return draft
  }
  if (source.kind === 'chapter') {
    if (zone === 'into' && at.kind === 'part') {
      return replacePart(
        without,
        at.partIndex,
        withChapters(at.part, [...at.part.chapters, source.chapter])
      )
    }
    if (zone !== 'into' && at.kind === 'chapter') {
      const chapters = [...at.part.chapters]
      chapters.splice(at.chapterIndex + (zone === 'after' ? 1 : 0), 0, source.chapter)
      return replacePart(without, at.partIndex, withChapters(at.part, chapters))
    }
    return draft
  }
  if (zone !== 'into' && at.kind === 'part') {
    const parts = [...without.parts]
    parts.splice(at.partIndex + (zone === 'after' ? 1 : 0), 0, source.part)
    return { ...without, parts }
  }
  return draft
}
