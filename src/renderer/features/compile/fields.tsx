import { useId, useState, type ReactNode } from 'react'

/**
 * The small labelled controls the compile window and the Book details page are built from
 * (Compile v2, CV3). Each control labels itself, so a test or a screen reader finds it by name.
 */

export const FIELD =
  'rounded-md border border-line bg-bg px-2 py-1 text-sm disabled:opacity-50 aria-invalid:border-danger'
export const SECTION_TITLE = 'm-0 text-sm font-semibold'
export const HINT = 'm-0 text-xs text-fg-muted'

/** A two-column grid of label + control rows. */
export function FieldGrid({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <div className="grid grid-cols-[10rem_minmax(0,1fr)] items-center gap-x-3 gap-y-1.5 text-sm">
      {children}
    </div>
  )
}

interface NumberFieldProps {
  label: string
  value: number
  min: number
  max: number
  step?: number
  unit?: string
  disabled?: boolean
  onChange: (value: number) => void
}

/**
 * A number with bounds. What is typed is kept as text, and committed as soon as it reads as a
 * number in range; leaving the field puts back the committed value, so a half-typed number never
 * reaches the format.
 */
export function NumberField({
  label,
  value,
  min,
  max,
  step = 1,
  unit,
  disabled,
  onChange
}: NumberFieldProps): React.JSX.Element {
  const id = useId()
  // What is typed while the field has the focus; null shows the committed value.
  const [typed, setTyped] = useState<string | null>(null)
  const text = typed ?? String(value)
  const setText = setTyped
  const parsed = Number(text)
  const valid = text.trim() !== '' && Number.isFinite(parsed) && parsed >= min && parsed <= max
  return (
    <>
      <label htmlFor={id}>{label}</label>
      <span className="flex items-center gap-1.5">
        <input
          id={id}
          type="number"
          inputMode="decimal"
          min={min}
          max={max}
          step={step}
          value={text}
          disabled={disabled}
          aria-invalid={!valid}
          onChange={(event) => {
            setText(event.target.value)
            const next = Number(event.target.value)
            if (
              event.target.value.trim() !== '' &&
              Number.isFinite(next) &&
              next >= min &&
              next <= max
            )
              onChange(next)
          }}
          onBlur={() => setTyped(null)}
          className={`${FIELD} w-24`}
        />
        {unit !== undefined ? <span className="text-xs text-fg-muted">{unit}</span> : null}
      </span>
    </>
  )
}

interface SelectFieldProps<T extends string> {
  label: string
  value: T
  options: readonly { value: T; label: string }[]
  disabled?: boolean
  onChange: (value: T) => void
}

export function SelectField<T extends string>({
  label,
  value,
  options,
  disabled,
  onChange
}: SelectFieldProps<T>): React.JSX.Element {
  const id = useId()
  return (
    <>
      <label htmlFor={id}>{label}</label>
      <select
        id={id}
        value={value}
        disabled={disabled}
        onChange={(event) => {
          const next = options.find((option) => option.value === event.target.value)
          if (next !== undefined) onChange(next.value)
        }}
        className={`${FIELD} max-w-full justify-self-start`}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </>
  )
}

interface TextFieldProps {
  label: string
  value: string
  maxLength: number
  disabled?: boolean
  placeholder?: string
  /** Marks the field invalid (and says why under it). */
  error?: string | null
  onChange: (value: string) => void
}

export function TextField({
  label,
  value,
  maxLength,
  disabled,
  placeholder,
  error = null,
  onChange
}: TextFieldProps): React.JSX.Element {
  const id = useId()
  const errorId = useId()
  return (
    <>
      <label htmlFor={id}>{label}</label>
      <span className="flex flex-col gap-0.5">
        <input
          id={id}
          type="text"
          value={value}
          maxLength={maxLength}
          disabled={disabled}
          placeholder={placeholder}
          aria-invalid={error !== null}
          aria-describedby={error !== null ? errorId : undefined}
          onChange={(event) => onChange(event.target.value)}
          className={`${FIELD} w-full`}
        />
        {error !== null ? (
          <span id={errorId} className="text-xs text-danger">
            {error}
          </span>
        ) : null}
      </span>
    </>
  )
}

interface TextAreaFieldProps {
  label: string
  value: string
  maxLength: number
  rows?: number
  hint?: string
  onChange: (value: string) => void
}

export function TextAreaField({
  label,
  value,
  maxLength,
  rows = 3,
  hint,
  onChange
}: TextAreaFieldProps): React.JSX.Element {
  const id = useId()
  return (
    <>
      <label htmlFor={id} className="self-start pt-1">
        {label}
      </label>
      <span className="flex flex-col gap-0.5">
        <textarea
          id={id}
          value={value}
          maxLength={maxLength}
          rows={rows}
          onChange={(event) => onChange(event.target.value)}
          className={`${FIELD} w-full resize-y`}
        />
        {hint !== undefined ? <span className="text-xs text-fg-muted">{hint}</span> : null}
      </span>
    </>
  )
}

interface CheckFieldProps {
  label: string
  checked: boolean
  disabled?: boolean
  onChange: (checked: boolean) => void
}

/** A checkbox on its own row, spanning both grid columns. */
export function CheckField({
  label,
  checked,
  disabled,
  onChange
}: CheckFieldProps): React.JSX.Element {
  return (
    <label className="col-span-2 flex items-center gap-1.5 text-sm">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      {label}
    </label>
  )
}
