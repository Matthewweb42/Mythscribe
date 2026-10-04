import { useEffect, useMemo, useReducer, useRef, useState } from 'react'
import type { Editor } from '@tiptap/core'
import { ChevronDown, ChevronRight, ChevronUp, X } from 'lucide-react'
import type { FindOptions } from '@shared/findInDocument'
import { REPLACE_QUERY_MAX, REPLACEMENT_MAX } from '@shared/replace'
import { useActiveEditorStore } from './activeEditorStore'
import { FIND_MATCH_CURRENT_CLASS, findStateOf } from './findReplace'
import { useFindStore } from './findStore'

/** What the bar says with no document to search (an entity page, an empty folder). */
export const FIND_NO_EDITOR = 'Open a document to search it'

const INPUT_CLASS =
  'w-full min-w-0 rounded-md border border-line bg-surface px-2 py-1 text-sm text-fg outline-none placeholder:text-fg-subtle focus:border-accent'
const ICON_BUTTON_CLASS =
  'rounded-md p-1 text-fg-muted hover:bg-surface hover:text-fg disabled:opacity-40 disabled:hover:bg-transparent'
const TOGGLE_CLASS =
  'rounded-md px-1.5 py-0.5 font-mono text-xs text-fg-muted hover:bg-surface hover:text-fg aria-pressed:bg-accent aria-pressed:text-accent-fg'
const TEXT_BUTTON_CLASS =
  'shrink-0 rounded-md border border-line px-2 py-1 text-xs hover:bg-surface disabled:opacity-50'

/** Scrolls the current match into view; the editor keeps or lacks focus as it was. */
function revealCurrent(editor: Editor): void {
  const element = editor.view.dom.querySelector(`.${FIND_MATCH_CURRENT_CLASS}`)
  if (element instanceof HTMLElement && typeof element.scrollIntoView === 'function') {
    element.scrollIntoView({ block: 'nearest' })
  }
}

/**
 * Find and replace in the open document (F-3.10): a bar docked above the editor's toolbar, opened by
 * Ctrl+F / Ctrl+H or Edit › Find… / Replace…. It searches the active editor (the single document,
 * or the region of a stack that last had focus), pushing the store's options to that editor's
 * `FindReplace` extension whenever they or the active editor change, and clearing them from an
 * editor it leaves and on close. The count and the current match are read from the editor's
 * plugin state, re-read on each of its transactions.
 */
