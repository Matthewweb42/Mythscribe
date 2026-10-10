import { useState } from 'react'
import {
  BUILT_IN_THEMES,
  CUSTOM_THEMES_MAX,
  builtInTheme,
  resolveTheme,
  themeNeedsLicense,
  type CustomThemeInput,
  type ThemeColors
} from '@shared/themes'
import { useExtrasUnlocked } from '@renderer/features/account/appAccessStore'
import { dialogs } from '@renderer/features/shell/dialogs/dialogStore'
import { ThemeEditor } from './ThemeEditor'
import { useViewStore } from './viewStore'

const BUTTON =
  'shrink-0 rounded-md border border-line px-2 py-1 text-sm hover:bg-surface disabled:opacity-50 disabled:hover:bg-transparent'
const CARD =
  'flex w-32 flex-col gap-1 rounded-md border border-line p-1.5 text-left hover:bg-surface focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent aria-checked:border-accent aria-checked:bg-surface-raised'

/** Said on every locked card, so the reason is where the pointer already is. */
const LOCKED = 'MythScribe license needed'

const THEME_NOTE =
  'Colours the whole window, the page included. Also under View › Switch theme, which steps ' +
  'through the themes you can use.'

/** A card's preview: the desk, the sheet with two lines of text on it, and the accent. */
function Preview({ colors, accent }: { colors: ThemeColors; accent: string }): React.JSX.Element {
  // The preview has to be the colours it stands for; these are the only inline values here.
  return (
    <span
      aria-hidden="true"
      className="flex h-10 items-center gap-1.5 rounded border px-1.5"
      style={{ backgroundColor: colors.desk, borderColor: colors.line }}
    >
      <span
        className="flex h-7 flex-1 flex-col justify-center gap-1 rounded-sm px-1.5"
        style={{ backgroundColor: colors.sheet }}
      >
        <span className="h-1 w-4/5 rounded-full" style={{ backgroundColor: colors.fg }} />
        <span className="h-1 w-3/5 rounded-full" style={{ backgroundColor: colors.fgMuted }} />
      </span>
      <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: accent }} />
    </span>
  )
}

/**
 * The theme choice (F-7.8) on the Appearance tab: a card per built-in theme and per custom theme,
 * each with a preview drawn from its colours. The checked card is the theme being painted, so a
 * locked choice kept from a lapsed license shows Dark checked. Sepia and custom themes are
 * paid extras: on during the trial and with the license, shown but disabled after the trial
 * ends unpaid (changed by the author 2026-10-10). The custom theme editor opens in
 * place for New and Edit; Delete asks first and is allowed without the license, so a lapsed
 * author can still tidy up.
 */
export function ThemePicker(): React.JSX.Element {
  const theme = useViewStore((s) => s.theme)
  const customThemes = useViewStore((s) => s.customThemes)
  const setTheme = useViewStore((s) => s.setTheme)
  const saveCustomTheme = useViewStore((s) => s.saveCustomTheme)
  const deleteCustomTheme = useViewStore((s) => s.deleteCustomTheme)
  const unlocked = useExtrasUnlocked()
  const [editing, setEditing] = useState<CustomThemeInput | null>(null)
  const [saving, setSaving] = useState(false)

  const resolved = resolveTheme({ theme, customThemes }, unlocked)
  // Edit and Delete act on the stored custom theme, painted or not.
  const selectedCustom = customThemes.find((t) => t.id === theme) ?? null
  const full = customThemes.length >= CUSTOM_THEMES_MAX

  const startNew = (): void => {
    setEditing({
      name: `Custom theme ${customThemes.length + 1}`,
      base: resolved.base.id,
      colors: { ...(resolved.overrides ?? resolved.base.colors) }
    })
  }
  const save = async (input: CustomThemeInput): Promise<void> => {
    setSaving(true)
    const ok = await saveCustomTheme(input)
    setSaving(false)
    if (ok) setEditing(null)
  }
  const remove = async (): Promise<void> => {
    if (!selectedCustom) return
    const confirmed = await dialogs.confirm({
      title: 'Delete theme',
      message: `Delete “${selectedCustom.name}”? The window goes back to its base theme, ${builtInTheme(selectedCustom.base).label}.`,
      confirmLabel: 'Delete',
      danger: true
    })
    if (confirmed) await deleteCustomTheme(selectedCustom.id)
  }

  const cards = [
    ...BUILT_IN_THEMES.map((t) => ({
      id: t.id,
      label: t.label,
      colors: t.colors,
      accent: t.accent
    })),
    ...customThemes.map((t) => ({
      id: t.id,
      label: t.name,
      colors: t.colors,
      accent: builtInTheme(t.base).accent
    }))
  ]

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs text-fg-muted">Theme</span>
      <div role="radiogroup" aria-label="Theme" className="flex flex-wrap gap-2">
        {cards.map((card) => {
          const locked = !unlocked && themeNeedsLicense(card.id)
          return (
            <button
              key={card.id}
              type="button"
              role="radio"
              data-testid={`appearance-theme-${card.id}`}
              aria-checked={card.id === resolved.id}
              aria-label={card.label}
              title={locked ? LOCKED : card.label}
              disabled={locked}
              onClick={() => void setTheme(card.id)}
              className={CARD}
            >
              <Preview colors={card.colors} accent={card.accent} />
              <span className="truncate text-sm font-medium">{card.label}</span>
              {locked ? <span className="text-xs text-fg-muted">{LOCKED}</span> : null}
            </button>
          )
        })}
      </div>
      {editing === null ? (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            data-testid="appearance-theme-new"
            disabled={!unlocked || full}
            title={
              !unlocked ? LOCKED : full ? `At most ${CUSTOM_THEMES_MAX} custom themes` : undefined
            }
            onClick={startNew}
            className={BUTTON}
          >
            New theme…
          </button>
          {selectedCustom === null ? null : (
            <>
              <button
                type="button"
                data-testid="appearance-theme-edit"
                disabled={!unlocked}
                title={unlocked ? undefined : LOCKED}
                onClick={() =>
                  setEditing({ ...selectedCustom, colors: { ...selectedCustom.colors } })
                }
                className={BUTTON}
              >
                Edit “{selectedCustom.name}”…
              </button>
              <button
                type="button"
                data-testid="appearance-theme-delete"
                onClick={() => void remove()}
                className={BUTTON}
              >
                Delete
              </button>
            </>
          )}
          {unlocked ? null : (
            <span className="text-xs text-fg-muted">{`Sepia and custom themes — ${LOCKED}`}</span>
          )}
        </div>
      ) : (
        <ThemeEditor
          key={editing.id ?? 'new'}
          initial={editing}
          busy={saving}
          onSave={(input) => void save(input)}
          onCancel={() => setEditing(null)}
        />
      )}
      <p className="m-0 text-xs text-fg-muted">{THEME_NOTE}</p>
    </div>
  )
}
