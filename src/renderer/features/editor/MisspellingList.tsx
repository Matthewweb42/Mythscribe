import { useDeferredValue, useEffect, useMemo, useState } from 'react'
import type { Node as PmNode } from '@tiptap/pm/model'
import { Check, X } from 'lucide-react'
import type { MentionRange } from '@shared/mentions'
import {
  findMisspellings,
  groupMisspellings,
  type MisspellingGroup,
  type SpellingCandidate
} from '@shared/misspellings'
import { useEntityStore } from '@renderer/features/entities/entityStore'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { useKeptSpellingStore } from '@renderer/features/tags/keptSpellingStore'
import { useTagStore } from '@renderer/features/tags/tagStore'
import { describeError } from '@renderer/lib/errors'
import { editorFor } from './activeEditorStore'
import { useDocumentStore } from './documentStore'
import { openPassage, PASSAGE_GONE_MESSAGE } from './openPassage'

/**
 * Likely misspellings of story names in the open document (F-4.14): "Rynna Falseer" where the
 * bank knows `rynna-falsire`. Found locally on the live text (no AI, nothing sent), each offered
 * as a fix the author approves — whatever the AI dial says, this is the one path of the alias
 * work that changes scene text, and only on a click. Fix replaces every occurrence of that
 * spelling in this document in one undoable step; Not a typo keeps the spelling for the project
 * (it may then be proposed as a tag of its own, F-4.12b). Clicking the spelling selects it.
 */
export function MisspellingList({ id }: { id: string }): React.JSX.Element | null {
  const content = useDocumentStore((s) => s.docs[id]?.content ?? null)
  // The check walks the whole document; typing must never wait for it.
  const deferred = useDeferredValue(content)
  const bank = useTagStore((s) => s.byId)
  const entities = useEntityStore((s) => s.byId)
  const kept = useKeptSpellingStore((s) => s.keys)
  const loaded = useKeptSpellingStore((s) => s.loaded)
  const groups = useMemo(() => {
    if (deferred === null) return []
    const spelled = new Map<string, string>()
    for (const entity of Object.values(entities)) {
      if (entity.tagId !== null && !spelled.has(entity.tagId))
        spelled.set(entity.tagId, entity.name)
    }
    const candidates: SpellingCandidate[] = Object.values(bank)
      .filter((tag) => tag.trackMentions)
      .map((tag) => ({
        id: tag.id,
        name: tag.name,
        category: tag.category,
        aliases: tag.aliases,
        display: spelled.get(tag.id)
      }))
    return groupMisspellings(findMisspellings(deferred, candidates, new Set(kept)))
  }, [deferred, bank, entities, kept])

  // The kept spellings are read the first time there is anything to offer, so a book without
  // misspellings never asks; nothing is shown until they are in, so a kept one never flashes.
  const hasAny = groups.length > 0
  useEffect(() => {
    if (!hasAny) return
    useKeptSpellingStore
      .getState()
      .ensureLoaded()
      .catch((err: unknown) => toast.error(describeError(err)))
  }, [hasAny])

  if (!loaded || groups.length === 0) return null
  return (
    <>
      <p className="mt-2 mb-1 text-xs text-fg-subtle">Possible misspellings</p>
      <ul
        role="list"
        aria-label="Possible misspellings"
        className="m-0 flex list-none flex-col gap-1 p-0"
      >
        {groups.map((group) => (
          <MisspellingRow key={`${group.tagId}:${group.text}`} nodeId={id} group={group} />
        ))}
      </ul>
    </>
  )
}

/** Whether `range` of the live document still reads `text`: the stored positions may have moved. */
function stillReads(doc: PmNode, [from, to]: MentionRange, text: string): boolean {
  return to <= doc.content.size && doc.textBetween(from, to, ' ') === text
}

function MisspellingRow({
  nodeId,
  group
}: {
  nodeId: string
  group: MisspellingGroup
}): React.JSX.Element {
  const [busy, setBusy] = useState(false)

  /** Every occurrence that still reads as written, replaced last to first in one transaction. */
  const fix = async (): Promise<void> => {
    setBusy(true)
    try {
      const editor = await editorFor(nodeId)
      if (editor === null || editor.isDestroyed) return
      const ranges = group.ranges
        .filter((range) => stillReads(editor.state.doc, range, group.text))
        .sort((a, b) => b[0] - a[0])
      if (ranges.length === 0) {
        toast.error(PASSAGE_GONE_MESSAGE)
        return
      }
      editor
        .chain()
        .command(({ tr }) => {
          for (const [from, to] of ranges) tr.insertText(group.suggestion, from, to)
          return true
        })
        .run()
    } finally {
      setBusy(false)
    }
  }

  const keep = async (): Promise<void> => {
    setBusy(true)
    try {
      await useKeptSpellingStore.getState().keep(group.text)
    } catch (err) {
      toast.error(describeError(err))
    } finally {
      setBusy(false)
    }
  }

  const first = group.ranges[0]
  return (
    <li
      role="listitem"
      data-testid="misspelling"
      className="flex items-center gap-1.5 rounded-md border border-dashed border-line py-0.5 pr-1 pl-2 text-xs"
    >
      <button
        type="button"
        title="Show it in the text"
        onClick={() => {
          if (first === undefined) return
          void openPassage(nodeId, (doc) =>
            stillReads(doc, first, group.text) ? { from: first[0], to: first[1] } : null
          )
        }}
        className="min-w-0 flex-1 truncate text-left hover:underline"
      >
        <span className="line-through decoration-danger">{group.text}</span> → {group.suggestion}
        {group.ranges.length > 1 ? (
          <span className="ml-1 text-fg-subtle tabular-nums">×{group.ranges.length}</span>
        ) : null}
      </button>
      <button
        type="button"
        aria-label={`Fix ${group.text} to ${group.suggestion}`}
        title="Replace it in this document"
        disabled={busy}
        onClick={() => void fix()}
        className="rounded-full p-0.5 text-fg-muted hover:bg-surface-raised hover:text-fg disabled:opacity-40"
      >
        <Check size={12} aria-hidden="true" />
      </button>
      <button
        type="button"
        aria-label={`Keep ${group.text}`}
        title="Not a typo: never offer this spelling again"
        disabled={busy}
        onClick={() => void keep()}
        className="rounded-full p-0.5 text-fg-muted hover:bg-surface-raised hover:text-fg disabled:opacity-40"
      >
        <X size={12} aria-hidden="true" />
      </button>
    </li>
  )
}
