/**
 * Scene references (F-16.18): "14.2" for the second scene of the fourteenth chapter, so the panel
 * and sheets can say "since 12.1" and "last stated in 13.4". Chapters are counted across parts as
 * compile counts them (every chapter-level node it compiles, in reading order, whether or not it
 * holds scenes). A chapter that is itself a document reads as its number ("14"). A scene outside
 * any chapter takes its title, or "Scene N" (its position in reading order) when it has none.
 * Pure: main feeds the compiled chapters and the readable scenes in reading order (`readingOrder`
 * names an Idea scene or one left out of compile by its title).
 */

export interface SceneRefRow {
  id: string
  title: string
  /** The nearest chapter-level ancestor (or the node itself when it is a chapter document); null outside any chapter. */
  chapterId: string | null
}

export interface SceneRefInput {
  /** Every chapter-level node compile counts, in reading order. */
  chapters: readonly string[]
  /** The scenes to number, in reading order. */
  scenes: readonly SceneRefRow[]
}

/** Each scene's reference, by node id. */
export function sceneRefs(input: SceneRefInput): Map<string, string> {
  const chapterNumber = new Map(input.chapters.map((id, index) => [id, index + 1]))
  const seen = new Map<string, number>()
  const refs = new Map<string, string>()
  input.scenes.forEach((scene, position) => {
    const number = scene.chapterId === null ? undefined : chapterNumber.get(scene.chapterId)
    if (number === undefined) {
      const title = scene.title.trim()
      refs.set(scene.id, title === '' ? `Scene ${position + 1}` : title)
      return
    }
    if (scene.id === scene.chapterId) {
      refs.set(scene.id, String(number))
      return
    }
    const nth = (seen.get(scene.chapterId ?? '') ?? 0) + 1
    seen.set(scene.chapterId ?? '', nth)
    refs.set(scene.id, `${number}.${nth}`)
  })
  return refs
}
