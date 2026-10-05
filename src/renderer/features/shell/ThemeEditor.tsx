import { useState } from 'react'
import {
  BUILT_IN_THEMES,
  CUSTOM_THEME_NAME_MAX,
  THEME_TOKENS,
  THEME_TOKEN_LABELS,
  BuiltInThemeId,
  builtInTheme,
  type CustomThemeInput,
  type ThemeColors,
  type ThemeToken
} from '@shared/themes'

const BUTTON =
  'shrink-0 rounded-md border border-line px-2 py-1 text-sm hover:bg-surface disabled:opacity-50 disabled:hover:bg-transparent'
const PRIMARY =
  'shrink-0 rounded-md bg-accent px-3 py-1 text-sm font-medium text-accent-fg hover:bg-accent-hover disabled:opacity-60'
const FIELD =
  'rounded-md border border-line bg-bg px-2 py-1 text-sm text-fg focus-visible:outline-2 focus-visible:outline-accent'

/** What the base is for, since the eight colours below are not the whole theme. */
const BASE_NOTE =
  'The base supplies everything the colours below do not: the accent shades, the status and ' +
  'tree colours, and whether scrollbars and form controls are light or dark.'

interface ThemeEditorProps {
  /** A new theme has no id; an existing one is replaced in place. */
  initial: CustomThemeInput
  onSave: (theme: CustomThemeInput) => void
  onCancel: () => void
  busy?: boolean
}

/**
 * The custom theme editor (F-7.8, a Supporter extra): a name, a built-in base, and the eight
 * surface and text colours from `THEME_TOKENS`, each a native colour input labelled as
 * `THEME_TOKEN_LABELS` names it. Nothing is applied until Save; main validates and stores it, and
 * the saved theme becomes the current one. A new theme follows its base's colours until a colour
 * is changed, so picking a base is also a quick way to start from it.
 */
export function ThemeEditor({
  initial,
  onSave,
  onCancel,
  busy = false
}: ThemeEditorProps): React.JSX.Element {
  const [name, setName] = useState(initial.name)
  const [base, setBase] = useState<BuiltInThemeId>(initial.base)
  const [colors, setColors] = useState<ThemeColors>(initial.colors)
  const [touched, setTouched] = useState(false)
  const isNew = initial.id === undefined
  const trimmed = name.trim()

  const changeBase = (next: BuiltInThemeId): void => {
    setBase(next)
    if (isNew && !touched) setColors({ ...builtInTheme(next).colors })
  }
  const changeColor = (token: ThemeToken, value: string): void => {
    setTouched(true)
    setColors((current) => ({ ...current, [token]: value.toLowerCase() }))
  }

  return (
    <form
      role="group"
      aria-label={isNew ? 'New theme' : 'Edit theme'}
      data-testid="theme-editor"
      className="flex flex-col gap-2 rounded-md border border-line p-3"
      onSubmit={(event) => {
        event.preventDefault()
        if (trimmed === '') return
        onSave({ ...(isNew ? {} : { id: initial.id }), name: trimmed, base, colors })
      }}
    >
      <div className="flex flex-wrap gap-3">
        <label className="flex min-w-40 flex-1 flex-col gap-1">
          <span className="text-xs text-fg-muted">Name</span>
          <input
            type="text"
            value={name}
            maxLength={CUSTOM_THEME_NAME_MAX}
            onChange={(event) => setName(event.target.value)}
            className={FIELD}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-fg-muted">Base</span>
          <select
            value={base}
            onChange={(event) => changeBase(BuiltInThemeId.parse(event.target.value))}
            className={FIELD}
          >
            {BUILT_IN_THEMES.map((theme) => (
              <option key={theme.id} value={theme.id}>
                {theme.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="m-0 text-xs text-fg-muted">{BASE_NOTE}</p>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
        {THEME_TOKENS.map((token) => (
          <label key={token} className="flex items-center gap-2">
            <input
              type="color"
              value={colors[token]}
              onChange={(event) => changeColor(token, event.target.value)}
              className="h-6 w-8 shrink-0 cursor-pointer rounded border border-line bg-transparent"
            />
            <span>{THEME_TOKEN_LABELS[token]}</span>
          </label>
        ))}
      </div>
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className={BUTTON}>
          Cancel
        </button>
        <button type="submit" disabled={busy || trimmed === ''} className={PRIMARY}>
          Save
        </button>
      </div>
    </form>
  )
}
