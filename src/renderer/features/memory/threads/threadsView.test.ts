import { describe, expect, it } from 'vitest'
import { threadStepFixture, threadViewFixture, topicQuoteFixture } from '../memoryFixture'
import {
  mutedStepNote,
  noStepsNamingText,
  noStepsText,
  noThreadsText,
  showsNoSteps,
  stepText,
  threadStatusText,
  threadSummary
} from './threadsView'

const CHECKED = { nodeId: 'sc-2', ref: '1.2' }

/** F-16.23: the words of the threads (plan P2b §5.2); absence only ever scoped (P2b rule 9). */
describe('the threads’ words (F-16.23)', () => {
  it('says a thread’s status as of the scene', () => {
    expect(threadStatusText(threadViewFixture('t', 'the heir'), CHECKED)).toBe('open since 1.1')
    expect(
      threadStatusText(
        threadViewFixture('t', 'the heir', { last: { nodeId: 'sc-3', ref: '7.3' } }),
        CHECKED
      )
    ).toBe('open since 1.1 · last 7.3')
    expect(
      threadStatusText(
        threadViewFixture('t', 'the heir', {
          status: 'resolved',
          resolved: { nodeId: 'sc-9', ref: '20.1' }
        }),
        CHECKED
      )
    ).toBe('resolved in 20.1')
  })

  it('never states a thread’s absence as fact before a step that counts (P2b rule 9)', () => {
    const notYet = { status: 'notYet' as const, opened: null, last: null }
    // An AI-made thread made from its reveal alone: where it was revealed.
    const revealed = threadViewFixture('t', 'the heir', { ...notYet, steps: [] })
    expect(threadStatusText(revealed, CHECKED)).toBe('revealed in 1.1 · no opening step read yet')
    expect(showsNoSteps(revealed)).toBe(false)
    // Only a remembered step: listed muted below; none counts yet.
    const muted = threadViewFixture('t', 'the heir', {
      ...notYet,
      steps: [threadStepFixture('s', { counted: false, mode: 'memory' })]
    })
    expect(threadStatusText(muted, CHECKED)).toBe('revealed in 1.1 · none of its steps counts yet')
    // A merged reveal stands for it too.
    expect(
      threadStatusText(
        threadViewFixture('t', 'the heir', {
          ...notYet,
          steps: [],
          defining: null,
          merged: [topicQuoteFixture('tq', { role: 'merged', ref: '2.1' })]
        }),
        CHECKED
      )
    ).toBe('revealed in 2.1 · no opening step read yet')
    // The author's thread no scene touches: scoped.
    const authors = threadViewFixture('t', 'Ashby’s return', {
      ...notYet,
      origin: 'author',
      steps: [],
      defining: null
    })
    expect(threadStatusText(authors, CHECKED)).toBe('not opened (checked up to 1.2)')
    expect(threadStatusText(authors, null)).toBe('not opened (not checked yet)')
    expect(showsNoSteps(authors)).toBe(true)
    expect(threadStatusText({ ...authors, later: 2 }, CHECKED)).toBe('its first step comes later')
    expect(showsNoSteps({ ...authors, later: 2 })).toBe(false)
  })

  it('words a step, and why a muted one moves no status', () => {
    const step = threadStepFixture('s', {
      step: 'advances',
      ref: '7.3',
      value: 'Johanna writes to Ashby'
    })
    expect(stepText(step)).toBe('advances 7.3: Johanna writes to Ashby')
    expect(mutedStepNote(step)).toBeNull()
    expect(mutedStepNote({ ...step, counted: false, voice: 'rumour' })).toBe('rumoured')
    expect(mutedStepNote({ ...step, counted: false, mode: 'memory' })).toBe('remembered')
    expect(mutedStepNote({ ...step, counted: false, mode: 'hypothetical' })).toBe('only supposed')
  })

  it('scopes every absence to what was checked', () => {
    expect(noStepsText({ nodeId: 'sc-2', ref: '14.2' })).toBe(
      'No scene shows this thread yet (checked up to 14.2)'
    )
    expect(noStepsText(null)).toBe('No scene shows this thread yet (not checked yet)')
    expect(noStepsNamingText('Mara', { nodeId: 'sc-2', ref: '1.2' })).toBe(
      'No scene shows a thread step naming Mara (checked up to 1.2)'
    )
    expect(noThreadsText(CHECKED)).toBe('No plot thread found (checked up to 1.2)')
    expect(noThreadsText(null)).toBe('No plot thread found (not checked yet)')
  })

  it('notes a sidebar row with the status, or where an AI-made thread may still be', () => {
    expect(threadSummary(threadViewFixture('t', 'the heir'), CHECKED)).toBe('open since 1.1')
    expect(threadSummary(undefined, CHECKED, true)).toBe(
      'not in the book now (another draft, or an Idea or left-out scene)'
    )
    expect(threadSummary(undefined, CHECKED)).toBe('')
  })
})
