import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultAiSettings } from '@shared/aiSettings'
import type { ContextAddResult } from '@shared/contextLibrary'
import type { Channel, Entity, Input, Output } from '@shared/ipc/contract'
import { resetAiActivityStore } from '@renderer/features/ai/aiActivityStore'
import { resetAiSettingsStore, useAiSettingsStore } from '@renderer/features/ai/aiSettingsStore'
import { resetProposalStore } from '@renderer/features/ai/proposalStore'
import { resetEntityStore, useEntityStore } from '@renderer/features/entities/entityStore'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { setIpcClient } from '@renderer/lib/ipc'
import { contextFileFixture, contextReviewFixture } from './libraryFixture'
import { resetLibraryStore, useLibraryStore } from './libraryStore'

type Handler = (input: unknown) => unknown
let calls: [Channel, unknown][]

const ESTIMATE = {
  files: 1,
  chunks: 1,
  tokensIn: 1_200,
  tokensOut: 1_500,
  costUsd: 0.02,
  priced: true,
  model: 'gpt-5.4'
}

const added = (over: Partial<ContextAddResult> = {}): ContextAddResult => ({
  files: [contextFileFixture()],
  changed: ['f1'],
  unchanged: 0,
  skipped: [],
  ...over
})

const tomas: Entity = {
  id: 'tomas',
  kind: 'character',
  name: 'Tomas',
  template: 'structured',
  fields: {},
  body: null,
  image: null,
  tagId: 't1',
  aliases: [],
  origin: 'author',
  created: '2026-10-07T09:00:00.000Z',
  modified: '2026-10-07T09:00:00.000Z'
}

function install(overrides: Partial<Record<Channel, Handler>> = {}): void {
  calls = []
  setIpcClient({
    async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
      calls.push([channel, input])
      const override = overrides[channel]
      if (override) return override(input) as Output<C>
      if (channel === 'library:list') return [contextFileFixture()] as Output<C>
      if (channel === 'library:add') return added() as Output<C>
      if (channel === 'library:estimate') return ESTIMATE as Output<C>
      if (channel === 'library:process') {
        return { ok: true, review: contextReviewFixture() } as Output<C>
      }
      if (channel === 'library:apply') {
        return {
          entities: [tomas],
          files: [contextFileFixture({ state: 'processed' })],
          created: 1,
          updated: 1,
          notes: true
        } as Output<C>
      }
      if (channel === 'proposal:settle') return { settled: true } as Output<C>
      if (channel === 'aiSettings:get') return { ...defaultAiSettings(), dial: 1 } as Output<C>
      throw new Error(`unexpected ${channel}`)
    },
    on: () => () => {}
  })
}

const toasts = (): string[] => useDialogStore.getState().toasts.map((t) => t.message)
const channelsCalled = (): Channel[] => calls.map(([channel]) => channel)

beforeEach(() => {
  install()
  resetLibraryStore()
  resetEntityStore()
  resetAiSettingsStore()
  resetAiActivityStore()
  resetProposalStore()
  useDialogStore.setState({ modals: [], toasts: [] })
  useAiSettingsStore.setState({ settings: { ...defaultAiSettings(), dial: 1 } })
})

