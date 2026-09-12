import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { StatusBar } from './StatusBar'
import { formatDelta, formatWords } from './wordFormat'

describe('StatusBar (F-3.3)', () => {
  it('formats counts with a plural and thousands separators', () => {
    expect(formatWords(0)).toBe('0 words')
    expect(formatWords(1)).toBe('1 word')
    expect(formatWords(1234)).toBe('1,234 words')
  })

  it('formats the session delta with a sign', () => {
    expect(formatDelta(0)).toBe('+0')
    expect(formatDelta(123)).toBe('+123')
    expect(formatDelta(-45)).toBe('−45')
    expect(formatDelta(1000)).toBe('+1,000')
  })

  it('renders both figures, and only the count when there is no delta', () => {
    const { unmount } = render(<StatusBar words={9} delta={-2} />)
    expect(screen.getByTestId('status-words')).toHaveTextContent('9 words')
    expect(screen.getByTestId('status-delta')).toHaveTextContent('−2 this session')
    unmount()
    render(<StatusBar words={1200} />)
    expect(screen.getByTestId('status-words')).toHaveTextContent('1,200 words')
    expect(screen.queryByTestId('status-delta')).not.toBeInTheDocument()
  })
})
