import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defaultAiSettings } from '@shared/aiSettings'
import { categoryFromInput } from '@shared/categories'
import type { FilingReview } from '@shared/filing'
import type { Channel, EventName, EventPayload, Input, Output } from '@shared/ipc/contract'
import type { ResearchDoc } from '@shared/research'
import { resetAiSettingsStore } from '@renderer/features/ai/aiSettingsStore'
import { resetProposalStore } from '@renderer/features/ai/proposalStore'
import {
  categoryCardId,
  decidedFilingReview,
  filingReviewItems
} from '@renderer/features/library/uploadReview'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { resetFiledConflictStore } from '@renderer/features/thisScene/filedConflictStore'
import { setIpcClient } from '@renderer/lib/ipc'
import { FilingDialog } from './FilingDialog'
import { resetFilingStore, useFilingStore } from './filingStore'
import { filingEstimateLine, filingSummaryLine } from './filingView'
import { resetPageStore } from './pageStore'
import { resetResearchStore, useResearchStore } from './researchStore'

/**
 * F-16.9: filing a Research page into Pinned in the renderer: the deck's groups (New records,
 * Additions, Conflicts, New categories; everything starts accepted), a conflict's pick, the
 * estimate, the pass, Apply with its *Undo filing*, and the review chat's operations.
 */

const REVIEW: FilingReview = {
  docId: 'r-bestiary',
  docTitle: 'Bestiary',
  docHash: 'h',
  items: [
    {
      id: 'f1',
      recordId: null,
      name: 'Fen-Wight',
      categoryId: 'c-creatures',
      known: [],
      aliases: ['wight'],
      lines: [
        {
          id: 'l1',
          text: 'Colour: pale',
          quote: 'a pale thing that hunts',
          para: 1,
          kind: 'add',
          replaces: null,
          use: true
        }
      ],
      sameAs: null,
      image: null,
      include: true
    },
    {
      id: 'f2',
      recordId: 'r-mara',
      name: 'Mara Vell',
      categoryId: 'character',
      known: ['Mara Vell'],
      aliases: [],
      lines: [
        {
          id: 'l2',
          text: 'Eyes: grey',
          quote: 'Mara Vell has grey eyes',
          para: 2,
          kind: 'conflict',
          replaces: { index: 0, text: 'Eyes: green' },
          use: false
        }
      ],
      sameAs: null,
      image: null,
      include: true
    },
    {
      id: 'f3',
      recordId: 'r-tomas',
      name: 'Tomas Harrow',
      categoryId: 'character',
      known: ['Tomas Harrow'],
      aliases: ['Tom'],
      lines: [
        {
          id: 'l3',
          text: 'Keeps the ferry',
          quote: 'keeps the ferry at Gullhaven',
          para: 4,
          kind: 'add',
          replaces: null,
          use: true
        }
      ],
      sameAs: { given: 'Tom', rule: 'prefix' },
      image: null,
      include: true
    }
  ],
  categories: [
    {
      ...categoryFromInput(
        'c-creatures',
        { name: 'Creatures', noun: 'creature', fields: [] },
        'ai'
      ),
      proposed: true
    }
  ],
  dropped: { quote: 2, duplicate: 0, dismissed: 0, alias: 0 },
  proposalIds: ['p-1'],
  chunks: 1,
  usage: { inputTokens: 3200, outputTokens: 900 },
  costUsd: 0.0087,
  model: 'deepseek/deepseek-v4-pro',
  promptVersion: 'contextImport.v3'
}

const DOC: ResearchDoc = {
  nodeId: 'r-bestiary',
  origin: 'upload',
  contextFileId: 'cf-1',
  fileName: 'bestiary.md',
  fileType: 'md',
  converted: false,
  notCanon: false,
  filedAt: null
}

type Handler = (input: unknown) => unknown
let calls: [Channel, unknown][]

