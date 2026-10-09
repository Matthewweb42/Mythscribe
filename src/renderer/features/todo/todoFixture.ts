import type { TodoCheck, TodoItem } from '@shared/todo'

/** One open To do item for the renderer tests; `over` replaces any field. */
export const todoItem = (id: string, over: Partial<TodoItem> = {}): TodoItem => ({
  id,
  kind: 'undefined',
  rule: 'emptyRecord',
  source: 'local',
  subject: id,
  entityId: 'e-1',
  nodeId: 'sc-1',
  quote: 'Mara reached the Hollowing at dusk.',
  why: 'Named in 2 scenes, but its sheet is empty.',
  target: { kind: 'field', entityId: 'e-1', field: 'description' },
  targetLabel: 'Hollowing › Description',
  suggestions: [],
  suggested: false,
  status: 'open',
  createdAt: '2026-10-09T10:00:00.000Z',
  ...over
})

/** The AI check's header for the renderer tests: not allowed unless `over` says so. */
export const todoCheck = (over: Partial<TodoCheck> = {}): TodoCheck => ({
  allowed: false,
  lastAt: null,
  lastCostUsd: null,
  estimateUsd: null,
  fresh: false,
  ...over
})
