import { useState } from 'react'
import { X } from 'lucide-react'
import { ALIAS_MAX, ALIASES_MAX, aliasKey, cleanAlias } from '@shared/aliases'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'

/**
 * The aliases of a tag or a sheet (F-4.14): one chip per other name (nickname, title, kept
 * spelling) with its remove button, and a field that adds one on Enter. Every change writes the
 * whole list through `onChange` (main normalizes it and refuses a name another tag owns, which
 * is toasted and leaves the field as typed). The Tags tab's tag detail and the story-bible page
 * both use it; a sheet linked to a tag shows and writes the tag's list (one owner).
 */
export function AliasEditor({
  name,
  aliases,
  onChange
}: {
  /** The main name, so typing it again is refused here rather than silently dropped by main. */
  name: string
  aliases: readonly string[]
  onChange: (next: string[]) => Promise<unknown>
}): React.JSX.Element {
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)

  const write = async (next: string[]): Promise<boolean> => {
    setBusy(true)
    try {
      await onChange(next)
      return true
    } catch (err) {
      toast.error(describeError(err))
      return false
    } finally {
      setBusy(false)
    }
  }

  const add = async (): Promise<void> => {
    const alias = cleanAlias(draft)
    const key = aliasKey(alias)
    if (busy || key === '') return
    if (key === aliasKey(name) || aliases.some((each) => aliasKey(each) === key)) {
      setDraft('')
      return
    }
    if (await write([...aliases, alias])) setDraft('')
  }

  return (
    <div role="group" aria-label="Aliases" className="flex flex-col gap-1">
      <span className="text-xs text-fg-muted">Also known as</span>
      {aliases.length > 0 ? (
        <ul role="list" className="m-0 flex list-none flex-wrap gap-1 p-0">
          {aliases.map((alias) => (
            <li
              key={alias}
              className="flex items-center gap-1 rounded-full border border-line bg-surface-raised py-0.5 pr-1 pl-2 text-xs"
            >
              <span className="max-w-48 truncate">{alias}</span>
              <button
                type="button"
                aria-label={`Remove alias ${alias}`}
                disabled={busy}
                onClick={() => void write(aliases.filter((each) => each !== alias))}
                className="rounded-full p-0.5 text-fg-muted hover:bg-surface hover:text-fg disabled:opacity-50"
              >
                <X size={12} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {aliases.length < ALIASES_MAX ? (
        <input
          aria-label="Add alias"
          placeholder="Add a nickname or title, then Enter"
          value={draft}
          maxLength={ALIAS_MAX}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              void add()
            } else if (event.key === 'Escape') {
              event.preventDefault()
              setDraft('')
            }
          }}
          className="min-w-0 rounded-md border border-line bg-bg px-2 py-1 text-sm"
        />
      ) : null}
    </div>
  )
}
