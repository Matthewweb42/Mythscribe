import type { AgeView } from '@shared/memory/views'
import { ClaimLine } from '@renderer/features/memory/ClaimLine'
import { useMemoryStore, useSheetMemory } from '@renderer/features/memory/memoryStore'
import { staleNote } from '@renderer/features/memory/memoryView'
import {
  ageText,
  bornText,
  noAgeText,
  statedText
} from '@renderer/features/memory/timeline/timeView'
import { AsOfPicker } from './AsOfPicker'
import { useAsOf } from './asOf'

const HEADING = 'm-0 text-xs font-semibold tracking-wide text-fg-muted uppercase'

/**
 * A character's **Age, as of [scene ▾]** (F-16.23; design §2.7 "Years and ages", decision 5, plan
 * P2b §5.2): "about 19 · year from 1.1" with the birth year it counts from ("Born: 1792", noted
 * "1.1", with ⓘ and *Not right*; or the author's Pinned line), or the last stated age with the
 * year-crossing hints since, listed and never added up ("19, stated in 2.1 · since then: “Three
 * winters later” (14.1)", its line with ⓘ), or, where the scene's year is not known, the birth
 * year alone and why ("born 1792 · this scene’s year not known since “A year later” (1.3)"). With
 * neither, it says so scoped to what was read: "No birth year or stated age read (checked up to
 * 1.2)" (P2b rule 9).
 */
export function AgeSection({ recordId }: { recordId: string }): React.JSX.Element {
  const { asOf, scenes, setAsOf } = useAsOf()
  const sheet = useSheetMemory(recordId, asOf)
  const age = sheet?.age?.age ?? null
  return (
    <section aria-label="Age" className="flex flex-col gap-1" data-testid="age-section">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className={HEADING}>Age</h3>
        <AsOfPicker scenes={scenes} value={asOf} onChange={setAsOf} />
      </div>
      {sheet === undefined ? (
        <p className="m-0 text-xs text-fg-muted">Reading…</p>
      ) : age === null ? (
        <p className="m-0 text-xs text-fg-muted italic" data-testid="age-none">
          {noAgeText(sheet.age?.checkedUpTo ?? null)}
        </p>
      ) : (
        <AgeBody age={age} recordId={recordId} />
      )}
    </section>
  )
}

function AgeBody({ age, recordId }: { age: AgeView; recordId: string }): React.JSX.Element {
  const paused = useMemoryStore((s) => s.status?.paused ?? null)
  const evidence =
    age.kind === 'stated'
      ? { claimId: age.claimId, text: statedText(age), ref: age.ref }
      : age.born.source === 'text' && age.born.claimId !== null
        ? { claimId: age.born.claimId, text: bornText(age.born), ref: age.born.ref }
        : null
  return (
    <>
      <p className="m-0 text-sm" data-testid="age-line">
        {ageText(age)}
      </p>
      {evidence === null ? (
        age.kind === 'stated' ? null : (
          <p className="m-0 text-xs text-fg-muted">{bornText(age.born)}</p>
        )
      ) : (
        <ul className="m-0 list-none p-0">
          <ClaimLine
            claimId={evidence.claimId}
            text={evidence.text}
            note={evidence.ref}
            staleNote={staleNote(paused)}
            recordId={recordId}
          />
        </ul>
      )}
    </>
  )
}
