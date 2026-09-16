import type { Editor } from '@tiptap/core'
import {
  BETA_READER_CATEGORIES,
  BETA_READER_CATEGORY_LABEL,
  BETA_READER_SCENE_CHAR_BUDGET,
  type BetaReaderCategory,
  type BetaReaderItem
} from '@shared/betaReader'
import { normalizeProposalNote, PROPOSAL_NOTE_MAX } from '@shared/proposal'
import { formatRequestCost } from '@renderer/features/ai/usageFormat'
import { dialogs } from '@renderer/features/shell/dialogs/dialogStore'
import { useBetaReaderStore, type BetaReaderSession } from './betaReaderStore'
import { HonestySelect } from './HonestySelect'

const BUTTON =
  'flex items-center gap-1 rounded-md px-2 py-1 text-xs text-fg-muted hover:bg-surface-raised hover:text-fg disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-fg-muted'
const QUOTE_BUTTON =
  'm-0 block w-full cursor-pointer border-0 border-l-2 border-line bg-transparent px-2 py-0.5 text-left text-sm italic text-fg-muted hover:border-accent hover:text-fg'
const QUOTE_TEXT =
  'm-0 block w-full border-l-2 border-line px-2 py-0.5 text-left text-sm italic text-fg-muted'

/** What the panel says under an item whose quote is no longer in the scene. */
export const BETA_READER_PASSAGE_GONE_MESSAGE = 'That passage has changed; ask for a new read of it'

/** Plain-language counts for what the reader could not read (F-5.6 supplies the summaries). */
const skippedMessage = (n: number): string =>
  n === 1
    ? 'The reader skipped the first scene to fit the budget'
    : `The reader skipped the first ${n} scenes to fit the budget`
const missingMessage = (n: number): string =>
  n === 1
    ? '1 earlier scene has no summary yet; turn on Scene summaries and open it so the reader can read it'
    : `${n} earlier scenes have no summary yet; turn on Scene summaries and open them so the reader can read them`

/**
 * The beta reader's read-through up to this scene (F-14.11), shown while the beta reader store
 * holds a session for this document. Pending shows the wait with Stop; the answer groups the
 * items by what they are about (knows, believes, expects, confusion, dropped threads) under a
 * small heading each, empty groups hidden. Every item cites a passage: one from this scene is a
 * button that selects it in the text, one from an earlier scene names that scene instead, since
 * the reader read it as its summary and its words are not in this editor. There is nothing to
 * apply — a reader reports and an editor fixes (F-14.8) — so Close settles the proposal as
 * declined and "Read again…" regenerates with the author's note (F-14.5). The honesty setting
 * is the editor's (F-14.4, per project) and sits in the header in every state.
 */
export function BetaReaderPanel({
  id,
  editor
}: {
  id: string
  editor: Editor | null
}): React.JSX.Element | null {
  const session = useBetaReaderStore((s) => (s.session?.nodeId === id ? s.session : null))
  if (session === null) return null
  return (
    <section
      aria-label="Beta reader"
      data-testid="beta-reader-panel"
      className="flex max-h-[45vh] shrink-0 flex-col gap-2 overflow-y-auto border-b border-line bg-surface px-4 py-2 text-sm"
    >
      <Body session={session} editor={editor} />
    </section>
  )
}

