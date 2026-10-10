import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultAiSettings, type AssistantMode } from '@shared/aiSettings'
import type { ChangeEntry } from '@shared/changes'
import type { Channel, Entity, Input, Output, Tag } from '@shared/ipc/contract'
import type { OrganiseChange } from '@shared/organise'
import { resetChangesStore, useChangesStore } from '@renderer/features/changes/changesStore'
import { resetAiActivityStore } from '@renderer/features/ai/aiActivityStore'
import { resetAiSettingsStore, useAiSettingsStore } from '@renderer/features/ai/aiSettingsStore'
import { resetProposalStore } from '@renderer/features/ai/proposalStore'
import { resetCategoryStore } from '@renderer/features/entities/categoryStore'
import { resetEntityStore, useEntityStore } from '@renderer/features/entities/entityStore'
import { resetTagStore, useTagStore } from '@renderer/features/tags/tagStore'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { setIpcClient } from '@renderer/lib/ipc'
import { offerShowing, resetOrganiseStore, useOrganiseStore } from './organiseStore'

type Handler = (input: unknown) => unknown
let calls: [Channel, unknown][]

const tag = (id: string, name: string): Tag => ({
  id,
  name,
  category: 'custom',
  color: '#6b7280',
  parentId: null,
  usageCount: 1,
  trackMentions: true,
  aliases: [],
  created: '2026-10-08T09:00:00.000Z',
  modified: '2026-10-08T09:00:00.000Z'
})
const weave: Entity = {
  id: 'weave',
  kind: 'world',
  name: 'The Weave',
  template: 'structured',
  fields: {},
  body: null,
  image: null,
  tagId: null,
  aliases: [],
  origin: 'author',
  status: 'canon',
  created: '2026-10-08T09:00:00.000Z',
  modified: '2026-10-08T09:00:00.000Z'
}

const CHANGES: OrganiseChange[] = [
  {
    id: 'c1',
    action: {
      kind: 'tag',
      tagId: 'rynna',
      name: 'rynna',
      patch: { category: 'character' },
      before: { category: 'custom' },
      parentName: null,
      beforeParentName: null
    },
    reason: 'a person',
    requires: []
  },
  {
    id: 'c2',
    action: {
      kind: 'mergeTags',
      target: { id: 'rynna', name: 'rynna' },
      sources: [{ id: 'falseer', name: 'rynna-falseer' }]
    },
    reason: '',
    requires: []
  },
  {
    id: 'c3',
    action: {
      kind: 'sheet',
      entityId: 'weave',
      name: 'The Weave',
      patch: { fields: { description: 'Threads of light.' } },
      before: { fields: { description: '' } }
    },
    reason: '',
    requires: []
  }
]

const planned = (): Output<'organise:plan'> => ({
  ok: true,
  plan: {
    reply: 'Tidied.',
    changes: CHANGES,
    skipped: ['deleteTag: #mill is still used'],
    chunks: 1
  },
  usage: { inputTokens: 900, outputTokens: 80 },
  costUsd: 0.004,
  cached: false,
  model: 'gpt-5.4',
  proposalId: 'p1',
  requestId: 'r'
})

function install(overrides: Partial<Record<Channel, Handler>> = {}): void {
  calls = []
  setIpcClient({
    async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
      calls.push([channel, input])
      const override = overrides[channel]
      if (override) return override(input) as Output<C>
      if (channel === 'organise:plan') return planned() as Output<C>
      if (channel === 'organise:candidates') {
        return { duplicates: [], unusedTags: [], emptySheets: [], notNames: [] } as Output<C>
      }
      if (channel === 'tag:update') {
        const { id, ...patch } = input as Input<'tag:update'>
        return { ...tag(id, 'rynna'), ...patch } as Output<C>
      }
      if (channel === 'tag:merge') {
        return {
          target: tag('rynna', 'rynna'),
          removedIds: ['falseer'],
          aliases: { falseer: 'rynna' }
        } as Output<C>
      }
      if (channel === 'entity:update') {
        const { id, fields } = input as Input<'entity:update'>
        return { ...weave, id, fields: { ...weave.fields, ...fields } } as Output<C>
      }
      if (channel === 'proposal:settle') return { settled: true } as Output<C>
      throw new Error(`unexpected ${channel}`)
    },
    on: () => () => {}
  })
}

