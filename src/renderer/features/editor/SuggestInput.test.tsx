import { useState } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SuggestInput } from './SuggestInput'

const OPTIONS = ['dark-forest', 'docks', 'Harbor']

/** A controlled host, like the metadata pane: the value lives outside the input. */
function Host({ initial = '', onChange }: { initial?: string; onChange?: (v: string) => void }) {
  const [value, setValue] = useState(initial)
  return (
    <SuggestInput
      label="Location"
      value={value}
      onChange={(next) => {
        setValue(next)
        onChange?.(next)
      }}
      options={OPTIONS}
      placeholder="e.g. dark-forest"
    />
  )
}

const input = (): HTMLElement => screen.getByRole('combobox', { name: 'Location' })
const listbox = (): HTMLElement | null =>
  screen.queryByRole('listbox', { name: 'Location suggestions' })
const optionNames = (): string[] =>
  screen.getAllByRole('option').map((option) => option.textContent ?? '')

describe('SuggestInput (F-4.5)', () => {
  it('is a labelled combobox that stays closed until typed into', () => {
    render(<Host initial="docks" />)
    expect(input()).toHaveValue('docks')
    expect(input()).toHaveAttribute('aria-autocomplete', 'list')
    expect(input()).toHaveAttribute('aria-expanded', 'false')
    expect(listbox()).toBeNull()
  })

  it('typing reports the text and lists the options starting with it, case-insensitively', () => {
    const onChange = vi.fn()
    render(<Host onChange={onChange} />)
    fireEvent.change(input(), { target: { value: 'D' } })
    expect(onChange).toHaveBeenLastCalledWith('D')
    expect(input()).toHaveAttribute('aria-expanded', 'true')
    expect(optionNames()).toEqual(['dark-forest', 'docks'])
    fireEvent.change(input(), { target: { value: 'do' } })
    expect(optionNames()).toEqual(['docks'])
    fireEvent.change(input(), { target: { value: 'dox' } })
    expect(listbox()).toBeNull()
    expect(input()).toHaveAttribute('aria-expanded', 'false')
  })

  it('ArrowDown moves the active option, Enter fills it in and closes; free text stays as typed', () => {
    const onChange = vi.fn()
    render(<Host onChange={onChange} />)
    fireEvent.change(input(), { target: { value: 'd' } })
    const [first, second] = screen.getAllByRole('option')
    expect(first).toHaveAttribute('aria-selected', 'true')
    expect(input()).toHaveAttribute('aria-activedescendant', first?.id)
    fireEvent.keyDown(input(), { key: 'ArrowDown' })
    expect(second).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(input(), { key: 'ArrowUp' })
    expect(first).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(onChange).toHaveBeenLastCalledWith('dark-forest')
    expect(input()).toHaveValue('dark-forest')
    expect(listbox()).toBeNull()
    // Text that matches nothing is kept as is: Enter has nothing to pick.
    fireEvent.change(input(), { target: { value: 'the moor' } })
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(input()).toHaveValue('the moor')
    expect(onChange).toHaveBeenLastCalledWith('the moor')
  })

  it('Escape and blur close the list without changing the value; a click picks an option', () => {
    render(<Host />)
    fireEvent.change(input(), { target: { value: 'h' } })
    expect(optionNames()).toEqual(['Harbor'])
    fireEvent.keyDown(input(), { key: 'Escape' })
    expect(listbox()).toBeNull()
    expect(input()).toHaveValue('h')
    fireEvent.keyDown(input(), { key: 'ArrowDown' })
    expect(optionNames()).toEqual(['Harbor'])
    fireEvent.blur(input())
    expect(listbox()).toBeNull()
    fireEvent.keyDown(input(), { key: 'ArrowDown' })
    fireEvent.click(screen.getByRole('option', { name: 'Harbor' }))
    expect(input()).toHaveValue('Harbor')
    expect(listbox()).toBeNull()
  })
})
