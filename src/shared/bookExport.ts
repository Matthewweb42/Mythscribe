import { z } from 'zod'

/**
 * What a compile is asked to cover and how it reports progress (F-12.1, kept by Compile v2 when
 * the compile window replaced the Export dialog): `ExportScope` is the compile quick pick
 * (`CompileScope`), `ExportProgress` the `export:progress` event `compile:run` pushes.
 */

/**
 * What goes in: the whole manuscript section; the chosen chapters (with the parts that hold
 * them as headings); or one document from any section, printed alone.
 */
export const ExportScope = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('manuscript') }),
  z.object({ kind: z.literal('chapters'), ids: z.array(z.string()).min(1) }),
  z.object({ kind: z.literal('document'), id: z.string() })
])
export type ExportScope = z.infer<typeof ExportScope>

export const EXPORT_STAGES = ['collect', 'render', 'write'] as const
export const ExportStage = z.enum(EXPORT_STAGES)
export type ExportStage = z.infer<typeof ExportStage>

/** One step of a running compile, pushed as `export:progress`; `done` of `total` within the stage. */
export const ExportProgress = z.object({
  requestId: z.string(),
  stage: ExportStage,
  done: z.number().int().nonnegative(),
  total: z.number().int().nonnegative()
})
export type ExportProgress = z.infer<typeof ExportProgress>
