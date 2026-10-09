import type { Fact } from '@shared/facts'

const fact = (
  id: string,
  entityId: string,
  nodeId: string,
  attribute: string,
  value: string,
  quote: string,
  hidden = false
): Fact => ({
  id,
  entityId,
  attribute,
  value,
  objectEntityId: null,
  nodeId,
  quote,
  origin: 'ai',
  status: 'canon',
  hidden,
  createdAt: `2026-10-02T10:00:0${id.slice(-1)}.000Z`,
  updatedAt: `2026-10-02T10:00:0${id.slice(-1)}.000Z`
})

/**
 * AI facts for the entity fixture (F-9.13), oldest first as main lists them. Mara: an age stated
 * in two scenes (one value, two passages), a second age stated later, an appearance, a goal, and
 * one hidden background. Aldous (blank page): one personality fact.
 */
export const factFixture: Fact[] = [
  fact('f-1', 'e-mara', 'sc-2', 'age', '34.', 'Mara was thirty-four that winter'),
  fact('f-2', 'e-mara', 'sc-1', 'age', '34', 'She had turned thirty-four'),
  fact('f-3', 'e-mara', 'sc-4', 'age', '29', 'Mara, twenty-nine, laughed'),
  fact('f-4', 'e-mara', 'sc-1', 'appearance', 'Grey eyes', 'her grey eyes'),
  fact('f-5', 'e-mara', 'sc-2', 'goals', 'Find the lost chart', 'she meant to find the lost chart'),
  fact('f-6', 'e-mara', 'sc-1', 'background', 'Born at sea', 'born at sea', true),
  fact('f-7', 'e-aldous', 'sc-1', 'personality', 'Patient', 'Aldous waited, patient as ever')
]
