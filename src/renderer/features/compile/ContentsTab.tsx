import { useMemo } from 'react'
import {
  BODY_CONTENTS,
  NOTES_MODES,
  type BodyContents,
  type NotesMode
} from '@shared/compileFormat'
import { sectionLabel } from '@shared/labels'
import { useTreeStore } from '@renderer/features/manuscript/treeStore'
import { useOpenDocument } from '@renderer/features/manuscript/useOpenDocument'
import { useProjectStore } from '@renderer/features/project/projectStore'
import { chapterGroups, includeRows, type ScopeKind } from './compileContents'
import { useCompileWindowStore } from './compileWindowStore'
import { CheckField, FieldGrid, HINT, SECTION_TITLE, SelectField } from './fields'
import type { FormatTabProps } from './FormatTabs'

const OPTION = 'flex items-center gap-1.5 text-sm'

const BODY_LABELS: Record<BodyContents, string> = {
  text: 'The text',
  synopsis: 'Synopses only (outline)',
  textAndSynopsis: 'Synopsis, then the text'
}
const NOTES_LABELS: Record<NotesMode, string> = {
  none: 'Left out',
  inline: 'After the text',
  comments: 'As comments (DOCX, ODT)'
}

/**
 * The Contents tab of the compile window (Compile v2, CV3): the quick pick (whole manuscript,
 * selected chapters, current document), the "Include in compile" checkbox of every document and
 * folder (the project's, remembered per project; the binder's right-click menu ticks the same
 * boxes), and what of each document prints (the format's content settings).
 */
export function ContentsTab({
  format,
  edit,
  readOnly
}: FormatTabProps & { readOnly: boolean }): React.JSX.Element {
  const byId = useTreeStore((s) => s.byId)
  const childrenOf = useTreeStore((s) => s.childrenOf)
  const rootIds = useTreeStore((s) => s.rootIds)
  const openDoc = useOpenDocument()
  const novelFormat = useProjectStore((s) => s.current?.format ?? 'novel')
  const scopeKind = useCompileWindowStore((s) => s.scopeKind)
  const chapterIds = useCompileWindowStore((s) => s.chapterIds)
  const excluded = useCompileWindowStore((s) => s.excluded)
  const setScopeKind = useCompileWindowStore((s) => s.setScopeKind)
  const toggleChapter = useCompileWindowStore((s) => s.toggleChapter)
  const setIncluded = useCompileWindowStore((s) => s.setIncluded)
  const running = useCompileWindowStore((s) => s.status === 'running')

  const groups = useMemo(
    () => chapterGroups({ byId, childrenOf, rootIds }),
    [byId, childrenOf, rootIds]
  )
  const excludedSet = useMemo(() => new Set(excluded), [excluded])
  const rows = useMemo(
    () =>
      includeRows({ byId, childrenOf, rootIds }, excludedSet, (sectionType) =>
        sectionLabel(novelFormat, sectionType)
      ),
    [byId, childrenOf, rootIds, excludedSet, novelFormat]
  )

  const scopeOption = (kind: ScopeKind, label: string, disabled = false): React.JSX.Element => (
    <label className={OPTION}>
      <input
        type="radio"
        name="compile-scope"
        checked={scopeKind === kind}
        disabled={disabled || running}
        onChange={() => setScopeKind(kind)}
      />
      {label}
    </label>
  )

  return (
    <div className="flex flex-col gap-4">
      <fieldset className="m-0 flex flex-col gap-1.5 border-0 p-0">
        <legend className={`${SECTION_TITLE} mb-1 p-0`}>Compile</legend>
        {scopeOption('manuscript', 'Whole manuscript')}
        {scopeOption('chapters', 'Selected chapters', groups.length === 0)}
        {scopeKind === 'chapters' ? (
          <div
            role="group"
            aria-label="Chapters"
            className="ml-5 flex max-h-40 flex-col gap-1 overflow-y-auto rounded-md border border-line px-2 py-1.5"
          >
            {groups.map((group) => (
              <div
                key={group.partId ?? `loose-${group.chapters[0]?.id}`}
                className="flex flex-col gap-1"
              >
                {group.partTitle !== null ? (
                  <span className="text-xs font-medium text-fg-muted">
                    {group.partTitle || 'Untitled'}
                  </span>
                ) : null}
                {group.chapters.map((chapter) => (
                  <label
                    key={chapter.id}
                    className={`${OPTION} ${group.partTitle !== null ? 'ml-3' : ''}`}
                  >
                    <input
                      type="checkbox"
                      checked={chapterIds.includes(chapter.id)}
                      disabled={running}
                      onChange={(event) => toggleChapter(chapter.id, event.target.checked)}
                    />
                    {chapter.title || 'Untitled'}
                  </label>
                ))}
              </div>
            ))}
          </div>
        ) : null}
        {scopeOption(
          'document',
          openDoc ? `Current document (${openDoc.title || 'Untitled'})` : 'Current document',
          openDoc === null
        )}
      </fieldset>

      <section aria-label="Include in compile" className="flex flex-col gap-1.5">
        <h3 className={SECTION_TITLE}>Include in compile</h3>
        <p className={HINT}>
          Untick a document or folder to leave it out (a folder leaves out everything in it).
          Remembered for this project; the binder&apos;s right-click menu has the same box.
        </p>
        <ul
          aria-label="Documents"
          className="m-0 flex max-h-72 list-none flex-col overflow-y-auto rounded-md border border-line p-1.5"
        >
          {rows.map((row) => (
            <li key={row.id} className="m-0 p-0" style={{ paddingLeft: `${row.depth * 1}rem` }}>
              <label
                className={`${OPTION} ${row.kind === 'section' ? 'font-medium' : ''} ${row.excludedAbove ? 'opacity-50' : ''}`}
              >
                <input
                  type="checkbox"
                  aria-label={`Include ${row.title || 'Untitled'}`}
                  checked={!row.excluded && !row.excludedAbove}
                  disabled={row.excludedAbove || running}
                  onChange={(event) => setIncluded(row.id, event.target.checked)}
                />
                {row.title || 'Untitled'}
              </label>
            </li>
          ))}
        </ul>
      </section>

      <fieldset disabled={readOnly} className="m-0 flex flex-col gap-1.5 border-0 p-0">
        <legend className={`${SECTION_TITLE} mb-1 p-0`}>What prints</legend>
        <FieldGrid>
          <SelectField
            label="Body"
            value={format.contents.body}
            options={BODY_CONTENTS.map((value) => ({ value, label: BODY_LABELS[value] }))}
            onChange={(body) => edit((f) => ({ ...f, contents: { ...f.contents, body } }))}
          />
          <SelectField
            label="Document notes"
            value={format.contents.notes}
            options={NOTES_MODES.map((value) => ({ value, label: NOTES_LABELS[value] }))}
            onChange={(notes) => edit((f) => ({ ...f, contents: { ...f.contents, notes } }))}
          />
          <CheckField
            label="Keep # on tags (never in PDF or EPUB)"
            checked={format.contents.keepTags}
            onChange={(keepTags) => edit((f) => ({ ...f, contents: { ...f.contents, keepTags } }))}
          />
          <CheckField
            label="Mark AI-written text (never in PDF or EPUB)"
            checked={format.contents.keepAiMarks}
            onChange={(keepAiMarks) =>
              edit((f) => ({ ...f, contents: { ...f.contents, keepAiMarks } }))
            }
          />
        </FieldGrid>
      </fieldset>
    </div>
  )
}