function install(overrides: Partial<Record<Channel, Handler>> = {}): void {
  calls = []
  setIpcClient({
    async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
      calls.push([channel, input])
      const override = overrides[channel]
      if (override) return (await override(input)) as Output<C>
      switch (channel) {
        case 'aiSettings:get':
          return { ...defaultAiSettings(), dial: 1 } as Output<C>
        case 'research:fileEstimate':
          return {
            files: 1,
            chunks: 1,
            tokensIn: 2900,
            tokensOut: 1500,
            costUsd: 0.0103,
            priced: true,
            model: 'deepseek/deepseek-v4-pro'
          } as Output<C>
        case 'research:file':
          return { ok: true, review: REVIEW } as Output<C>
        case 'research:applyFiling':
          return {
            created: 1,
            updated: 2,
            lines: 3,
            recordIds: ['r-new', 'r-mara', 'r-tomas'],
            filedAt: '2026-10-12T12:00:00.000Z'
          } as Output<C>
        case 'research:undoFiling':
          return { recordIds: ['r-mara'], deleted: ['r-new'], kept: 0 } as Output<C>
        case 'research:list':
          return [DOC] as Output<C>
        case 'research:filedConflicts':
          return [] as Output<C>
        case 'proposal:settle':
          return null as Output<C>
        default:
          throw new Error(`unexpected ${channel}`)
      }
    },
    on<E extends EventName>(_event: E, _listener: (payload: EventPayload<E>) => void) {
      return () => undefined
    }
  })
}

const sent = (channel: Channel): unknown[] =>
  calls.filter(([each]) => each === channel).map(([, input]) => input)

function resetAll(): void {
  resetFilingStore()
  resetResearchStore()
  resetPageStore()
  resetFiledConflictStore()
  resetAiSettingsStore()
  resetProposalStore()
  useDialogStore.setState({ modals: [], toasts: [] })
}

beforeEach(() => {
  install()
  resetAll()
})
afterEach(() => {
  resetAll()
  setIpcClient(null)
})

describe('the filing deck (F-16.9)', () => {
  it('groups the cards, starts every one accepted, and declines a skipped category to World', () => {
    expect(filingReviewItems(REVIEW, { f3: 'skipped' })).toEqual([
      { id: categoryCardId('c-creatures'), group: 'categories', decision: 'accepted' },
      { id: 'f1', group: 'new', decision: 'accepted' },
      { id: 'f2', group: 'conflicts', decision: 'accepted' },
      { id: 'f3', group: 'additions', decision: 'skipped' }
    ])
    const decided = decidedFilingReview(REVIEW, {
      f3: 'skipped',
      [categoryCardId('c-creatures')]: 'skipped'
    })
    expect(decided.items.map((item) => [item.id, item.include, item.categoryId])).toEqual([
      ['f1', true, 'world'],
      ['f2', true, 'character'],
      ['f3', false, 'character']
    ])
    expect(filingSummaryLine(REVIEW)).toBe(
      '1 new record · 2 records added to · 1 conflict · 2 lines dropped: quote not in the document'
    )
    expect(
      filingEstimateLine({
        files: 1,
        chunks: 14,
        tokensIn: 40600,
        tokensOut: 21000,
        costUsd: 0.144,
        priced: true,
        model: 'deepseek/deepseek-v4-pro'
      })
    ).toBe('14 requests to deepseek/deepseek-v4-pro · ≈ 40,600 tokens in, 21,000 out · about $0.14')
  })
})

