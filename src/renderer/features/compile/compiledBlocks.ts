import type { CompiledEntry } from '@shared/compile'
import type { TiptapNodeT } from '@shared/tiptap'

/**
 * One block of the compiled text: a heading, a scene header, a scene break, or a document's text.
 * Built by `compiledBlocks` so the reading-order rules live in one pure place.
 */
export type Block =
  | { kind: 'heading'; entry: CompiledEntry; level: 'part' | 'chapter' }
  | { kind: 'meta'; entry: CompiledEntry }
  | { kind: 'break'; key: string }
  | { kind: 'text'; entry: CompiledEntry; content: TiptapNodeT }

/**
 * The compiled preview's blocks, in reading order (F-3.12): a part or chapter prints its title as
 * a heading (and a chapter document its text below it), a scene its metadata header when
 * `details` is on and it has something to show, a document its text. The scene-break text sits
 * between scenes that follow one another with no heading in between, the same rule as the
 * stacked view's manuscript separator. A generic folder prints nothing.
 */
export function compiledBlocks(entries: readonly CompiledEntry[], details: boolean): Block[] {
  const blocks: Block[] = []
  // True once body text (or a scene) has printed since the last heading.
  let afterBody = false
  for (const entry of entries) {
    if (entry.level === 'part' || entry.level === 'chapter') {
      blocks.push({ kind: 'heading', entry, level: entry.level })
      afterBody = false
    } else if (entry.level === 'scene' || entry.kind === 'document') {
      if (afterBody) blocks.push({ kind: 'break', key: `break-${entry.id}` })
      if (entry.level === 'scene' && details && (entry.meta !== null || entry.tags.length > 0))
        blocks.push({ kind: 'meta', entry })
      // A scene folder's own documents follow its header without a break before the first.
      afterBody = entry.kind === 'document'
    }
    if (entry.kind === 'document' && entry.content !== null)
      blocks.push({ kind: 'text', entry, content: entry.content })
  }
  return blocks
}
