import type { FindingView } from '@shared/memory/findings'
import { useMemoryStore } from '@renderer/features/memory/memoryStore'
import { FindingRow, RightMarkLine, UnclearFindings } from './FindingRow'
import { touchesScene } from './findingView'
import { NoteConflictRow } from './NoteConflictRow'

/**
 * The contradictions under Needs a look's **Conflicts** (F-16.27, F-16.29; plan P4 §4): the lines
 * *This one's right* left this session, then the open findings touching the open scene ("In this
 * scene") and the rest ("Elsewhere in the book"), each book-against-book one a `FindingRow` and
 * each book-against-note one a `NoteConflictRow`, then the unclear ones behind a collapsed line.
 * P1's filed lines and P2a's typed details stay where the panel draws them, in the same group.
 */
export function Contradictions({
  findings,
  unclear,
  sceneId
}: {
  findings: readonly FindingView[]
  unclear: readonly FindingView[]
  sceneId: string | null
}): React.JSX.Element {
  const marks = useMemoryStore((s) => s.rightMarks)
  const here = findings.filter((finding) => touchesScene(finding, sceneId))
  const elsewhere = findings.filter((finding) => !touchesScene(finding, sceneId))
  return (
    <div className="text-xs" data-testid="contradictions">
      {marks.length === 0 ? null : (
        <ul className="m-0 mb-2 list-none space-y-1 p-0">
          {marks.map((mark) => (
            <RightMarkLine key={mark.findingId} mark={mark} />
          ))}
        </ul>
      )}
      <FindingList title="In this scene" findings={here} titled={elsewhere.length > 0} />
      <FindingList
        title="Elsewhere in the book"
        findings={elsewhere}
        titled={here.length > 0 || sceneId !== null}
      />
      <UnclearFindings findings={unclear} />
    </div>
  )
}

function FindingList({
  title,
  findings,
  titled
}: {
  title: string
  findings: readonly FindingView[]
  titled: boolean
}): React.JSX.Element | null {
  if (findings.length === 0) return null
  return (
    <div className="mb-2" role="group" aria-label={title}>
      {titled ? <p className="m-0 mb-1 text-[11px] text-fg-subtle">{title}</p> : null}
      <ul className="m-0 list-none space-y-2 p-0">
        {findings.map((finding) =>
          finding.rule === 'C6' ? (
            <NoteConflictRow key={finding.id} finding={finding} />
          ) : (
            <FindingRow key={finding.id} finding={finding} />
          )
        )}
      </ul>
    </div>
  )
}
