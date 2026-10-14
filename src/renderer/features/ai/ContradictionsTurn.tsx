import type { ContradictionsTurn as Turn } from '@shared/chat'
import { useMemoryStore } from '@renderer/features/memory/memoryStore'
import {
  CHECK_OFF_LINE,
  contradictionsScoped,
  findingRuleLine
} from '@renderer/features/memory/needsALook/findingView'
import { openSide } from '@renderer/features/memory/needsALook/openSide'

const LINK_BUTTON =
  'rounded px-1 text-xs text-accent underline-offset-2 hover:underline disabled:text-fg-muted disabled:no-underline'

/**
 * The chat's answer to "Check this scene for consistency" in story memory v2 (P4-D23), made
 * locally from the open scene's findings with no request: each possible contradiction in its
 * rule's words with *Go there* on each side in the book; the scoped lines ("No possible
 * contradictions found in this scene so far", the sentences not read yet, pairs not judged yet),
 * muted and drawn from the turn alone, never part of its text; and *Check the book…*, which opens
 * the priced dialog.
 */
export function ContradictionsTurn({ turn }: { turn: Turn }): React.JSX.Element {
  const scoped = contradictionsScoped(turn)
  return (
    <div className="flex flex-col gap-1.5" data-testid="contradictions-turn">
      {!turn.on ? <p className="m-0">{CHECK_OFF_LINE}</p> : null}
      {turn.findings.length === 0 ? null : (
        <>
          <p className="m-0">Possible contradictions in this scene:</p>
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {turn.findings.map((finding) => (
              <li key={finding.id} className="rounded-md bg-surface-raised px-2 py-1">
                <p className="m-0">{findingRuleLine(finding)}</p>
                <div className="flex flex-wrap gap-1">
                  {[finding.a, finding.b].map((side) => (
                    <button
                      key={`${side.kind}:${side.label}:${side.quote}`}
                      type="button"
                      className={LINK_BUTTON}
                      title={side.quote}
                      onClick={() => openSide(side)}
                    >
                      {side.kind === 'note' ? side.label : `Go to ${side.label}`}
                    </button>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
      {scoped.length === 0 ? null : (
        <ul className="m-0 list-none p-0 text-xs text-fg-muted" data-testid="contradictions-scoped">
          {scoped.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
      <button
        type="button"
        className={`self-start ${LINK_BUTTON}`}
        onClick={() => useMemoryStore.getState().setCheckOpen('start')}
      >
        Check the book…
      </button>
    </div>
  )
}
