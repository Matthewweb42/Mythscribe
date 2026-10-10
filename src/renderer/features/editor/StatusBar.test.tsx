import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetAccountStore } from '@renderer/features/account/accountStore'
import { resetAiSettingsStore } from '@renderer/features/ai/aiSettingsStore'
import { goalsStatusFixture } from '@renderer/features/goals/goalsFixture'
import { resetGoalsStore, useGoalsStore } from '@renderer/features/goals/goalsStore'
import { resetLibraryStore } from '@renderer/features/library/libraryStore'
import { resetOrganiseStore } from '@renderer/features/organise/organiseStore'
import { StatusBar } from './StatusBar'
import { formatDelta, formatWords } from './wordFormat'

// The bar carries `CreditNotice` (F-15.5), which reads the account and the project's AI source;
// the shared vitest workers must not hand it either from another file (nor leave one behind).
beforeEach(() => {
  resetAccountStore()
  resetAiSettingsStore()
  resetGoalsStore()
  // The side-work item (2026-10-10) reads the Organise and upload runs.
  resetOrganiseStore()
  resetLibraryStore()
})
afterEach(() => {
  resetAccountStore()
  resetAiSettingsStore()
  resetGoalsStore()
  // The side-work item (2026-10-10) reads the Organise and upload runs.
  resetOrganiseStore()
  resetLibraryStore()
})

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

  it('shows the AI share only above zero (F-14.6)', () => {
    const { unmount } = render(<StatusBar words={9} aiPercent={38} />)
    expect(screen.getByTestId('status-ai')).toHaveTextContent('38% AI')
    unmount()
    render(<StatusBar words={9} aiPercent={0} />)
    expect(screen.queryByTestId('status-ai')).not.toBeInTheDocument()
    expect(screen.getByTestId('status-words')).toHaveTextContent('9 words')
  })

  it('carries no credit notice for a project on the author’s own key (F-15.5)', () => {
    render(<StatusBar words={9} />)
    expect(screen.queryByTestId('credit-notice')).not.toBeInTheDocument()
  })
})

describe('StatusBar goals strip (F-10.3)', () => {
  it('shows nothing before the goals load, then today against the target and the streak', () => {
    const { rerender } = render(<StatusBar words={9} />)
    expect(screen.queryByTestId('status-goals')).not.toBeInTheDocument()
    const base = goalsStatusFixture()
    useGoalsStore.setState({
      status: goalsStatusFixture({
        goals: { ...base.goals, dailyTarget: 500, projectTarget: 80000 },
        today: { day: base.today.day, words: 120 },
        streak: { current: 3, best: 4 },
        manuscriptWords: 40000
      })
    })
    rerender(<StatusBar words={9} />)
    expect(screen.getByTestId('status-goals-today')).toHaveTextContent('Today 120 / 500')
    expect(screen.getByTestId('status-goals-streak')).toHaveTextContent('3-day streak')
    expect(screen.getByRole('progressbar', { name: 'Project progress' })).toHaveAttribute(
      'aria-valuenow',
      '40000'
    )
  })

  it('shows today alone without targets, and opens the dialog on a click', () => {
    useGoalsStore.setState({
      status: goalsStatusFixture({ today: { day: '2026-10-04', words: 7 } })
    })
    render(<StatusBar words={9} />)
    expect(screen.getByTestId('status-goals-today')).toHaveTextContent('Today 7')
    expect(screen.queryByTestId('status-goals-streak')).not.toBeInTheDocument()
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('status-goals'))
    expect(useGoalsStore.getState().open).toBe(true)
  })
})
