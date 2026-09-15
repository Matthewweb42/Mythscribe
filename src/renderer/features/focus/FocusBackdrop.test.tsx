import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { FocusBackdrop } from './FocusBackdrop'

describe('FocusBackdrop (F-6.2)', () => {
  it('paints the image URL as the background and stays out of the accessibility tree', () => {
    render(<FocusBackdrop url="mythscribe-asset://backgrounds/a1.png" />)
    const backdrop = screen.getByTestId('focus-backdrop')
    expect(backdrop).toHaveStyle({
      backgroundImage: 'url("mythscribe-asset://backgrounds/a1.png")'
    })
    expect(backdrop).toHaveAttribute('aria-hidden', 'true')
    expect(backdrop).toHaveClass('focus-backdrop')
  })
})
