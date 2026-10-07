import type { ContextFile, ContextReview } from '@shared/contextLibrary'

/** Test fixtures for the context library (F-9.8): a stored file and a review of two sheets. */
export function contextFileFixture(over: Partial<ContextFile> = {}): ContextFile {
  return {
    id: 'f1',
    name: 'people.md',
    type: 'md',
    size: 120,
    words: 20,
    state: 'new',
    created: '2026-10-07T09:00:00.000Z',
    modified: '2026-10-07T09:00:00.000Z',
    processedAt: null,
    ...over
  }
}

export function contextReviewFixture(): ContextReview {
  return {
    fileIds: ['f1'],
    entities: [
      {
        id: 'e1',
        kind: 'character',
        name: 'Mara Vell',
        existingId: 'mara',
        include: true,
        tag: null,
        records: [
          {
            id: 'r1',
            fileId: 'f1',
            fileName: 'people.md',
            kind: 'character',
            name: 'Mara',
            aliases: ['Mara Vell'],
            fields: { age: '35' },
            details: []
          },
          {
            id: 'r2',
            fileId: 'f1',
            fileName: 'people.md',
            kind: 'character',
            name: 'Mara Vell',
            aliases: [],
            fields: { appearance: 'Grey eyes' },
            details: ['History: ran the ferry.']
          }
        ],
        fields: [
          { field: 'age', upload: '35', existing: '34', include: true, choice: 'existing' },
          { field: 'appearance', upload: 'Grey eyes', existing: null, include: true, choice: 'upload' }
        ],
        details: ['History: ran the ferry.'],
        includeDetails: true,
        images: []
      },
      {
        id: 'e2',
        kind: 'character',
        name: 'Tomas',
        existingId: null,
        include: true,
        tag: true,
        records: [
          {
            id: 'r3',
            fileId: 'f1',
            fileName: 'people.md',
            kind: 'character',
            name: 'Tomas',
            aliases: [],
            fields: {},
            details: []
          }
        ],
        fields: [],
        details: [],
        includeDetails: true,
        images: []
      }
    ],
    notes: { existingId: null, paragraphs: ['Theme: debts.'], include: true },
    proposalIds: ['p1'],
    chunks: 1,
    usage: { inputTokens: 900, outputTokens: 120 },
    costUsd: 0.004,
    model: 'gpt-5.4',
    promptVersion: 'contextImport.v1'
  }
}
