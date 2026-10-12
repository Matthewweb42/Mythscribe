import { z } from 'zod'
import { DEFAULT_CATEGORY_COLOR, HEX_COLOR } from './tags'

/**
 * Labels (F-16.7, answer 2): the few the author picks for herself (tone, content warnings,
 * "needs research") to filter scenes and Research documents by. The AI never creates or touches
 * them. Tone, content and theme labels steer prose (P1 slice 5, through `labelSteerLines`);
 * custom labels stay local. (`labels.ts` is the section vocabulary, hence this file's name.)
 */

export const LABEL_KINDS = ['tone', 'content', 'theme', 'custom'] as const
export const LabelKind = z.enum(LABEL_KINDS)
export type LabelKind = z.infer<typeof LabelKind>

/** The longest label name. */
export const LABEL_NAME_MAX = 60
/** Most labels one project keeps. */
export const LABELS_MAX = 200

/** A new label's colour by kind: tone and content keep the v1 tag colours. */
export const LABEL_DEFAULT_COLOUR: Record<LabelKind, string> = {
  tone: DEFAULT_CATEGORY_COLOR.tone,
  content: DEFAULT_CATEGORY_COLOR.content,
  theme: DEFAULT_CATEGORY_COLOR.plotThread,
  custom: DEFAULT_CATEGORY_COLOR.custom
}

export const LabelName = z.string().trim().min(1).max(LABEL_NAME_MAX)
export const LabelColour = z.string().regex(HEX_COLOR)

export const Label = z.object({
  id: z.string(),
  name: z.string(),
  colour: LabelColour,
  kind: LabelKind,
  /** 0-based, contiguous: the order the author keeps them in. */
  position: z.number().int(),
  created: z.string(),
  modified: z.string()
})
export type Label = z.infer<typeof Label>

/** One label on one scene or Research document (`label:links`). */
export const LabelLink = z.object({ labelId: z.string(), nodeId: z.string() })
export type LabelLink = z.infer<typeof LabelLink>

/** The key label names are unique by (case-insensitively, as sheet names are). */
export function labelNameKey(name: string): string {
  return name.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase()
}

/** The prose-steering line per kind, in this order; custom labels never steer. */
const STEER: readonly { kind: Exclude<LabelKind, 'custom'>; heading: string }[] = [
  { kind: 'tone', heading: 'Tone (write in it):' },
  { kind: 'content', heading: 'Content (keep to it):' },
  { kind: 'theme', heading: 'Themes (keep in view):' }
]

/**
 * The scene's steering lines for the Story notes block (P1 slice 5): `Tone (write in it): a, b`,
 * then Content, then Themes, each only when the scene has such a label, names in the order given.
 * Custom labels are left out (decision P1-D6).
 */
export function labelSteerLines(labels: readonly Pick<Label, 'name' | 'kind'>[]): string[] {
  return STEER.flatMap(({ kind, heading }) => {
    const names = labels.filter((label) => label.kind === kind).map((label) => label.name)
    return names.length === 0 ? [] : [`${heading} ${names.join(', ')}`]
  })
}