describe('filing a page (F-16.9)', () => {
  it('estimates, files, reviews with the conflict kept as Pinned says, applies, and undoes', async () => {
    await act(async () => {
      await useResearchStore.getState().load()
    })
    render(<FilingDialog />)
    await act(async () => {
      await useFilingStore.getState().start('r-bestiary')
    })
    expect(screen.getByTestId('filing-estimate')).toHaveTextContent(
      '1 request to deepseek/deepseek-v4-pro'
    )
    await act(async () => {
      fireEvent.click(screen.getByTestId('filing-confirm'))
    })
    expect(sent('research:file')[0]).toMatchObject({ nodeId: 'r-bestiary' })
    expect(screen.getByTestId('filing-summary')).toHaveTextContent('From “Bestiary”: 1 new record')
    // The conflict card: Pinned's line is kept unless the author picks the upload's.
    act(() => {
      useFilingStore.getState().decide([categoryCardId('c-creatures'), 'f1'], 'accepted')
    })
    const flow = useFilingStore.getState().flow
    if (flow?.stage !== 'review') throw new Error('expected the review')
    expect(flow.review.items[1]?.lines[0]?.use).toBe(false)
    act(() => useFilingStore.getState().pickLine('f2', 'l2', true))
    await act(async () => {
      await useFilingStore.getState().apply()
    })
    const applied = sent('research:applyFiling')[0] as { review: FilingReview }
    expect(applied.review.items.map((item) => item.include)).toEqual([true, true, true])
    expect(applied.review.items[1]?.lines[0]?.use).toBe(true)
    expect(sent('proposal:settle')).toEqual([{ id: 'p-1', status: 'accepted', note: null }])
    expect(useFilingStore.getState().flow).toBeNull()
    expect(useResearchStore.getState().docs['r-bestiary']?.filedAt).toBe('2026-10-12T12:00:00.000Z')
    const toast = useDialogStore.getState().toasts.at(-1)
    expect(toast?.message).toBe('Filed 3 lines from “Bestiary”: 1 new record, 2 records added to.')
    expect(toast?.action?.label).toBe('Undo filing')
    await act(async () => {
      toast?.action?.run()
      await waitFor(() => expect(sent('research:undoFiling')).toHaveLength(1))
    })
    await waitFor(() =>
      expect(useDialogStore.getState().toasts.at(-1)?.message).toBe('Filing undone.')
    )
  })

  it('Cancel on the review settles its proposals rejected and writes nothing', async () => {
    render(<FilingDialog />)
    await act(async () => {
      await useFilingStore.getState().start('r-bestiary')
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('filing-confirm'))
    })
    const dialog = screen.getByTestId('filing-dialog')
    await act(async () => {
      fireEvent.click(within(dialog).getByTestId('filing-discard'))
    })
    expect(sent('proposal:settle')).toEqual([{ id: 'p-1', status: 'rejected', note: null }])
    expect(sent('research:applyFiling')).toEqual([])
    expect(screen.queryByTestId('filing-dialog')).toBeNull()
  })

  it('says what to switch on with Use AI off, and asks for nothing', async () => {
    install({ 'aiSettings:get': () => ({ ...defaultAiSettings(), dial: 0 }) })
    await act(async () => {
      await useFilingStore.getState().start('r-bestiary')
    })
    expect(sent('research:fileEstimate')).toEqual([])
    expect(useDialogStore.getState().toasts.at(-1)?.kind).toBe('info')
  })

  it('lands the review chat’s operations on the review, an include as the card’s decision', async () => {
    install({
      'research:reviewChat': () => ({
        ok: true,
        ops: [
          { op: 'include', item: 'f3', include: false },
          { op: 'rename', item: 'f1', name: 'Fen Wight' }
        ],
        reply: 'Left Tomas out and renamed the wight.',
        dropped: 0,
        usage: { inputTokens: 700, outputTokens: 60 },
        costUsd: 0.0014,
        cached: false,
        model: 'deepseek/deepseek-v4-pro',
        proposalId: 'p-chat',
        requestId: 'x'
      })
    })
    await act(async () => {
      await useFilingStore.getState().start('r-bestiary')
      await useFilingStore.getState().confirm()
      await useFilingStore.getState().sendChat('Leave Tomas out')
    })
    const flow = useFilingStore.getState().flow
    if (flow?.stage !== 'review') throw new Error('expected the review')
    expect(flow.decisions.f3).toBe('skipped')
    expect(flow.review.items[0]?.name).toBe('Fen Wight')
    expect(flow.review.proposalIds).toEqual(['p-1', 'p-chat'])
    act(() => useFilingStore.getState().undoChat())
    const back = useFilingStore.getState().flow
    if (back?.stage !== 'review') throw new Error('expected the review')
    expect(back.review.items[0]?.name).toBe('Fen-Wight')
  })
})
