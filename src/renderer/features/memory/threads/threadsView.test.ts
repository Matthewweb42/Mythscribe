import { describe, expect, it } from 'vitest'
import { threadStepFixture, threadViewFixture } from '../memoryFixture'
import {
  mutedStepNote,
  noStepsNamingText,
  noStepsText,
  stepText,
  threadStatusText,
  threadSummary
} from './threadsView'

/** F-16.23: the words of the threads (plan P2b §5.2); absence only ever scoped (P2b rule 9). */
describe('the threads’ words (F-16.23)', () => {
  it('says a thread’s status as of the scene', () => {
    expect(threadStatusText(threadViewFixture('t', 'the heir'))).toBe('open since 1.1')
    expect(
      threadStatusText(
        threadViewFixture('t', 'the heir', { last: { nodeId: 'sc-3', ref: '7.3' } })
      )
    ).toBe('open since 1.1 · last 7.3')
    expect(
      threadStatusText(
        threadViewFixture('t', 'the heir', {
          status: 'resolved',
          resolved: { nodeId: 'sc-9', ref: '20.1' }
        })
      )
    ).toBe('resolved in 20.1')
    expect(
      threadStatusText(
        threadViewFixture('t', 'the heir', { status: 'notYet', opened: null, last: null })
      )
    ).toBe('not yet in the book')
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
  })

  it('notes a sidebar row with the status, or where an AI-made thread may still be', () => {
    expect(threadSummary(threadViewFixture('t', 'the heir'))).toBe('open since 1.1')
    expect(threadSummary(undefined, true)).toBe(
      'not in the book now (another draft, or an Idea or left-out scene)'
    )
    expect(threadSummary(undefined)).toBe('')
  })
})