const channels = (): Channel[] => calls.map(([channel]) => channel)
const statuses = (): Record<string, string> =>
  Object.fromEntries(
    Object.entries(useOrganiseStore.getState().views).map(([id, view]) => [id, view.status])
  )

function setMode(mode: AssistantMode): void {
  useAiSettingsStore.setState({ settings: { ...defaultAiSettings(), dial: 1, chatMode: mode } })
}

beforeEach(() => {
  useDialogStore.setState({ modals: [], toasts: [] })
  install()
  resetChangesStore()
  resetOrganiseStore()
  resetTagStore()
  resetEntityStore()
  resetCategoryStore()
  resetAiSettingsStore()
  resetAiActivityStore()
  resetProposalStore()
  useTagStore.setState({
    byId: { rynna: tag('rynna', 'rynna'), falseer: tag('falseer', 'rynna-falseer') },
    ids: ['rynna', 'falseer'],
    loaded: true
  })
  useEntityStore.setState({ byId: { weave }, ids: ['weave'], loaded: true })
  setMode('ask')
})

describe('useOrganiseStore (F-9.10)', () => {
  it('asks for a plan and, in Ask, waits for the author with every change undecided', async () => {
    await useOrganiseStore.getState().start({ instruction: 'Tidy the tags.', scope: ['tags'] })
    const state = useOrganiseStore.getState()
    expect(state).toMatchObject({ open: true, phase: 'ready', mode: 'ask', costUsd: 0.004 })
    expect(calls[0]?.[0]).toBe('organise:plan')
    expect(calls[0]?.[1]).toMatchObject({ instruction: 'Tidy the tags.', scope: ['tags'] })
    expect(statuses()).toEqual({ c1: 'pending', c2: 'pending', c3: 'pending' })
    expect(Object.values(state.views).every((view) => view.decision === 'pending')).toBe(true)
    expect(channels()).not.toContain('tag:update')
  })

  it('applies only the accepted changes through the stores, and undoes one', async () => {
    await useOrganiseStore.getState().start({ instruction: '', scope: [] })
    useOrganiseStore.getState().decide(['c1', 'c3'], 'accepted')
    useOrganiseStore.getState().decide(['c2'], 'skipped')
    await useOrganiseStore.getState().applyAccepted()
    expect(statuses()).toEqual({ c1: 'applied', c2: 'pending', c3: 'applied' })
    expect(useTagStore.getState().byId.rynna?.category).toBe('character')
    expect(useEntityStore.getState().byId.weave?.fields.description).toBe('Threads of light.')
    expect(channels()).not.toContain('tag:merge')

    await useOrganiseStore.getState().undo('c1')
    expect(statuses().c1).toBe('undone')
    expect(calls.at(-1)).toEqual(['tag:update', { id: 'rynna', category: 'custom' }])
  })

  it('finish applies the accepted, closes, and its toast Undo takes the run back (2026-10-10)', async () => {
    await useOrganiseStore.getState().start({ instruction: '', scope: [] })
    useOrganiseStore.getState().decide(['c1', 'c3'], 'accepted')
    useOrganiseStore.getState().decide(['c2'], 'skipped')
    await useOrganiseStore.getState().finish()
    expect(useOrganiseStore.getState().open).toBe(false)
    expect(useTagStore.getState().byId.rynna?.category).toBe('character')
    const [shown] = useDialogStore.getState().toasts
    expect(shown?.message).toBe('Organise applied 2 changes · 1 skipped')
    expect(shown?.action?.label).toBe('Undo')

    shown?.action?.run()
    await vi.waitFor(() => expect(useTagStore.getState().byId.rynna?.category).toBe('custom'))
    // Newest first: the sheet went back before the tag.
    const undone = calls.filter(([c]) => c === 'entity:update' || c === 'tag:update').slice(-2)
    expect(undone.map(([c]) => c)).toEqual(['entity:update', 'tag:update'])
  })

  it('finish with nothing accepted closes with a note and no Undo', async () => {
    await useOrganiseStore.getState().start({ instruction: '', scope: [] })
    useOrganiseStore.getState().decide(['c1', 'c2', 'c3'], 'rejected')
    await useOrganiseStore.getState().finish()
    expect(useOrganiseStore.getState().open).toBe(false)
    expect(useDialogStore.getState().toasts.map((t) => [t.message, t.action])).toEqual([
      ['Organise closed: nothing applied', undefined]
    ])
  })

  it('finish keeps the panel open when a change failed', async () => {
    install({
      'tag:update': () => {
        throw new Error('Database is locked')
      }
    })
    await useOrganiseStore.getState().start({ instruction: '', scope: [] })
    useOrganiseStore.getState().decide(['c1'], 'accepted')
    await useOrganiseStore.getState().finish()
    expect(useOrganiseStore.getState().open).toBe(true)
    expect(statuses().c1).toBe('failed')
    expect(useDialogStore.getState().toasts).toEqual([])
  })

  it('in Auto applies what can be undone at once; a merge still asks; Undo the whole reorganisation', async () => {
    setMode('auto')
    await useOrganiseStore.getState().start({ instruction: '', scope: [] })
    expect(statuses()).toEqual({ c1: 'applied', c2: 'pending', c3: 'applied' })
    await useOrganiseStore.getState().undoAll()
    expect(statuses()).toEqual({ c1: 'undone', c2: 'pending', c3: 'undone' })
    // Newest first: the sheet went back before the tag.
    const undone = calls.filter(([c]) => c === 'entity:update' || c === 'tag:update').slice(-2)
    expect(undone.map(([c]) => c)).toEqual(['entity:update', 'tag:update'])
    await useOrganiseStore.getState().applyAccepted()
    expect(statuses().c2).toBe('pending')
    useOrganiseStore.getState().decide(['c2'], 'accepted')
    await useOrganiseStore.getState().applyAccepted()
    expect(statuses().c2).toBe('applied')
    expect(useTagStore.getState().byId.falseer).toBeUndefined()
  })

  it('in Auto logs the run in Changes, whose Undo is the plan screen’s (F-9.15)', async () => {
    setMode('auto')
    const logged: ChangeEntry[] = []
    install({
      'changes:record': (input) => {
        const { source, run, changes } = input as Input<'changes:record'>
        const rows = changes.map((change): ChangeEntry => ({
          id: `log-${logged.length}`,
          runId: `${source}:${run}`,
          createdAt: '2026-10-09T10:00:00.000Z',
          nodeId: null,
          quote: null,
          kind: change.kind,
          entityId: null,
          label: change.label,
          status: 'applied',
          source,
          undoable: change.undo.type !== 'none'
        }))
        logged.push(...rows)
        return rows
      },
      'changes:undo': () => ({
        entries: [],
        removedEntityIds: [],
        removedTagIds: [],
        entityIds: [],
        nodeIds: [],
        entities: [],
        tags: []
      })
    })
    await useOrganiseStore.getState().start({ instruction: '', scope: [] })
    expect(logged.map((entry) => entry.kind)).toEqual(['tagEdit', 'sheetEdit'])
    expect(new Set(logged.map((entry) => entry.runId)).size).toBe(1)
    expect(logged[0]?.runId).toMatch(/^organise:/)
    expect(useChangesStore.getState().entries.map((entry) => entry.id)).toEqual(['log-1', 'log-0'])
    await useOrganiseStore.getState().undo('c3')
    expect(statuses().c3).toBe('undone')
    expect(calls.at(-1)).toEqual(['changes:undo', { id: 'log-1' }])
    expect(channels().filter((c) => c === 'entity:update')).toHaveLength(1)
  })

  it('lets the author pick another keeper for a merge before accepting it (Edit)', async () => {
    await useOrganiseStore.getState().start({ instruction: '', scope: [] })
    const merge = useOrganiseStore.getState().views.c2?.change.action
    if (merge?.kind !== 'mergeTags') throw new Error('fixture changed')
    useOrganiseStore.getState().setEditing('c2')
    expect(useOrganiseStore.getState().editingId).toBe('c2')
    useOrganiseStore.getState().editChange('c2', {
      ...merge,
      target: merge.sources[0] ?? merge.target,
      sources: [merge.target]
    })
    expect(useOrganiseStore.getState().editingId).toBeNull()
    const edited = useOrganiseStore.getState().views.c2?.change.action
    expect(edited?.kind === 'mergeTags' ? edited.target.id : null).toBe(merge.sources[0]?.id)
    // Another kind of change cannot replace it.
    useOrganiseStore.getState().editChange('c2', {
      kind: 'deleteTag',
      tagId: 'x',
      name: 'x',
      notName: false
    })
    expect(useOrganiseStore.getState().views.c2?.change.action.kind).toBe('mergeTags')
  })

  it('in Plan only describes', async () => {
    setMode('plan')
    await useOrganiseStore.getState().start({ instruction: '', scope: [] })
    useOrganiseStore.getState().decide(['c1', 'c2', 'c3'], 'accepted')
    await useOrganiseStore.getState().applyAccepted()
    expect(statuses()).toEqual({ c1: 'pending', c2: 'pending', c3: 'pending' })
    expect(useOrganiseStore.getState().views.c1?.decision).toBe('pending')
  })

  it('skips a change whose new category was not applied', async () => {
    install({
      'organise:plan': () => ({
        ...planned(),
        plan: {
          reply: '',
          skipped: [],
          chunks: 1,
          changes: [
            {
              id: 'c1',
              action: { kind: 'category', id: 'c-magic', name: 'Magic', noun: 'magic', fields: [] },
              reason: '',
              requires: []
            },
            {
              id: 'c2',
              action: {
                kind: 'sheet',
                entityId: 'weave',
                name: 'The Weave',
                patch: { kind: 'c-magic' },
                before: { kind: 'world', fields: {} }
              },
              reason: '',
              requires: ['c1']
            }
          ]
        }
      })
    })
    await useOrganiseStore.getState().start({ instruction: '', scope: [] })
    useOrganiseStore.getState().decide(['c2'], 'accepted')
    await useOrganiseStore.getState().applyAccepted()
    expect(statuses()).toEqual({ c1: 'pending', c2: 'pending' })
    expect(useOrganiseStore.getState().views.c2?.error).toMatch(/new category/)
  })

  it('shows a failure with its next step, and settles the proposal on close', async () => {
    install({
      'organise:plan': () => ({
        ok: false,
        code: 'PROVIDER',
        message: 'The plan was cut off.',
        nextStep: 'Try again.',
        requestId: 'r'
      })
    })
    await useOrganiseStore.getState().start({ instruction: '', scope: [] })
    expect(useOrganiseStore.getState()).toMatchObject({
      phase: 'failed',
      error: 'The plan was cut off. Try again.'
    })
    install()
    await useOrganiseStore.getState().start({ instruction: '', scope: [] })
    useOrganiseStore.getState().close()
    expect(calls.at(-1)).toEqual(['proposal:settle', { id: 'p1', status: 'rejected', note: null }])
    expect(useOrganiseStore.getState().open).toBe(false)
  })

  it('offers the local findings until the author waves that set away', async () => {
    install({
      'organise:candidates': () => ({
        duplicates: [{ of: 'tag', ids: ['rynna', 'falseer'], names: ['rynna', 'rynna-falseer'] }],
        unusedTags: [],
        emptySheets: [],
        notNames: []
      })
    })
    await useOrganiseStore.getState().refreshCandidates()
    expect(offerShowing(useOrganiseStore.getState())).toBe(true)
    useOrganiseStore.getState().dismissOffer()
    expect(offerShowing(useOrganiseStore.getState())).toBe(false)
    await useOrganiseStore.getState().refreshCandidates()
    expect(offerShowing(useOrganiseStore.getState())).toBe(false)
  })
})
