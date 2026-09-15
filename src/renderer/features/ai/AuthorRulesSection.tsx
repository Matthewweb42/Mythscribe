import { useId, useState } from 'react'
import {
  AUTHOR_RULES_TEXT_MAX,
  BANNED_PHRASES_MAX,
  BANNED_PHRASE_MAX,
  DEFAULT_BANNED_PHRASES,
  normalizeBannedPhrases
} from '@shared/authorRules'
import { useAuthorRulesStore } from './authorRulesStore'

const BUTTON =
  'shrink-0 rounded-md border border-line px-2 py-1 text-xs hover:bg-surface disabled:opacity-50 disabled:hover:bg-transparent'
const FIELD = 'min-w-0 flex-1 rounded-md border border-line bg-bg px-2 py-1 text-sm'

/**
 * The "Author rules" section of the AI tab (F-14.2), under the voice profile: the free-text
 * style rules and the banned-phrases list, both hard constraints in every prompt that carries
 * the voice block and a post-filter on the answer. Typing goes through the store, which writes
 * once after the shared debounce and refreshes the voice profile so the block shown above stays
 * current. Adding a phrase that is empty, a duplicate, or too long does nothing: the shared
 * `normalizeBannedPhrases` decides, so the panel and the stored value can never disagree.
 * Nothing renders until the project's rules have loaded.
 */
export function AuthorRulesSection(): React.JSX.Element | null {
  const settings = useAuthorRulesStore((s) => s.settings)
  const update = useAuthorRulesStore((s) => s.update)
  const [draft, setDraft] = useState('')
  const headingId = useId()
  const rulesCountId = useId()

  if (settings === null) return null
  const { rules, bannedPhrases } = settings
  const full = bannedPhrases.length >= BANNED_PHRASES_MAX
  const missingDefaults = DEFAULT_BANNED_PHRASES.some(
    (phrase) => !bannedPhrases.some((kept) => kept.toLowerCase() === phrase.toLowerCase())
  )

  const add = (): void => {
    const next = normalizeBannedPhrases([...bannedPhrases, draft])
    if (next.length === bannedPhrases.length) return // empty, duplicate, too long, or full
    update({ bannedPhrases: next })
    setDraft('')
  }

  const remove = (phrase: string): void => {
    update({ bannedPhrases: bannedPhrases.filter((kept) => kept !== phrase) })
  }

  const restore = (): void => {
    update({ bannedPhrases: normalizeBannedPhrases([...bannedPhrases, ...DEFAULT_BANNED_PHRASES]) })
  }

  return (
    <section
      aria-labelledby={headingId}
      data-testid="author-rules-section"
      className="flex min-w-0 flex-col gap-3"
    >
      <h3 id={headingId} className="m-0 text-sm font-medium">
        Author rules
      </h3>
      <p className="m-0 text-xs text-fg-muted">
        Hard constraints sent with every ghost-text and Agent request. A continuation that uses a
        banned phrase is asked for again once, then shown with a warning.
      </p>

      <div className="flex flex-col gap-1">
        <textarea
          aria-label="Style rules"
          aria-describedby={rulesCountId}
          rows={3}
          maxLength={AUTHOR_RULES_TEXT_MAX}
          placeholder="No rhetorical questions in narration. Mira never swears. British spelling."
          value={rules}
          onChange={(event) => update({ rules: event.target.value })}
          className="w-full rounded-md border border-line bg-bg px-2 py-1 text-sm"
        />
        <p id={rulesCountId} className="m-0 text-right text-xs text-fg-muted tabular-nums">
          {rules.length} / {AUTHOR_RULES_TEXT_MAX}
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="font-medium">Banned phrases</span>
          <button type="button" onClick={restore} disabled={!missingDefaults} className={BUTTON}>
            Restore default phrases
          </button>
        </div>

        {bannedPhrases.length > 0 ? (
          <ul
            role="list"
            aria-label="Banned phrases"
            className="m-0 flex list-none flex-wrap gap-1.5 p-0"
          >
            {bannedPhrases.map((phrase) => (
              <li
                key={phrase}
                className="flex min-w-0 items-center gap-1 rounded-md border border-line px-2 py-0.5 text-xs"
              >
                <span className="min-w-0 break-words">{phrase}</span>
                <button
                  type="button"
                  aria-label={`Remove phrase ${phrase}`}
                  onClick={() => remove(phrase)}
                  className="shrink-0 rounded px-1 text-fg-muted hover:text-fg"
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="m-0 text-xs text-fg-muted">No banned phrases.</p>
        )}

        <div className="flex items-center gap-2">
          <input
            type="text"
            aria-label="New banned phrase"
            placeholder="Add a phrase"
            autoComplete="off"
            spellCheck={false}
            maxLength={BANNED_PHRASE_MAX}
            value={draft}
            disabled={full}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                add()
              }
            }}
            className={FIELD}
          />
          <button
            type="button"
            onClick={add}
            disabled={full || draft.trim().length === 0}
            className={BUTTON}
          >
            Add
          </button>
        </div>
        <p className="m-0 text-xs text-fg-muted tabular-nums">
          {bannedPhrases.length} of {BANNED_PHRASES_MAX}
        </p>
      </div>
    </section>
  )
}
