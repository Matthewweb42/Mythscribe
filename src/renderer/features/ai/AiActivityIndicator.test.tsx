import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiFeatureId } from '@shared/ai'
import { setIpcClient } from '@renderer/lib/ipc'
import { resetAiActivityStore, useAiActivityStore } from './aiActivityStore'
import { AI_ACTIVITY_DELAY_MS, AiActivityIndicator } from './AiActivityIndicator'

interface Tracked {
  resolve: () => void
  done: Promise<null>
}

/** Starts a request the test finishes by hand, inside `act` so the store update renders. */
function start(feature: AiFeatureId, requestId: string): Tracked {
  let resolve: (value: null) => void = () => {}
  let done: Promise<null> = Promise.resolve(null)
  act(() => {
    done = useAiActivityStore.getState().track(
      feature,
      requestId,
      new Promise<null>((r) => {
        resolve = r
      })
    )
  })
  return { resolve: () => resolve(null), done }
}

const indicator = (): HTMLElement | null => screen.queryByTestId('ai-activity')
const tick = async (ms: number): Promise<void> => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 8, 15, 10, 0, 0))
  resetAiActivityStore()
  setIpcClient({
    invoke: () => Promise.reject(new Error('no ipc in this test')),
    on: () => () => {}
  })
})
afterEach(() => {
  resetAiActivityStore()
  vi.useRealTimers()
})

describe('AiActivityIndicator (F-5.10)', () => {
  it('renders nothing while nothing is in flight', () => {
    render(<AiActivityIndicator />)
    expect(indicator()).toBeNull()
  })

  it('shows the feature label as a status once a request has been in flight for the delay', async () => {
    render(<AiActivityIndicator />)
    const chat = start('chat', 'r-1')
    await tick(AI_ACTIVITY_DELAY_MS - 1)
    expect(indicator()).toBeNull()
    await tick(1)
    const status = screen.getByRole('status', { name: 'AI activity' })
    expect(status).toHaveAttribute('data-testid', 'ai-activity')
    expect(status).toHaveTextContent('Assistant chat')
    expect(status.querySelector('.animate-spin')).not.toBeNull()
    await act(async () => {
      chat.resolve()
      await chat.done
    })
    expect(indicator()).toBeNull()
  })

  it('never shows for a request that settles within the delay (a cache hit)', async () => {
    render(<AiActivityIndicator />)
    const tags = start('tags', 'r-2')
    await tick(AI_ACTIVITY_DELAY_MS - 50)
    await act(async () => {
      tags.resolve()
      await tags.done
    })
    await tick(AI_ACTIVITY_DELAY_MS)
    expect(indicator()).toBeNull()
  })

  it('lists every running feature once, and stays up while a younger request is still running', async () => {
    render(<AiActivityIndicator />)
    const ghost = start('ghostText', 'g-1')
    await tick(100)
    const chat = start('chat', 'r-3')
    const again = start('chat', 'r-4')
    await tick(AI_ACTIVITY_DELAY_MS - 100)
    expect(indicator()).toHaveTextContent('Ghost text, Assistant chat')
    await act(async () => {
      ghost.resolve()
      await ghost.done
    })
    await tick(0)
    expect(indicator()).toHaveTextContent('Assistant chat')
    expect(indicator()).not.toHaveTextContent('Ghost text')
    await act(async () => {
      chat.resolve()
      again.resolve()
      await Promise.all([chat.done, again.done])
    })
    expect(indicator()).toBeNull()
  })
})
