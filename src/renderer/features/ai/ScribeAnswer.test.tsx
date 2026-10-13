import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { QuerySceneRef } from '@shared/query'
import type { ScribeCitation, ScribeTurn } from '@shared/scribe'
import { resetFocusStore, useFocusStore } from '@renderer/features/focus/focusStore'
import { researchTreeFixture } from '@renderer/features/manuscript/treeFixture'
import { buildIndex, useTreeStore } from '@renderer/features/manuscript/treeStore'
import { installFakeMain } from '@renderer/features/memory/memoryFixture'
import { recordFixture } from '@renderer/features/records/recordFixture'
import { resetRecordStore, useRecordStore } from '@renderer/features/records/recordStore'
import { resetLayoutStore, useLayoutStore } from '@renderer/features/shell/layoutStore'
import { setIpcClient } from '@renderer/lib/ipc'
import { resetAssistantStore, useAssistantStore } from './assistantStore'
import { NOT_CHECKED_TITLE, ScribeAnswer, UNSUPPORTED_TITLE } from './ScribeAnswer'
import { answerSegments, shownRef } from './scribeAnswerView'

/**
 * F-16.25 (plan P3 §5): Ms Scribe's answer in the chat: `[n]` chips, the Sources with their labels
 * in words (an Idea "your idea, not in the book"), how far each was checked and what a click opens,
 * the not-checked and unsupported sentences, the scope line, the widened note and Not found.
 */

const citation = (n: number, over: Partial<ScribeCitation> = {}): ScribeCitation => ({
  n,
  evidence: 'E0',
  label: 'happened',
  ref: '1.1 ¶0',
  title: 'The quay',
  open: { kind: 'scene', id: 'sc-1', para: 0 },
  quote: 'Orrin overheard Tomas',
  checked: 'cite',
  doc: null,
  ...over
})

const turn = (over: Partial<ScribeTurn> = {}): ScribeTurn => ({
  turn: 'answer',
  citations: [],
  notChecked: [],
  unsupported: [],
  scope: null,
  notFound: false,
  retried: false,
  widened: null,
  misses: 0,
  checkUsd: 0,
  ...over
})

/** Where `sentence` sits in `text`, as main stores a marked span. */
const span = (text: string, sentence: string): [number, number] => {
  const at = text.indexOf(sentence)
  return [at, at + sentence.length]
}

let openScene: Mock<(ref: QuerySceneRef, quote: string | null) => Promise<void>>
// No store reset restores an action and the workers share modules across files: the real
// `openScene` goes back after every test, or the spy would be every later file's.
const realOpenScene = useAssistantStore.getState().openScene

beforeEach(async () => {
  resetAssistantStore()
  resetRecordStore()
  resetLayoutStore()
  resetFocusStore()
  useTreeStore.getState().clear()
  installFakeMain({
    'record:list': () => [
      recordFixture('r-mara', 'character', ['Mara']),
      recordFixture('s-map', 'secret', ['the sold map'])
    ],
    'layout:set': (input) => input,
    'window:setFullScreen': (input) => input
  })
  useTreeStore.setState({ ...buildIndex(researchTreeFixture), loaded: true })
  await act(async () => await useRecordStore.getState().load())
  openScene = vi.fn(async () => {})
  useAssistantStore.setState({ openScene })
})
afterEach(() => {
  useAssistantStore.setState({ openScene: realOpenScene })
  resetAssistantStore()
  resetRecordStore()
  resetLayoutStore()
  resetFocusStore()
  useTreeStore.getState().clear()
  setIpcClient(null)
})

describe('answerSegments (F-16.25)', () => {
  it('cuts the answer into text, marked sentences and chips; a marker naming no citation stays text', () => {
    const text = 'Orrin heard it.[1] Mara knew.[2] Tomas sold it. See [9].'
    const at = text.indexOf('Tomas sold it.')
    expect(
      answerSegments(
        text,
        turn({
          citations: [citation(1), citation(2)],
          notChecked: [[at, at + 'Tomas sold it.'.length]],
          unsupported: []
        })
      )
    ).toEqual([
      { kind: 'text', text: 'Orrin heard it.' },
      { kind: 'cite', n: 1 },
      { kind: 'text', text: ' Mara knew.' },
      { kind: 'cite', n: 2 },
      { kind: 'text', text: ' ' },
      { kind: 'notChecked', text: 'Tomas sold it.' },
      { kind: 'text', text: ' See [9].' }
    ])
    // Spans out of range or overlapping the one before are left out, never thrown on.
    expect(
      answerSegments('Short.', turn({ notChecked: [[0, 99]], unsupported: [[3, 2]] }))
    ).toEqual([{ kind: 'text', text: 'Short.' }])
  })

  it('counts paragraphs from 1 for the author, as ⓘ does', () => {
    expect(shownRef('1.1 ¶0')).toBe('1.1 ¶1')
    expect(shownRef('9.3 ¶4–7')).toBe('9.3 ¶5–8')
    expect(shownRef('Mara’s Ideas')).toBe('Mara’s Ideas')
  })
})

