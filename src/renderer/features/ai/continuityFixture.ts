import type { ContinuityFinding, ContinuityRef } from '@shared/continuity'
import type { AiContinuityResult, TreeNode } from '@shared/ipc/contract'

/** The scene the continuity tests open: its first paragraph carries the contradiction. */
export const CONTINUITY_FIRST = 'Mara was twenty-nine that spring. The rain held off.'
export const CONTINUITY_SECOND = 'Her hair was red, as it had always been, and nobody remarked.'
export const CONTINUITY_FIX = 'Mara was thirty-four that spring.'

export const sheetRef = (over: Partial<ContinuityRef> = {}): ContinuityRef => ({
  kind: 'sheet',
  entityId: 'e-mara',
  entityName: 'Mara',
  entityKind: 'character',
  attribute: 'age',
  label: 'Age',
  value: '34',
  nodeId: null,
  quote: null,
  ...over
})

export const factRef = (over: Partial<ContinuityRef> = {}): ContinuityRef => ({
  kind: 'fact',
  entityId: 'e-mara',
  entityName: 'Mara',
  entityKind: 'character',
  attribute: 'appearance',
  label: 'Appearance',
  value: 'black hair',
  nodeId: 'sc-2',
  quote: 'Her black hair caught the light.',
  ...over
})

export const finding = (over: Partial<ContinuityFinding> = {}): ContinuityFinding => ({
  id: 'f-1',
  nodeId: 'sc-1',
  ref: sheetRef(),
  quote: 'Mara was twenty-nine that spring.',
  why: 'Her sheet gives her age as 34.',
  fix: CONTINUITY_FIX,
  flagged: false,
  violation: null,
  status: 'open',
  origin: 'request',
  proposalId: 'p1',
  createdAt: '2026-10-02T10:00:00.000Z',
  ...over
})

/** A second finding of the same scene and run: the hair, against another scene's passage. */
export const hairFinding = (over: Partial<ContinuityFinding> = {}): ContinuityFinding =>
  finding({
    id: 'f-2',
    ref: factRef(),
    quote: 'Her hair was red',
    why: 'An earlier scene gives her black hair.',
    fix: 'Her hair was black',
    ...over
  })

export const continuityOk = (
  requestId: string,
  over: Partial<Extract<AiContinuityResult, { ok: true }>> = {}
): AiContinuityResult => ({
  ok: true,
  findings: [finding(), hairFinding()],
  truncated: false,
  dropped: 0,
  references: 4,
  usage: { inputTokens: 700, outputTokens: 90 },
  costUsd: 0.01,
  cached: false,
  model: 'gpt-5.4',
  proposalId: 'p1',
  requestId,
  ...over
})

const node = (id: string, over: Partial<TreeNode>): TreeNode => ({
  id,
  parentId: null,
  sectionType: null,
  kind: 'document',
  hierarchyLevel: 'scene',
  title: id,
  position: 0,
  wordCount: 0,
  matterType: null,
  preset: null,
  created: 'c',
  modified: 'm',
  ...over
})

/** A manuscript with two scenes and a front-matter page. */
export const continuityTree: TreeNode[] = [
  node('front', { sectionType: 'front', kind: 'folder', hierarchyLevel: null, title: 'Front' }),
  node('ms', {
    sectionType: 'manuscript',
    kind: 'folder',
    hierarchyLevel: null,
    title: 'Manuscript',
    position: 1
  }),
  node('title-page', { parentId: 'front', hierarchyLevel: null, title: 'Title page' }),
  node('sc-1', { parentId: 'ms', title: 'The Ridge' }),
  node('sc-2', { parentId: 'ms', title: 'The Harbor', position: 1 })
]
