import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { Plus, Trash2, X } from 'lucide-react'
import { assetUrl } from '@shared/assets'
import { BOOK_COVER_DIR, BOOK_LINE_MAX, BOOK_TEXT_MAX, type BookDetails } from '@shared/bookDetails'
import { dialogs, toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
import { detailsProblem, draftDetails, toDraft, type BookDraft } from './bookDetailsDraft'
import { useBookDetailsStore } from './bookDetailsStore'
import { FIELD, FieldGrid, HINT, SECTION_TITLE, TextAreaField, TextField } from './fields'

const ISBNS_MAX = 10

/**
 * The project's Book details page (Compile v2, CV3): the publishing facts compile prints on the
 * title page, the manuscript's first page, running headers, the copyright page, the back pages,
 * and in the EPUB metadata. Opened from File › Book details… and from the compile window. Edits
 * stay here until Save; the cover is set and removed at once (it is a file, not a field).
 */
export function BookDetailsDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
  const titleId = useId()
  const stored = useBookDetailsStore((s) => s.details)
  const [draft, setDraft] = useState<BookDraft | null>(stored === null ? null : toDraft(stored))
  const [saving, setSaving] = useState(false)
  const first = useRef<HTMLDivElement>(null)

  useEffect(() => {
    useBookDetailsStore
      .getState()
      .load()
      .then((details) => setDraft((current) => current ?? toDraft(details)))
      .catch((err: unknown) => toast.error(describeError(err)))
  }, [])

  const loaded = draft !== null
  useEffect(() => {
    if (loaded) first.current?.querySelector<HTMLInputElement>('input')?.focus()
  }, [loaded])

  const details = draft === null ? null : draftDetails(draft)
  const problem = details === null ? null : detailsProblem(details)
  const dirty =
    details !== null && stored !== null && JSON.stringify(details) !== JSON.stringify(stored)

  const set = (patch: Partial<BookDetails>): void =>
    setDraft((d) => (d === null ? d : { ...d, details: { ...d.details, ...patch } }))

  const close = async (): Promise<void> => {
    if (
      dirty &&
      !(await dialogs.confirm({
        title: 'Discard changes?',
        message: 'Your changes to the Book details are not saved.',
        confirmLabel: 'Discard',
        danger: true
      }))
    )
      return
    onClose()
  }

  const onSave = async (): Promise<void> => {
    if (details === null || problem !== null) return
    setSaving(true)
    try {
      const saved = await useBookDetailsStore.getState().save(details)
      setDraft(toDraft(saved))
      toast.success('Book details saved')
      onClose()
    } catch (err) {
      toast.error(describeError(err))
    } finally {
      setSaving(false)
    }
  }

  const cover = async (action: 'set' | 'remove'): Promise<void> => {
    try {
      const store = useBookDetailsStore.getState()
      const next = action === 'set' ? await store.setCover() : await store.removeCover()
      if (next !== null) set({ cover: next.cover })
    } catch (err) {
      toast.error(describeError(err))
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      void close()
    }
  }

  const d = draft?.details
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) void close()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={onKeyDown}
        className="flex h-[min(820px,92vh)] w-[min(720px,94vw)] flex-col rounded-lg border border-line bg-surface-raised shadow-panel"
      >
        <div className="flex items-center justify-between gap-2 px-5 pt-4 pb-2">
          <h2 id={titleId} className="m-0 text-base font-semibold">
            Book details
          </h2>
          <button
            type="button"
            aria-label="Close book details"
            title="Close"
            onClick={() => void close()}
            className="-mr-1.5 rounded-md p-1.5 text-fg-muted hover:bg-surface hover:text-fg"
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>
        <div ref={first} className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 pb-4">
          {d === undefined || draft === null ? (
            <p className={HINT}>Loading…</p>
          ) : (
            <>
              <p className={HINT}>
                Compile prints these on the title page, the manuscript&apos;s first page, running
                headers, the copyright page, and the back pages, and puts them in the EPUB.
              </p>
              <h3 className={SECTION_TITLE}>Book</h3>
              <FieldGrid>
                <TextField
                  label="Title"
                  value={d.title}
                  maxLength={BOOK_LINE_MAX}
                  placeholder="The project's name"
                  onChange={(title) => set({ title })}
                />
                <TextField
                  label="Subtitle"
                  value={d.subtitle}
                  maxLength={BOOK_LINE_MAX}
                  onChange={(subtitle) => set({ subtitle })}
                />
                <TextField
                  label="Series"
                  value={d.series}
                  maxLength={BOOK_LINE_MAX}
                  onChange={(series) => set({ series })}
                />
                <TextField
                  label="Number in series"
                  value={d.seriesNumber}
                  maxLength={20}
                  onChange={(seriesNumber) => set({ seriesNumber })}
                />
                <TextField
                  label="Edition"
                  value={d.edition}
                  maxLength={BOOK_LINE_MAX}
                  placeholder="First edition"
                  onChange={(edition) => set({ edition })}
                />
                <TextField
                  label="Language"
                  value={d.language}
                  maxLength={35}
                  placeholder="en"
                  onChange={(language) => set({ language })}
                />
              </FieldGrid>

              <h3 className={SECTION_TITLE}>Author</h3>
              <FieldGrid>
                <TextField
                  label="Author (pen name)"
                  value={d.author}
                  maxLength={BOOK_LINE_MAX}
                  onChange={(author) => set({ author })}
                />
                <TextField
                  label="Surname for headers"
                  value={d.surname}
                  maxLength={BOOK_LINE_MAX}
                  placeholder="The author's last word"
                  onChange={(surname) => set({ surname })}
                />
                <TextField
                  label="Legal name"
                  value={d.legalName}
                  maxLength={BOOK_LINE_MAX}
                  placeholder="For manuscripts; the author's name if empty"
                  onChange={(legalName) => set({ legalName })}
                />
                <TextAreaField
                  label="Contact"
                  value={d.contact}
                  maxLength={BOOK_TEXT_MAX}
                  hint="Address, email, phone, agent: one a line (the manuscript's first page)."
                  onChange={(contact) => set({ contact })}
                />
                <TextAreaField
                  label="About the author"
                  value={d.aboutAuthor}
                  maxLength={BOOK_TEXT_MAX}
                  rows={4}
                  onChange={(aboutAuthor) => set({ aboutAuthor })}
                />
                <TextAreaField
                  label="Also by"
                  value={draft.alsoBy}
                  maxLength={BOOK_TEXT_MAX}
                  hint="One title a line."
                  onChange={(alsoBy) => setDraft({ ...draft, alsoBy })}
                />
              </FieldGrid>

              <h3 className={SECTION_TITLE}>Publishing</h3>
              <FieldGrid>
                <TextField
                  label="Publisher or imprint"
                  value={d.publisher}
                  maxLength={BOOK_LINE_MAX}
                  onChange={(publisher) => set({ publisher })}
                />
                <TextField
                  label="Copyright year"
                  value={d.copyrightYear}
                  maxLength={20}
                  onChange={(copyrightYear) => set({ copyrightYear })}
                />
                <TextAreaField
                  label="Rights"
                  value={d.rights}
                  maxLength={BOOK_TEXT_MAX}
                  rows={2}
                  hint="All rights reserved., or a licence line."
                  onChange={(rights) => set({ rights })}
                />
              </FieldGrid>
              <section aria-label="ISBNs" className="flex flex-col gap-1.5">
                <h3 className={SECTION_TITLE}>ISBNs</h3>
                {d.isbns.length === 0 ? (
                  <p className={HINT}>None yet. A format prints the ISBN of its edition.</p>
                ) : null}
                {d.isbns.map((entry, index) => (
                  <div key={index} className="flex items-center gap-2 text-sm">
                    <input
                      type="text"
                      aria-label={`Edition ${index + 1}`}
                      placeholder="Paperback, Ebook…"
                      value={entry.edition}
                      maxLength={60}
                      onChange={(event) =>
                        set({
                          isbns: d.isbns.map((x, i) =>
                            i === index ? { ...x, edition: event.target.value } : x
                          )
                        })
                      }
                      className={`${FIELD} w-40`}
                    />
                    <input
                      type="text"
                      aria-label={`ISBN ${index + 1}`}
                      placeholder="978-…"
                      value={entry.isbn}
                      maxLength={40}
                      onChange={(event) =>
                        set({
                          isbns: d.isbns.map((x, i) =>
                            i === index ? { ...x, isbn: event.target.value } : x
                          )
                        })
                      }
                      className={`${FIELD} min-w-0 flex-1`}
                    />
                    <button
                      type="button"
                      aria-label={`Remove ISBN ${index + 1}`}
                      title="Remove"
                      onClick={() => set({ isbns: d.isbns.filter((_, i) => i !== index) })}
                      className="rounded-md p-1 text-fg-muted hover:bg-surface hover:text-fg"
                    >
                      <Trash2 size={14} aria-hidden="true" />
                    </button>
                  </div>
                ))}
                <div>
                  <button
                    type="button"
                    disabled={d.isbns.length >= ISBNS_MAX}
                    onClick={() => set({ isbns: [...d.isbns, { edition: '', isbn: '' }] })}
                    className="flex items-center gap-1 rounded-md border border-line px-3 py-1 text-sm hover:bg-surface disabled:opacity-50"
                  >
                    <Plus size={14} aria-hidden="true" />
                    Add ISBN
                  </button>
                </div>
              </section>

              <h3 className={SECTION_TITLE}>Front pages</h3>
              <FieldGrid>
                <TextAreaField
                  label="Dedication"
                  value={d.dedication}
                  maxLength={BOOK_TEXT_MAX}
                  rows={2}
                  onChange={(dedication) => set({ dedication })}
                />
                <TextAreaField
                  label="Epigraph"
                  value={d.epigraph}
                  maxLength={BOOK_TEXT_MAX}
                  rows={3}
                  onChange={(epigraph) => set({ epigraph })}
                />
                <TextField
                  label="Epigraph source"
                  value={d.epigraphSource}
                  maxLength={BOOK_LINE_MAX}
                  onChange={(epigraphSource) => set({ epigraphSource })}
                />
              </FieldGrid>

              <h3 className={SECTION_TITLE}>For retailers</h3>
              <FieldGrid>
                <TextAreaField
                  label="Description"
                  value={d.description}
                  maxLength={BOOK_TEXT_MAX}
                  rows={4}
                  hint="The blurb: the EPUB description."
                  onChange={(description) => set({ description })}
                />
                <TextField
                  label="Keywords"
                  value={draft.keywords}
                  maxLength={BOOK_TEXT_MAX}
                  placeholder="fantasy, dragons, heist"
                  onChange={(keywords) => setDraft({ ...draft, keywords })}
                />
              </FieldGrid>

              <section aria-label="Cover" className="flex flex-col gap-1.5">
                <h3 className={SECTION_TITLE}>Cover</h3>
                <div className="flex items-start gap-3">
                  {d.cover !== null ? (
                    <img
                      src={assetUrl(BOOK_COVER_DIR, d.cover)}
                      alt="Book cover"
                      className="h-40 w-auto rounded border border-line"
                    />
                  ) : (
                    <p className={HINT}>No cover. The ebook format puts it in the EPUB.</p>
                  )}
                  <div className="flex flex-col gap-1.5">
                    <button
                      type="button"
                      onClick={() => void cover('set')}
                      className="rounded-md border border-line px-3 py-1 text-sm hover:bg-surface"
                    >
                      {d.cover === null ? 'Choose image…' : 'Replace…'}
                    </button>
                    {d.cover !== null ? (
                      <button
                        type="button"
                        onClick={() => void cover('remove')}
                        className="rounded-md border border-line px-3 py-1 text-sm hover:bg-surface"
                      >
                        Remove cover
                      </button>
                    ) : null}
                  </div>
                </div>
              </section>
            </>
          )}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-line px-5 py-3">
          {problem !== null ? (
            <p role="alert" className="m-0 mr-auto text-xs text-danger">
              {problem}
            </p>
          ) : null}
          <button
            type="button"
            onClick={() => void close()}
            className="rounded-md border border-line px-4 py-1.5 text-sm font-medium hover:bg-surface"
          >
            Close
          </button>
          <button
            type="button"
            disabled={details === null || problem !== null || saving}
            onClick={() => void onSave()}
            className="rounded-md bg-accent px-4 py-1.5 text-sm font-medium text-accent-fg hover:bg-accent-hover disabled:opacity-50 disabled:hover:bg-accent"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  )
}