describe('ScribeAnswer (F-16.25)', () => {
  it('draws chips, the Sources with their labels and checks, the scope line and the widened note', () => {
    const answer =
      'Orrin first hears of it in 1.1.[1] Your idea was a twin.[2] Mara grieves. It was sold twice.'
    render(
      <ScribeAnswer
        answer={answer}
        scribe={turn({
          citations: [
            citation(1),
            citation(2, {
              evidence: 'E3',
              label: 'idea',
              ref: 'Mara’s Ideas ¶0',
              title: 'Mara',
              open: { kind: 'record', id: 'r-mara', page: 'ideas', para: 0 },
              quote: 'Maybe Mara has a twin',
              checked: 'quote'
            })
          ],
          notChecked: [span(answer, 'Mara grieves.')],
          unsupported: [span(answer, 'It was sold twice.')],
          scope: 'Searched every scene up to 1.2 for overheard',
          widened: { ref: 'chapter 1 (1.1–1.2)' }
        })}
      />
    )
    const chips = screen.getAllByTestId('scribe-cite')
    expect(chips.map((chip) => chip.textContent)).toEqual(['[1]', '[2]'])
    expect(chips[0]).toHaveAccessibleName('Source 1: happened, 1.1 ¶1')
    expect(chips[1]).toHaveAccessibleName('Source 2: your idea, not in the book, Mara’s Ideas ¶1')
    const sources = screen.getAllByTestId('scribe-source')
    expect(sources[0]).toHaveTextContent('[1] 1.1 ¶1 · The quay')
    expect(within(sources[0]!).getByTestId('scribe-source-label')).toHaveTextContent(
      /^happened$/
    )
    expect(sources[0]).toHaveTextContent('“Orrin overheard Tomas”')
    expect(sources[0]).toHaveTextContent('quote and sentence checked')
    expect(within(sources[1]!).getByTestId('scribe-source-label')).toHaveTextContent(
      'your idea, not in the book'
    )
    expect(sources[1]).toHaveTextContent(/quote checked$/)
    // A page's reference names its record: the title is not repeated.
    expect(sources[1]).toHaveTextContent(/^\[2\] Mara’s Ideas ¶1your idea/)
    const notChecked = screen.getByTestId('scribe-not-checked')
    expect(notChecked).toHaveTextContent('Mara grieves.')
    expect(notChecked).toHaveAttribute('title', NOT_CHECKED_TITLE)
    const unsupported = screen.getByTestId('scribe-unsupported')
    expect(unsupported).toHaveTextContent('It was sold twice.')
    expect(unsupported).toHaveAttribute('title', UNSUPPORTED_TITLE)
    expect(screen.getByTestId('scribe-scope')).toHaveTextContent(
      'Searched every scene up to 1.2 for overheard'
    )
    expect(screen.getByTestId('scribe-widened')).toHaveTextContent(
      'Read chapter 1 (1.1–1.2) too'
    )
    expect(screen.queryByTestId('scribe-not-found')).toBeNull()
  })

  it('words every label for the chat, a filed line with its document', () => {
    const labels: [ScribeCitation['label'], string][] = [
      ['later', 'later in the book'],
      ['notes', 'your notes'],
      ['research', 'source document'],
      ['notCanon', 'not canon'],
      ['planned', 'planned'],
      ['ideaScene', 'idea scene'],
      ['computed', 'computed from your book'],
      ['todo', 'your to-do']
    ]
    render(
      <ScribeAnswer
        answer="Lines."
        scribe={turn({
          citations: [
            ...labels.map(([label], i) => citation(i + 1, { label, open: null })),
            citation(labels.length + 1, { label: 'filed', doc: 'Harbour notes', open: null })
          ]
        })}
      />
    )
    expect(screen.getAllByTestId('scribe-source-label').map((each) => each.textContent)).toEqual([
      ...labels.map(([, words]) => words),
      'filed from Harbour notes'
    ])
    // Nothing to open: the source is not a button.
    expect(screen.queryAllByRole('button')).toHaveLength(0)
  })

  it('opens a scene at the quote, a record’s sheet, and a Research page', async () => {
    render(
      <ScribeAnswer
        answer="Orrin heard.[1] A twin.[2] Tides.[3]"
        scribe={turn({
          citations: [
            citation(1),
            citation(2, {
              label: 'idea',
              open: { kind: 'record', id: 'r-mara', page: 'ideas', para: 0 }
            }),
            citation(3, {
              evidence: 'E8',
              label: 'research',
              ref: 'Research “Coast survey” ¶0',
              title: 'Coast survey',
              open: { kind: 'research', id: 'r-upload', para: 0 },
              quote: 'The tide turns at noon'
            })
          ]
        })}
      />
    )
    fireEvent.click(screen.getAllByTestId('scribe-cite')[0]!)
    expect(openScene).toHaveBeenCalledWith(
      { nodeId: 'sc-1', title: 'The quay' },
      'Orrin overheard Tomas'
    )
    await act(async () => fireEvent.click(screen.getAllByTestId('scribe-source')[1]!))
    expect(useRecordStore.getState().selectedId).toBe('r-mara')
    expect(useLayoutStore.getState().layout.sidebar.open).toBe(true)
    // A Research page opens with the Research tab, as search opens one; no passage wait.
    const research = screen.getAllByTestId('scribe-source')[2]!
    // Its reference names the page: the title is not repeated.
    expect(research).toHaveTextContent(/^\[3\] Research “Coast survey” ¶1source document/)
    fireEvent.click(research)
    expect(useTreeStore.getState().selectedId).toBe('r-upload')
    expect(useLayoutStore.getState().layout.sidebar.tab).toBe('research')
    expect(openScene).toHaveBeenCalledTimes(1)
  })

  it('opens a scene’s notes with the Notes panel, never searching the scene for the quote', () => {
    render(
      <ScribeAnswer
        answer="Mara is to learn of it.[1]"
        scribe={turn({
          citations: [
            citation(1, {
              evidence: 'E3',
              label: 'planned',
              ref: '1.2 notes ¶0',
              title: 'Scene 2',
              open: { kind: 'scene', id: 'sc-2', para: null, notes: true },
              quote: 'Mara learns of the sale'
            })
          ]
        })}
      />
    )
    fireEvent.click(screen.getByTestId('scribe-source'))
    expect(openScene).not.toHaveBeenCalled()
    expect(useTreeStore.getState().selectedId).toBe('sc-2')
    expect(useLayoutStore.getState().layout.notes.open).toBe(true)
  })

  it('leaves focus mode before opening a record’s sheet, which has no focus view', async () => {
    useFocusStore.setState({ active: true })
    render(
      <ScribeAnswer
        answer="A twin.[1]"
        scribe={turn({
          citations: [
            citation(1, {
              label: 'idea',
              open: { kind: 'record', id: 'r-mara', page: 'ideas', para: 0 }
            })
          ]
        })}
      />
    )
    await act(async () => fireEvent.click(screen.getByTestId('scribe-source')))
    expect(useFocusStore.getState().active).toBe(false)
    expect(useRecordStore.getState().selectedId).toBe('r-mara')
  })

  it('reads Not found in the not-found style, with no chips or sources', () => {
    render(
      <ScribeAnswer
        answer="Not found in the manuscript (I looked in the open scene 1.1, and searched every scene up to 1.1 for sold)."
        scribe={turn({ notFound: true, retried: true, scope: 'Searched every scene up to 1.1' })}
      />
    )
    const line = screen.getByTestId('scribe-not-found')
    expect(line).toHaveTextContent('Not found in the manuscript (I looked in the open scene 1.1')
    expect(line).toHaveClass('italic')
    expect(screen.queryByTestId('scribe-cite')).toBeNull()
    expect(screen.queryByTestId('scribe-scope')).toBeNull()
  })
})
