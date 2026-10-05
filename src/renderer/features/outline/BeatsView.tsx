import { useEffect, useMemo } from 'react'
import { groupByBeat, isTemplateBeat, type StructureTemplateId } from '@shared/structure'
import { useSceneMetaStore } from '@renderer/features/editor/sceneMetaStore'
import { useTreeStore } from '@renderer/features/manuscript/treeStore'
import { listOutline } from './outlineRows'

/**
 * The Outline tab's beat board (F-11.1b): the manuscript laid against the chosen structure
 * template. Holds every manuscript node's scene metadata while it is on screen (holder-counted,
 * so the metadata pane and the outline rows can hold the same ids) and groups the nodes by the
 * beat they carry in this template, in reading order. Per act a heading and its beats; a beat
 * lists its nodes as buttons that open them, or says it is empty. A count line says how many
 * beats are filled, and a footer how many manuscript documents sit on no beat. Read-only: the
 * beat is set in the metadata pane.
 */
export function BeatBoard({ template }: { template: StructureTemplateId }): React.JSX.Element {
  const rootIds = useTreeStore((s) => s.rootIds)
  const childrenOf = useTreeStore((s) => s.childrenOf)
  const sectionOf = useTreeStore((s) => s.sectionOf)
  const byId = useTreeStore((s) => s.byId)
  const metas = useSceneMetaStore((s) => s.docs)
  const load = useSceneMetaStore((s) => s.load)
  const unload = useSceneMetaStore((s) => s.unload)
  const ids = useMemo(
    () => listOutline(rootIds, childrenOf, sectionOf).map((row) => row.id),
    [rootIds, childrenOf, sectionOf]
  )

  useEffect(() => {
    for (const id of ids) void load(id)
    return () => {
      for (const id of ids) unload(id)
    }
  }, [ids, load, unload])

  const beatOf = (id: string): string | undefined => {
    const beat = metas[id]?.content?.beats[template]
    return beat !== undefined && isTemplateBeat(template, beat) ? beat : undefined
  }
  const board = groupByBeat(
    template,
    ids.map((id) => ({ id, beat: beatOf(id) }))
  )
  const unplaced = ids.filter(
    (id) => byId[id]?.kind === 'document' && beatOf(id) === undefined
  ).length

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-2">
      <p data-testid="beat-counts" className="m-0 pt-2 pb-1 text-xs text-fg-muted">
        {board.filled} of {board.total} beats filled
      </p>
      {board.acts.map((act) => (
        <section key={act.name} className="pb-2">
          <h3 className="m-0 pt-1 pb-0.5 text-xs font-semibold tracking-wide text-fg-muted uppercase">
            {act.name}
          </h3>
          <ol aria-label={act.name} className="m-0 flex list-none flex-col gap-1 p-0">
            {act.beats.map(({ beat, nodeIds }) => (
              <li
                key={beat.id}
                data-testid="beat"
                data-beat={beat.id}
                data-empty={nodeIds.length === 0}
                className="flex flex-col"
              >
                <span title={beat.hint} className="text-sm font-medium">
                  {beat.name}
                </span>
                {nodeIds.length === 0 ? (
                  <span className="mt-0.5 rounded-md border border-dashed border-line px-2 py-0.5 text-xs text-fg-subtle">
                    Empty beat
                  </span>
                ) : (
                  <ul className="m-0 flex list-none flex-col p-0 pl-2">
                    {nodeIds.map((id) => (
                      <BeatNode key={id} id={id} />
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ol>
        </section>
      ))}
      <p data-testid="beat-unplaced" className="m-0 pt-1 text-xs text-fg-muted">
        Not on a beat: {unplaced}
      </p>
    </div>
  )
}

/** One node on a beat: its title as a button that opens it, like an outline row. */
function BeatNode({ id }: { id: string }): React.JSX.Element | null {
  const node = useTreeStore((s) => s.byId[id])
  const selected = useTreeStore((s) => s.selectedId === id)
  const select = useTreeStore((s) => s.select)
  if (!node) return null
  return (
    <li className="flex min-w-0">
      <button
        type="button"
        aria-current={selected ? 'true' : undefined}
        onClick={() => select(id)}
        className={`min-w-0 truncate rounded-md px-1 py-0.5 text-left text-sm hover:bg-surface-raised ${
          selected ? 'bg-accent/15 text-fg' : ''
        } ${node.kind === 'document' ? '' : 'font-medium'}`}
      >
        {node.title}
      </button>
    </li>
  )
}
