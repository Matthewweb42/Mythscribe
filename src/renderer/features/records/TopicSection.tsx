import { useId, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { KNOWER_KINDS } from '@shared/memory/knows'
import type { SceneRefView, SecretView } from '@shared/memory/views'
import { ClaimLine } from '@renderer/features/memory/ClaimLine'
import { TopicInfoCard } from '@renderer/features/memory/knows/TopicInfo'
import {
  holderLine,
  noHoldersText,
  noRevealText,
  otherKnowsText,
  readersSinceText
} from '@renderer/features/memory/knows/knowsView'
import { useNameOf } from '@renderer/features/memory/knows/useNameOf'
import { useMemoryStore, useSheetMemory } from '@renderer/features/memory/memoryStore'
import { staleNote } from '@renderer/features/memory/memoryView'
import { AsOfPicker } from './AsOfPicker'
import { useAsOf } from './asOf'
import { useRecordStore } from './recordStore'

const HEADING = 'm-0 text-xs font-semibold tracking-wide text-fg-muted uppercase'
const GROUP = 'm-0 mt-2 mb-0.5 text-[11px] font-medium text-fg-muted'
const SMALL =
  'rounded px-1.5 py-0.5 text-xs text-fg-muted hover:bg-surface-raised hover:text-fg disabled:opacity-40'

/**
 * A secret's sheet's **The secret** (F-16.22; plan P2b §4.2), in place of From the book: "readers
 * since 1.1"; its defining reveal with *Go there* and how it was checked, every reveal merged into
 * it with *Split*, and *Not a secret* when the AI made it (`TopicInfoCard`); then who knows it as
 * of [scene ▾] (each line with ⓘ and *Not right*; the author's marks with *Remove*; the lines that
 * never count apart; how many learn it later; with no line, the scoped "No scene shows anyone
 * learning this (checked up to 1.2)", P2b rule 9) and *+ Someone knew before the book* with a
 * picker of the characters and groups.
 */
export function TopicSection({ recordId }: { recordId: string }): React.JSX.Element {
  const { asOf, scenes, setAsOf } = useAsOf()
  const sheet = useSheetMemory(recordId, asOf)
  const topic = sheet?.topic ?? null
  return (
    <section aria-label="The secret" className="flex flex-col gap-1" data-testid="topic-section">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className={HEADING}>The secret</h3>
        <AsOfPicker scenes={scenes} value={asOf} onChange={setAsOf} />
      </div>
      {sheet === undefined ? (
        <p className="m-0 text-xs text-fg-muted">Reading…</p>
      ) : topic?.kind !== 'secret' ? (
        <p className="m-0 text-xs text-fg-muted">Nothing read about this secret yet.</p>
      ) : (
        <SecretBody secret={topic.secret} checkedUpTo={topic.checkedUpTo} />
      )}
    </section>
  )
}

function SecretBody({
  secret,
  checkedUpTo
}: {
  secret: SecretView
  checkedUpTo: SceneRefView | null
}): React.JSX.Element {
  const nameOf = useNameOf()
  const paused = useMemoryStore((s) => s.status?.paused ?? null)
  const holders = secret.cells.filter((cell) => !cell.later)
  const later = secret.cells.filter((cell) => cell.later).length
  return (
    <>
      <p className="m-0 text-xs text-fg-muted" data-testid="topic-readers-since">
        {secret.readersSince === null
          ? noRevealText(checkedUpTo)
          : readersSinceText(secret.readersSince)}
      </p>
      <TopicInfoCard topic={secret} kind="secret" />
      <div role="group" aria-label="Who knows it">
        <h4 className={GROUP}>Who knows it</h4>
        {holders.length === 0 ? (
          <p className="m-0 text-xs text-fg-muted" data-testid="topic-no-holders">
            {noHoldersText(checkedUpTo)}
          </p>
        ) : (
          <ul className="m-0 list-none p-0">
            {holders.map((cell) =>
              cell.claimId === null ? (
                <li key={cell.knowerId} className="flex items-baseline gap-1 py-0.5 text-sm">
                  <span>{holderLine(cell, nameOf)}</span>
                  <RemoveMark secretId={secret.recordId} recordId={cell.knowerId} />
                </li>
              ) : (
                <ClaimLine
                  key={cell.knowerId}
                  claimId={cell.claimId}
                  text={holderLine(cell, nameOf)}
                  stale={cell.stale}
                  staleNote={staleNote(paused)}
                  recordId={cell.knowerId}
                  notAboutKinds={KNOWER_KINDS}
                  muted={cell.line === 'partial'}
                />
              )
            )}
          </ul>
        )}
        {secret.others.length === 0 ? null : (
          <ul className="m-0 list-none p-0 opacity-75" aria-label="Not counted as knowing">
            {secret.others.map((cell) =>
              cell.claimId === null ? null : (
                <ClaimLine
                  key={cell.claimId}
                  claimId={cell.claimId}
                  text={`${nameOf(cell.knowerId)}: ${otherKnowsText(secret.label, cell, nameOf)}`}
                  note={cell.ref}
                  stale={cell.stale}
                  staleNote={staleNote(paused)}
                  recordId={cell.knowerId}
                  notAboutKinds={KNOWER_KINDS}
                  muted
                />
              )
            )}
          </ul>
        )}
        {later === 0 ? null : (
          <p className="m-0 mt-1 text-xs text-fg-muted">
            {later} more learn{later === 1 ? 's' : ''} it later in the book
          </p>
        )}
      </div>
      <KnewBeforePicker secret={secret} />
    </>
  )
}

function RemoveMark({
  secretId,
  recordId
}: {
  secretId: string
  recordId: string
}): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  return (
    <button
      type="button"
      className={`${SMALL} ml-auto`}
      disabled={busy}
      onClick={() => {
        setBusy(true)
        void useMemoryStore
          .getState()
          .knewBefore(secretId, recordId, false)
          .finally(() => setBusy(false))
      }}
    >
      Remove
    </button>
  )
}

