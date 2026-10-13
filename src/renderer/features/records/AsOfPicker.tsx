import { useId } from 'react'
import type { AsOfScene } from './asOf'

/**
 * The **as of [scene ▾]** picker (F-16.18, F-16.22): one control for every view that reads the
 * book up to a scene (a sheet's From the book, Knows and The secret, the Book tab's who knows
 * what). It lists the manuscript's scenes in reading order and "the end of the book"; it starts on
 * the scene open in the editor, else the end of the book (`useAsOf`).
 */
export function AsOfPicker({
  scenes,
  value,
  onChange,
  label = 'as of'
}: {
  scenes: readonly AsOfScene[]
  value: string | null
  onChange: (asOf: string | null) => void
  label?: string
}): React.JSX.Element {
  const pickId = useId()
  return (
    <>
      <label htmlFor={pickId} className="text-xs text-fg-muted">
        {label}
      </label>
      <select
        id={pickId}
        value={value ?? ''}
        onChange={(event) => onChange(event.target.value === '' ? null : event.target.value)}
        className="max-w-56 min-w-0 rounded-md border border-line bg-bg px-1 py-0.5 text-xs"
      >
        <option value="">the end of the book</option>
        {scenes.map((scene) => (
          <option key={scene.id} value={scene.id}>
            {scene.title}
          </option>
        ))}
      </select>
    </>
  )
}