describe('useLibraryStore (F-9.8)', () => {
  it('loads the files and clears them', async () => {
    await useLibraryStore.getState().load()
    expect(useLibraryStore.getState()).toMatchObject({ loaded: true, files: [{ id: 'f1' }] })
    useLibraryStore.getState().clear()
    expect(useLibraryStore.getState()).toMatchObject({ loaded: false, files: [], flow: null })
  })

  it('adds files, then shows the estimate for the author to confirm', async () => {
    await useLibraryStore.getState().add(['/docs/people.md'])
    expect(calls[0]).toEqual(['library:add', { paths: ['/docs/people.md'] }])
    expect(toasts()).toEqual(['Added 1 file to the Library.'])
    expect(useLibraryStore.getState().flow).toEqual({
      stage: 'confirm',
      fileIds: ['f1'],
      estimate: ESTIMATE
    })
    expect(channelsCalled()).not.toContain('library:process')
  })

  it('adds without sorting while Use AI is off, and says where to turn it on', async () => {
    useAiSettingsStore.setState({ settings: defaultAiSettings() })
    await useLibraryStore.getState().add()
    expect(calls[0]).toEqual(['library:add', {}])
    expect(useLibraryStore.getState().flow).toBeNull()
    expect(toasts()[0]).toMatch(
      /^Added 1 file to the Library\. Context library sorting needs Use AI turned on \(Settings, AI tab\)/
    )
  })

  it('loads the AI settings first for a project opened a moment ago', async () => {
    useAiSettingsStore.setState({ settings: null })
    await useLibraryStore.getState().add(['/docs/people.md'])
    expect(channelsCalled()).toContain('aiSettings:get')
    expect(useLibraryStore.getState().flow?.stage).toBe('confirm')
  })

  it('says what was skipped and what was already there', async () => {
    install({
      'library:add': () =>
        added({ changed: [], unchanged: 1, skipped: [{ name: 'a.epub', reason: 'Nope.' }] })
    })
    await useLibraryStore.getState().add()
    expect(toasts()).toEqual([
      'a.epub: Nope.',
      'Those files are already in the Library, unchanged.'
    ])
    expect(useLibraryStore.getState().flow).toBeNull()
  })

  it('runs the pass after the confirm and holds the review; Cancel settles it rejected', async () => {
    await useLibraryStore.getState().sort(['f1'])
    await useLibraryStore.getState().confirm()
    const process = calls.find(([channel]) => channel === 'library:process')
    const sent = process?.[1] as Input<'library:process'>
    expect(sent.fileIds).toEqual(['f1'])
    expect(sent.requestId).toMatch(/^lib-/)
    expect(useLibraryStore.getState().flow).toMatchObject({ stage: 'review', busy: false })
    useLibraryStore.getState().discard()
    expect(useLibraryStore.getState().flow).toBeNull()
    await vi.waitFor(() =>
      expect(calls).toContainEqual([
        'proposal:settle',
        { id: 'p1', status: 'rejected', note: null }
      ])
    )
    expect(channelsCalled()).not.toContain('library:apply')
  })

  it('shows a failure with its next step, and a stop goes back to nothing', async () => {
    install({
      'library:process': () => ({
        ok: false,
        code: 'NO_KEY',
        message: 'No key.',
        nextStep: 'Add one.'
      })
    })
    await useLibraryStore.getState().sort(['f1'])
    await useLibraryStore.getState().confirm()
    expect(useLibraryStore.getState().flow).toMatchObject({
      stage: 'failed',
      message: 'No key.',
      nextStep: 'Add one.'
    })
    useLibraryStore.getState().discard()
    install({
      'library:process': () => ({ ok: false, code: 'CANCELLED', message: 'Stopped.', nextStep: '' })
    })
    await useLibraryStore.getState().sort(['f1'])
    await useLibraryStore.getState().confirm()
    expect(useLibraryStore.getState().flow).toBeNull()
  })

  it('applies the edited review, merges the sheets, and settles the pass as accepted in part', async () => {
    await useLibraryStore.getState().sort(['f1'])
    await useLibraryStore.getState().confirm()
    useLibraryStore.getState().edit((review) => ({
      ...review,
      entities: review.entities.map((item) =>
        item.id === 'e1'
          ? { ...item, fields: item.fields.map((f) => ({ ...f, choice: 'upload' as const })) }
          : { ...item, tag: false }
      )
    }))
    await useLibraryStore.getState().apply()
    const sent = calls.find(
      ([channel]) => channel === 'library:apply'
    )?.[1] as Input<'library:apply'>
    expect(sent.review.entities[0]?.fields[0]?.choice).toBe('upload')
    expect(sent.review.entities[1]?.tag).toBe(false)
    expect(useEntityStore.getState().byId.tomas?.name).toBe('Tomas')
    expect(useLibraryStore.getState()).toMatchObject({
      flow: null,
      files: [{ state: 'processed' }]
    })
    expect(toasts()).toContain(
      'Story bible: 1 sheet created, 1 sheet updated, Project notes updated.'
    )
    await vi.waitFor(() =>
      expect(calls).toContainEqual([
        'proposal:settle',
        { id: 'p1', status: 'acceptedPart', note: null }
      ])
    )
  })

  it('splits a merged sheet against the story bible it knows', async () => {
    useEntityStore.setState({
      byId: { mara: { ...tomas, id: 'mara', name: 'Mara Vell' } },
      ids: ['mara']
    })
    await useLibraryStore.getState().sort(['f1'])
    await useLibraryStore.getState().confirm()
    useLibraryStore.getState().split('e1')
    const flow = useLibraryStore.getState().flow
    if (flow?.stage !== 'review') throw new Error('expected the review')
    expect(flow.review.entities.map((item) => [item.name, item.existingId])).toEqual([
      ['Mara', null],
      ['Mara Vell', 'mara'],
      ['Tomas', null]
    ])
  })

  it('reads dropped files as bytes and skips one over the size cap', async () => {
    install({ 'library:addData': () => added() })
    const file = new File(['Mara is 35.'], 'people.md', { type: 'text/markdown' })
    const huge = new File(['x'], 'huge.pdf')
    Object.defineProperty(huge, 'size', { value: 26 * 1024 * 1024 })
    await useLibraryStore.getState().addDropped([file, huge])
    const sent = calls[0]?.[1] as Input<'library:addData'>
    expect(calls[0]?.[0]).toBe('library:addData')
    expect(sent.files.map((f) => f.name)).toEqual(['people.md'])
    expect(new TextDecoder().decode(sent.files[0]?.data)).toBe('Mara is 35.')
    expect(toasts()[0]).toBe('huge.pdf: The file is larger than 25 MB.')
  })
})