/** *+ Someone knew before the book*: a character or group the author says knew it already. */
function KnewBeforePicker({ secret }: { secret: SecretView }): React.JSX.Element {
  const pickId = useId()
  const [open, setOpen] = useState(false)
  const [picked, setPicked] = useState('')
  const [busy, setBusy] = useState(false)
  const knowers = useRecordStore(
    useShallow((s) =>
      s.ids
        .flatMap((id) => s.byId[id] ?? [])
        .filter(
          (record) => KNOWER_KINDS.includes(record.kind) && !secret.knewBefore.includes(record.id)
        )
        .sort((a, b) => a.name.localeCompare(b.name))
    )
  )
  if (!open) {
    return (
      <button
        type="button"
        className={`${SMALL} self-start`}
        disabled={knowers.length === 0}
        onClick={() => setOpen(true)}
      >
        + Someone knew before the book
      </button>
    )
  }
  const add = async (): Promise<void> => {
    if (picked === '') return
    setBusy(true)
    const done = await useMemoryStore.getState().knewBefore(secret.recordId, picked, true)
    setBusy(false)
    if (done) {
      setPicked('')
      setOpen(false)
    }
  }
  return (
    <div className="flex flex-wrap items-center gap-1 text-xs">
      <label htmlFor={pickId} className="text-fg-muted">
        Knew it before the book:
      </label>
      <select
        id={pickId}
        value={picked}
        disabled={busy}
        onChange={(event) => setPicked(event.target.value)}
        className="min-w-0 rounded-md border border-line bg-bg px-1 py-0.5 text-xs"
      >
        <option value="">Choose…</option>
        {knowers.map((record) => (
          <option key={record.id} value={record.id}>
            {record.name}
          </option>
        ))}
      </select>
      <button
        type="button"
        className={SMALL}
        disabled={busy || picked === ''}
        onClick={() => void add()}
      >
        Add
      </button>
      <button type="button" className={SMALL} disabled={busy} onClick={() => setOpen(false)}>
        Cancel
      </button>
    </div>
  )
}