function Body({
  session,
  editor
}: {
  session: BetaReaderSession
  editor: Editor | null
}): React.JSX.Element {
  const stop = useBetaReaderStore((s) => s.stop)
  const close = useBetaReaderStore((s) => s.close)
  const regenerate = useBetaReaderStore((s) => s.regenerate)
  const { result } = session

  if (session.status === 'pending') {
    return (
      <>
        <HonestySelect title="Reading up to here…" testId="beta-reader-honesty" />
        <p
          data-testid="beta-reader-pending"
          className="m-0 text-xs text-fg-muted"
          aria-live="polite"
        >
          Your beta reader is reading up to here.
        </p>
        <div className="flex gap-2">
          <button type="button" data-testid="beta-reader-stop" onClick={stop} className={BUTTON}>
            Stop
          </button>
        </div>
      </>
    )
  }

  if (session.status === 'error' || result === null) {
    return (
      <>
        <HonestySelect title="Beta reader failed" testId="beta-reader-honesty" />
        <p role="alert" data-testid="beta-reader-error" className="m-0 text-xs text-danger">
          {session.error ?? 'Something went wrong'}
        </p>
        <div className="flex gap-2">
          <button type="button" data-testid="beta-reader-close" onClick={close} className={BUTTON}>
            Close
          </button>
        </div>
      </>
    )
  }

  const askAndRegenerate = (): void => {
    void dialogs
      .prompt({
        title: 'What should the reader do differently?',
        message: 'Optional. Your note goes into the next request and stays with this proposal.',
        placeholder: 'e.g. read as someone who skipped the prologue',
        confirmLabel: 'Read again',
        validate: (value) =>
          value.trim().length > PROPOSAL_NOTE_MAX
            ? `Keep the note under ${PROPOSAL_NOTE_MAX} characters.`
            : null
      })
      .then((answer) => {
        if (answer === null) return
        regenerate(normalizeProposalNote(answer))
      })
  }

  // The item's place in the session is what `show` and the stale flags are keyed on, so the
  // grouping carries it rather than the position inside the group.
  const groups = BETA_READER_CATEGORIES.map((category) => ({
    category,
    entries: session.items
      .map((item, index) => ({ item, index }))
      .filter((entry) => entry.item.category === category)
  })).filter((group) => group.entries.length > 0)

  return (
    <>
      <HonestySelect title="Beta reader" testId="beta-reader-honesty" />
      {result.truncated ? (
        <p data-testid="beta-reader-truncated" className="m-0 text-xs text-warning">
          {`Only the first ${BETA_READER_SCENE_CHAR_BUDGET.toLocaleString()} characters of this scene were read.`}
        </p>
      ) : null}
      {result.skipped > 0 ? (
        <p data-testid="beta-reader-skipped" className="m-0 text-xs text-warning">
          {skippedMessage(result.skipped)}
        </p>
      ) : null}
      {result.missing > 0 ? (
        <p data-testid="beta-reader-missing" className="m-0 text-xs text-warning">
          {missingMessage(result.missing)}
        </p>
      ) : null}
      {groups.length === 0 ? (
        <p data-testid="beta-reader-empty" className="m-0 text-xs text-fg-muted">
          The reader had nothing to report.
        </p>
      ) : (
        groups.map((group) => (
          <Group
            key={group.category}
            category={group.category}
            entries={group.entries}
            session={session}
            editor={editor}
          />
        ))
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          data-testid="beta-reader-regenerate"
          onClick={askAndRegenerate}
          className={BUTTON}
        >
          Read again…
        </button>
        <button type="button" data-testid="beta-reader-close" onClick={close} className={BUTTON}>
          Close
        </button>
        <span data-testid="beta-reader-cost" className="text-xs text-fg-subtle">
          {`${result.model} · ${formatRequestCost(result.costUsd)}${result.cached ? ' · cached' : ''}`}
        </span>
        {result.dropped > 0 ? (
          <span data-testid="beta-reader-dropped" className="text-xs text-fg-subtle">
            {`${result.dropped} uncited ${result.dropped === 1 ? 'item' : 'items'} dropped`}
          </span>
        ) : null}
      </div>
    </>
  )
}

/** One category of the report: its label as a heading over the items that belong to it. */
function Group({
  category,
  entries,
  session,
  editor
}: {
  category: BetaReaderCategory
  entries: { item: BetaReaderItem; index: number }[]
  session: BetaReaderSession
  editor: Editor | null
}): React.JSX.Element {
  return (
    <div data-testid="beta-reader-group" data-category={category} className="flex flex-col gap-1">
      <h3 className="m-0 text-[0.65rem] font-medium uppercase tracking-wide text-fg-subtle">
        {BETA_READER_CATEGORY_LABEL[category]}
      </h3>
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {entries.map(({ item, index }) => (
          <Item
            key={`${item.scene}:${item.quote}:${index}`}
            item={item}
            index={index}
            session={session}
            editor={editor}
          />
        ))}
      </ul>
    </div>
  )
}

function Item({
  item,
  index,
  session,
  editor
}: {
  item: BetaReaderItem
  index: number
  session: BetaReaderSession
  editor: Editor | null
}): React.JSX.Element {
  const show = useBetaReaderStore((s) => s.show)
  const scene = session.scenes[item.scene - 1]
  const here = scene?.current === true
  const stale = session.stale[index] === true

  return (
    <li
      data-testid="beta-reader-item"
      data-category={item.category}
      className="flex flex-col gap-1 rounded-md border-l-2 border-line bg-surface-raised p-2"
    >
      {here ? (
        <button
          type="button"
          data-testid="beta-reader-quote"
          title="Show this passage in the scene"
          onClick={() => {
            if (editor) show(index, editor)
          }}
          className={QUOTE_BUTTON}
        >
          {item.quote}
        </button>
      ) : (
        <>
          <span
            data-testid="beta-reader-scene"
            className="self-start rounded-sm bg-surface px-1.5 py-0.5 text-[0.65rem] font-medium uppercase tracking-wide text-fg-subtle"
          >
            {scene?.title ?? `Scene ${item.scene}`}
          </span>
          <p data-testid="beta-reader-quote" className={QUOTE_TEXT}>
            {item.quote}
          </p>
        </>
      )}
      <p className="m-0 text-xs text-fg-muted">{item.note}</p>
      {stale ? (
        <span data-testid="beta-reader-stale" className="text-xs text-warning">
          {BETA_READER_PASSAGE_GONE_MESSAGE}
        </span>
      ) : null}
    </li>
  )
}