export function FindBar(): React.JSX.Element | null {
  const open = useFindStore((s) => s.open)
  const showReplace = useFindStore((s) => s.showReplace)
  const query = useFindStore((s) => s.query)
  const replacement = useFindStore((s) => s.replacement)
  const matchCase = useFindStore((s) => s.matchCase)
  const wholeWord = useFindStore((s) => s.wholeWord)
  const regex = useFindStore((s) => s.regex)
  const focusTick = useFindStore((s) => s.focusTick)
  const store = useFindStore.getState()
  const active = useActiveEditorStore((s) => s.active)
  const editor = active !== null && !active.editor.isDestroyed ? active.editor : null

  const options = useMemo<FindOptions>(
    () => ({ query, matchCase, wholeWord, regex }),
    [query, matchCase, wholeWord, regex]
  )
  /** Where current starts from: the selection when the bar opened on this editor. */
  const anchor = useRef<{ editor: Editor; tick: number; pos: number } | null>(null)
  /** What the last Replace all did, shown while the options it ran with are unchanged. */
  const [replaced, setReplaced] = useState<{ count: number; options: FindOptions } | null>(null)
  const findInput = useRef<HTMLInputElement>(null)
  const [, rerender] = useReducer((n: number) => n + 1, 0)

  useEffect(() => {
    if (!open || editor === null) return
    editor.on('transaction', rerender)
    return () => {
      editor.off('transaction', rerender)
    }
  }, [open, editor])

  useEffect(() => {
    if (!open || editor === null) return
    const held = anchor.current
    const pos =
      held !== null && held.editor === editor && held.tick === focusTick
        ? held.pos
        : editor.state.selection.from
    anchor.current = { editor, tick: focusTick, pos }
    editor.commands.setFind(options, pos)
    revealCurrent(editor)
    return () => {
      if (!editor.isDestroyed) editor.commands.setFind(null)
    }
  }, [open, editor, options, focusTick])

  useEffect(() => {
    if (!open) return
    findInput.current?.focus()
    findInput.current?.select()
  }, [open, focusTick])

  if (!open) return null

  const find = editor === null ? null : findStateOf(editor.state)
  const count = find?.matches.length ?? 0
  const status =
    editor === null
      ? FIND_NO_EDITOR
      : replaced !== null && replaced.options === options
        ? `Replaced ${replaced.count}`
        : (find?.error ??
          (query === ''
            ? ''
            : count === 0
              ? 'No results'
              : `${(find?.current ?? -1) + 1} of ${count}`))
  const canStep = editor !== null && count > 0

  const step = (direction: 1 | -1): void => {
    if (editor === null) return
    setReplaced(null)
    if (editor.commands.findStep(direction)) revealCurrent(editor)
  }
  const replaceOne = (): void => {
    if (editor === null) return
    setReplaced(null)
    if (editor.commands.replaceMatch(replacement)) revealCurrent(editor)
  }
  const replaceAll = (): void => {
    if (editor === null || count === 0) return
    if (editor.commands.replaceAllMatches(replacement)) setReplaced({ count, options })
  }
  const close = (): void => {
    store.close()
    if (editor !== null) editor.commands.focus()
  }

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key !== 'Escape') return
    // Claimed, so the focus-mode Escape (F-6.1) leaves the author where they are.
    event.preventDefault()
    event.stopPropagation()
    close()
  }

  return (
    <div
      role="search"
      aria-label="Find in document"
      onKeyDown={onKeyDown}
      className="my-1.5 mr-4 ml-auto flex w-[26rem] max-w-[calc(100%-2rem)] shrink-0 flex-col gap-1.5 rounded-md border border-line bg-surface-raised p-2 text-sm"
    >
      <div className="flex items-center gap-1">
        <button
          type="button"
          aria-label="Toggle replace"
          title="Toggle replace"
          aria-expanded={showReplace}
          onClick={() => store.setShowReplace(!showReplace)}
          className={ICON_BUTTON_CLASS}
        >
          {showReplace ? (
            <ChevronDown size={14} aria-hidden="true" />
          ) : (
            <ChevronRight size={14} aria-hidden="true" />
          )}
        </button>
        <input
          ref={findInput}
          aria-label="Find"
          placeholder="Find"
          value={query}
          maxLength={REPLACE_QUERY_MAX}
          onChange={(event) => store.setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return
            event.preventDefault()
            step(event.shiftKey ? -1 : 1)
          }}
          className={INPUT_CLASS}
        />
        <span
          role="status"
          data-testid="find-status"
          className="w-24 shrink-0 truncate text-center text-xs text-fg-muted"
          title={status}
        >
          {status}
        </span>
        <button
          type="button"
          aria-label="Match case"
          title="Match case"
          aria-pressed={matchCase}
          onClick={() => store.setMatchCase(!matchCase)}
          className={TOGGLE_CLASS}
        >
          Aa
        </button>
        <button
          type="button"
          aria-label="Whole word"
          title="Whole word"
          aria-pressed={wholeWord}
          onClick={() => store.setWholeWord(!wholeWord)}
          className={TOGGLE_CLASS}
        >
          ab|
        </button>
        <button
          type="button"
          aria-label="Regular expression"
          title="Regular expression"
          aria-pressed={regex}
          onClick={() => store.setRegex(!regex)}
          className={TOGGLE_CLASS}
        >
          .*
        </button>
        <button
          type="button"
          aria-label="Previous match"
          title="Previous match (Shift+Enter)"
          disabled={!canStep}
          onClick={() => step(-1)}
          className={ICON_BUTTON_CLASS}
        >
          <ChevronUp size={14} aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label="Next match"
          title="Next match (Enter)"
          disabled={!canStep}
          onClick={() => step(1)}
          className={ICON_BUTTON_CLASS}
        >
          <ChevronDown size={14} aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label="Close find"
          title="Close (Escape)"
          onClick={close}
          className={ICON_BUTTON_CLASS}
        >
          <X size={14} aria-hidden="true" />
        </button>
      </div>
      {showReplace ? (
        <div className="flex items-center gap-1 pl-6">
          <input
            aria-label="Replace with"
            placeholder="Replace"
            value={replacement}
            maxLength={REPLACEMENT_MAX}
            onChange={(event) => store.setReplacement(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return
              event.preventDefault()
              replaceOne()
            }}
            className={INPUT_CLASS}
          />
          <button
            type="button"
            disabled={!canStep}
            onClick={replaceOne}
            className={TEXT_BUTTON_CLASS}
          >
            Replace
          </button>
          <button
            type="button"
            disabled={!canStep}
            onClick={replaceAll}
            className={TEXT_BUTTON_CLASS}
          >
            Replace all
          </button>
        </div>
      ) : null}
    </div>
  )
}
