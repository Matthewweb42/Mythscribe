import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AI_WAIT_PHRASES } from './aiWaitPhrases'
import { AI_WAIT_ROTATE_MS, AiWaitText } from './AiWaitText'

const PHRASES = ['First…', 'Second…', 'Third…'] as const

/** The text of the phrase marked current. */
function current(): string | null {
  const shown = screen.getByTestId('wait').querySelector('[data-current="true"]')
  return shown?.textContent ?? null
}

const tick = (ms: number): void => {
  act(() => {
    vi.advanceTimersByTime(ms)
  })
}

const originalMatchMedia = window.matchMedia

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
  window.matchMedia = originalMatchMedia
})

describe('AiWaitText (AI waiting text, 2026-10-08)', () => {
  it('starts at the first phrase and moves to the next every interval, wrapping round', () => {
    render(<AiWaitText phrases={PHRASES} testId="wait" />)
    expect(current()).toBe('First…')
    tick(AI_WAIT_ROTATE_MS - 1)
    expect(current()).toBe('First…')
    tick(1)
    expect(current()).toBe('Second…')
    tick(AI_WAIT_ROTATE_MS)
    expect(current()).toBe('Third…')
    tick(AI_WAIT_ROTATE_MS)
    expect(current()).toBe('First…')
  })

  it('announces only the first phrase: one status, the others hidden from screen readers', () => {
    render(<AiWaitText phrases={PHRASES} testId="wait" />)
    const status = screen.getByRole('status')
    expect(status).toHaveAttribute('data-testid', 'wait')
    const phrases = [...status.children]
    expect(phrases.map((p) => p.getAttribute('aria-hidden'))).toEqual([null, 'true', 'true'])
    tick(AI_WAIT_ROTATE_MS)
    expect(phrases[0]).not.toHaveAttribute('aria-hidden')
    expect(phrases[0]).toHaveTextContent('First…')
  })

  it('is no status of its own with announce off', () => {
    render(<AiWaitText phrases={PHRASES} testId="wait" announce={false} />)
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.getByTestId('wait')).toHaveTextContent('First…')
  })

  it('stops its timer on unmount', () => {
    const { unmount } = render(<AiWaitText phrases={PHRASES} testId="wait" />)
    expect(vi.getTimerCount()).toBe(1)
    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('runs no timer for a single phrase', () => {
    render(<AiWaitText phrases={['Only…']} testId="wait" />)
    expect(vi.getTimerCount()).toBe(0)
    expect(current()).toBe('Only…')
  })

  it('starts again from the first phrase when the phrases change', () => {
    const { rerender } = render(<AiWaitText phrases={PHRASES} testId="wait" />)
    tick(AI_WAIT_ROTATE_MS)
    expect(current()).toBe('Second…')
    rerender(<AiWaitText phrases={['Other…', 'More…']} testId="wait" />)
    expect(current()).toBe('Other…')
  })

  it('still rotates with reduced motion, marked so the fade and the glint stop', () => {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query === '(prefers-reduced-motion: reduce)',
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false
    }))
    render(<AiWaitText phrases={PHRASES} testId="wait" />)
    expect(screen.getByTestId('wait')).toHaveAttribute('data-motion', 'reduce')
    tick(AI_WAIT_ROTATE_MS)
    expect(current()).toBe('Second…')
  })

  it('marks full motion by leaving the attribute off', () => {
    render(<AiWaitText phrases={PHRASES} testId="wait" />)
    expect(screen.getByTestId('wait')).not.toHaveAttribute('data-motion')
  })

  it('gives every task 4 to 6 phrases, none repeated', () => {
    for (const [task, phrases] of Object.entries(AI_WAIT_PHRASES)) {
      expect(phrases.length, task).toBeGreaterThanOrEqual(4)
      expect(phrases.length, task).toBeLessThanOrEqual(6)
      expect(new Set(phrases).size, task).toBe(phrases.length)
    }
  })
})
