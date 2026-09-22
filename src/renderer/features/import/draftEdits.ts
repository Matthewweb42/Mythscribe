import {
  IMPORT_TITLE_MAX,
  type ImportChapter,
  type ImportDraft,
  type ImportPart,
  type ImportPlacement,
  type ImportScene
} from '@shared/import'

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
 * Keeps a node out of the import, or puts it back. Excluding a container excludes what is inside
 * it at commit; the children keep their own flags, so unexcluding the container restores them.
 */
export function setExcluded(draft: ImportDraft, id: string, excluded: boolean): ImportDraft {
  const found = findNode(draft, id)
  if (!found) return draft
  switch (found.kind) {
    case 'part':
      if (found.part.excluded === excluded) return draft
      return replacePart(draft, found.partIndex, { ...found.part, excluded })
    case 'chapter':
      if (found.chapter.excluded === excluded) return draft
      return replaceChapter(draft, found, { ...found.chapter, excluded })
    case 'scene': {
      if (found.scene.excluded === excluded) return draft
      const scenes = [...found.chapter.scenes]
      scenes[found.sceneIndex] = { ...found.scene, excluded }
      return replaceChapter(draft, found, withScenes(found.chapter, scenes))
    }
  }
}

/** Sends a chapter to the manuscript, the front matter, or the back matter (F-2.6's sections). */
export function setPlacement(
  draft: ImportDraft,
  chapterId: string,
  placement: ImportPlacement
): ImportDraft {
  const found = findNode(draft, chapterId)
  if (found?.kind !== 'chapter' || found.chapter.placement === placement) return draft
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
  scenes[found.sceneIndex - 1] = {
    ...previous,
    paragraphs: [...previous.paragraphs, ...found.scene.paragraphs]
  }
  scenes.splice(found.sceneIndex, 1)
  return replaceChapter(draft, found, withScenes(found.chapter, scenes))
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
    paragraphs: scene.paragraphs.slice(paragraphIndex)
  }
  const scenes = [...found.chapter.scenes]
  scenes[found.sceneIndex] = { ...scene, paragraphs: scene.paragraphs.slice(0, paragraphIndex) }
  scenes.splice(found.sceneIndex + 1, 0, tail)
  const next = replaceChapter(draft, found, withScenes(found.chapter, scenes))
  return { ...next, nextId: draft.nextId + 1 }
}
