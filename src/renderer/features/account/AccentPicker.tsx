import { ACCENTS } from '@shared/license'
import { useAccountStore } from './accountStore'

const SWATCH =
  'size-6 rounded-full border border-line-strong hover:border-fg aria-pressed:border-fg aria-pressed:ring-2 aria-pressed:ring-accent disabled:cursor-not-allowed disabled:opacity-40'

/** Said once, on every locked swatch, so the reason is where the pointer already is. */
const LOCKED = 'Supporter license needed'

/**
 * The accent colour (F-15.9): the one cosmetic extra the Supporter license unlocks. Six swatches
 * from `ACCENTS`; the pick goes to main, which writes it to `app-state.json` and answers the new
 * status, so `<html data-accent>` follows it app-wide (App.tsx) and `tokens.css` swaps the three
 * accent variables. Shown to everyone, with the five presets disabled without a license, because
 * a locked extra the author can see is the honest version of what the purchase is for. F-7.8
 * (themes) gates on the same flag and will move this beside the theme choice.
 */
export function AccentPicker(): React.JSX.Element {
  const supporter = useAccountStore((s) => s.supporter)
  const busy = useAccountStore((s) => s.supporterBusy)
  const setAccent = useAccountStore((s) => s.setAccent)
  // Unknown (nothing loaded yet) counts as locked: the extras only ever appear on a real license.
  const locked = supporter?.licensed !== true
  const current = supporter?.accent ?? 'default'

  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-fg-muted">
        {locked ? `Accent colour — ${LOCKED}` : 'Accent colour'}
      </span>
      <div role="group" aria-label="Accent colour" className="flex items-center gap-2">
        {ACCENTS.map((preset) => {
          const lockedHere = locked && preset.id !== 'default'
          return (
            <button
              key={preset.id}
              type="button"
              data-testid={`account-accent-${preset.id}`}
              aria-label={`${preset.label} accent`}
              aria-pressed={preset.id === current}
              title={lockedHere ? LOCKED : preset.label}
              disabled={busy || lockedHere}
              onClick={() => void setAccent(preset.id)}
              // The swatch has to be the colour it stands for; nothing else here is inline.
              style={{ backgroundColor: preset.accent }}
              className={SWATCH}
            />
          )
        })}
      </div>
    </div>
  )
}
