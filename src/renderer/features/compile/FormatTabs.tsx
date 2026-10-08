import { useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import {
  BOOK_FONT_INFO,
  BOOK_FONTS,
  FIRST_PARAGRAPH_STYLES,
  FURNITURE_SLOT_MAX,
  HEADING_ALIGNS,
  NUMBERING_STYLES,
  PAGE_BREAKS,
  PAGE_SIZE_INFO,
  PAGE_SIZES,
  REPLACEMENT_FIELD_MAX,
  REPLACEMENTS_MAX,
  SECTION_AFFIX_MAX,
  SECTION_LEVEL_LABELS,
  SECTION_LEVELS,
  SEPARATOR_TEXT_MAX,
  TEXT_CASES,
  TITLE_PAGE_STYLES,
  type BookFont,
  type CompileFormat,
  type FirstParagraphStyle,
  type HeadingAlign,
  type NumberingStyle,
  type PageBreak,
  type PageFurniture,
  type PageSize,
  type Replacement,
  type SectionLayout,
  type SectionLevel,
  type TextCase,
  type TitlePageStyle
} from '@shared/compileFormat'
import { replacementError } from './compileContents'
import {
  CheckField,
  FIELD,
  FieldGrid,
  HINT,
  NumberField,
  SECTION_TITLE,
  SelectField,
  TextField
} from './fields'

/**
 * The format's settings tabs in the compile window (Compile v2, CV3): Section layouts, Page
 * setup, Headers & footers, Typography, Front & back matter, Replacements, and Metadata. Each
 * reads the shown format and hands a changed copy to `edit`; the window disables them all for a
 * built-in format.
 */
export interface FormatTabProps {
  format: CompileFormat
  edit: (recipe: (format: CompileFormat) => CompileFormat) => void
}

const options = <T extends string>(
  values: readonly T[],
  labels: Record<T, string>
): { value: T; label: string }[] => values.map((value) => ({ value, label: labels[value] }))

const FONT_OPTIONS = options<BookFont>(
  BOOK_FONTS,
  Object.fromEntries(BOOK_FONTS.map((font) => [font, BOOK_FONT_INFO[font].label])) as Record<
    BookFont,
    string
  >
)

const NUMBERING_LABELS: Record<NumberingStyle, string> = {
  none: 'None (titles only)',
  words: 'Words (One, Two)',
  digits: 'Digits (1, 2)',
  roman: 'Roman (I, II)'
}
const CASE_LABELS: Record<TextCase, string> = {
  asIs: 'As typed',
  upper: 'UPPER CASE',
  smallCaps: 'Small caps'
}
const ALIGN_LABELS: Record<HeadingAlign, string> = {
  left: 'Left',
  center: 'Centre',
  right: 'Right'
}
const BREAK_LABELS: Record<PageBreak, string> = {
  none: 'None (in the flow)',
  newPage: 'New page',
  newRecto: 'New right-hand page'
}
const FIRST_PARAGRAPH_LABELS: Record<FirstParagraphStyle, string> = {
  indent: 'Indented',
  noIndent: 'No indent',
  dropCap: 'Drop cap',
  smallCapsLine: 'Small-caps first line',
  smallCapsWords: 'Small-caps first words'
}
const PAGE_SIZE_LABELS: Record<PageSize, string> = {
  ...Object.fromEntries(Object.entries(PAGE_SIZE_INFO).map(([size, info]) => [size, info.label])),
  custom: 'Custom'
} as Record<PageSize, string>
const TITLE_PAGE_LABELS: Record<TitlePageStyle, string> = {
  none: 'None',
  page: 'Title page',
  manuscript: 'Manuscript first page (contact block, word count)'
}

// ---------------------------------------------------------------------------------------------
// Section layouts

/**
 * The level picker stays usable on a built-in format (to read each level's layout); only the
 * fields are disabled (`readOnly`).
 */
export function SectionLayoutsTab({
  format,
  edit,
  readOnly
}: FormatTabProps & { readOnly: boolean }): React.JSX.Element {
  const [level, setLevel] = useState<SectionLevel>('chapter')
  const layout = format.sections[level]
  const change = (patch: Partial<SectionLayout>): void =>
    edit((f) => ({
      ...f,
      sections: { ...f.sections, [level]: { ...f.sections[level], ...patch } }
    }))
  const separator = format.sceneSeparator
  return (
    <div className="flex flex-col gap-4">
      <div role="radiogroup" aria-label="Level" className="flex flex-wrap gap-1">
        {SECTION_LEVELS.map((id) => (
          <label
            key={id}
            className="flex cursor-pointer items-center gap-1.5 rounded-md border border-line px-2 py-1 text-sm has-checked:border-accent has-checked:bg-surface"
          >
            <input
              type="radio"
              name="compile-level"
              className="sr-only"
              checked={level === id}
              onChange={() => setLevel(id)}
            />
            {SECTION_LEVEL_LABELS[id]}
          </label>
        ))}
      </div>
      <p className={HINT}>
        {level === 'chapterScene'
          ? 'A scene placed directly under a part or the manuscript (a prologue). Numbered only when its numbering is on; it then shares the chapter count.'
          : level === 'scene'
            ? 'Scenes inside a chapter. Scenes count across the whole book.'
            : level === 'part'
              ? 'Parts count on their own.'
              : 'Chapters share one count.'}
      </p>
      <fieldset disabled={readOnly} className="m-0 flex flex-col gap-4 border-0 p-0">
        <FieldGrid>
          <CheckField
            label="Show the title"
            checked={layout.showTitle}
            onChange={(showTitle) => change({ showTitle })}
          />
          <SelectField
            label="Numbering"
            value={layout.numbering}
            options={options(NUMBERING_STYLES, NUMBERING_LABELS)}
            onChange={(numbering) => change({ numbering })}
          />
          <TextField
            label="Prefix"
            value={layout.prefix}
            maxLength={SECTION_AFFIX_MAX}
            placeholder="Chapter "
            onChange={(prefix) => change({ prefix })}
          />
          <TextField
            label="Suffix"
            value={layout.suffix}
            maxLength={SECTION_AFFIX_MAX}
            placeholder="."
            onChange={(suffix) => change({ suffix })}
          />
          <CheckField
            label="Title on its own line under the number"
            checked={layout.titleOnNewLine}
            onChange={(titleOnNewLine) => change({ titleOnNewLine })}
          />
          <SelectField
            label="Font"
            value={layout.font ?? 'heading'}
            options={[{ value: 'heading', label: 'Heading font (Typography)' }, ...FONT_OPTIONS]}
            onChange={(font) => change({ font: font === 'heading' ? null : font })}
          />
          <NumberField
            label="Size"
            value={layout.size}
            min={7}
            max={72}
            step={0.5}
            unit="pt"
            onChange={(size) => change({ size })}
          />
          <CheckField label="Bold" checked={layout.bold} onChange={(bold) => change({ bold })} />
          <CheckField
            label="Italic"
            checked={layout.italic}
            onChange={(italic) => change({ italic })}
          />
          <SelectField
            label="Case"
            value={layout.case}
            options={options(TEXT_CASES, CASE_LABELS)}
            onChange={(value) => change({ case: value })}
          />
          <SelectField
            label="Alignment"
            value={layout.align}
            options={options(HEADING_ALIGNS, ALIGN_LABELS)}
            onChange={(align) => change({ align })}
          />
          <NumberField
            label="Space before"
            value={layout.spaceBefore}
            min={0}
            max={432}
            unit="pt"
            onChange={(spaceBefore) => change({ spaceBefore })}
          />
          <NumberField
            label="Space after"
            value={layout.spaceAfter}
            min={0}
            max={216}
            unit="pt"
            onChange={(spaceAfter) => change({ spaceAfter })}
          />
          <SelectField
            label="Page break before"
            value={layout.pageBreak}
            options={options(PAGE_BREAKS, BREAK_LABELS)}
            onChange={(pageBreak) => change({ pageBreak })}
          />
          <SelectField
            label="First paragraph"
            value={layout.firstParagraph}
            options={options(FIRST_PARAGRAPH_STYLES, FIRST_PARAGRAPH_LABELS)}
            onChange={(firstParagraph) => change({ firstParagraph })}
          />
          {layout.firstParagraph === 'smallCapsWords' ? (
            <NumberField
              label="Small-caps words"
              value={layout.firstWords}
              min={1}
              max={10}
              onChange={(firstWords) => change({ firstWords })}
            />
          ) : null}
        </FieldGrid>

        <h3 className={SECTION_TITLE}>Between scenes</h3>
        <FieldGrid>
          <SelectField
            label="Separator"
            value={separator.kind}
            options={[
              { value: 'text', label: 'Text or glyph' },
              { value: 'blankLine', label: 'Blank line' },
              { value: 'pageBreak', label: 'Page break' }
            ]}
            onChange={(kind) =>
              edit((f) => ({
                ...f,
                sceneSeparator: kind === 'text' ? { kind, text: '#' } : { kind }
              }))
            }
          />
          {separator.kind === 'text' ? (
            <TextField
              label="Separator text"
              value={separator.text}
              maxLength={SEPARATOR_TEXT_MAX}
              error={separator.text.trim() === '' ? 'Type the separator, e.g. # or * * *' : null}
              onChange={(text) => edit((f) => ({ ...f, sceneSeparator: { kind: 'text', text } }))}
            />
          ) : null}
        </FieldGrid>
      </fieldset>
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// Page setup

export function PageSetupTab({ format, edit }: FormatTabProps): React.JSX.Element {
  const page = format.pageSetup
  const change = (patch: Partial<CompileFormat['pageSetup']>): void =>
    edit((f) => ({ ...f, pageSetup: { ...f.pageSetup, ...patch } }))
  const margin = (side: keyof CompileFormat['pageSetup']['margins'], value: number): void =>
    edit((f) => ({
      ...f,
      pageSetup: { ...f.pageSetup, margins: { ...f.pageSetup.margins, [side]: value } }
    }))
  return (
    <div className="flex flex-col gap-4">
      <FieldGrid>
        <SelectField
          label="Page size"
          value={page.size}
          options={options(PAGE_SIZES, PAGE_SIZE_LABELS)}
          onChange={(size) => {
            if (size === 'custom') change({ size })
            else
              change({
                size,
                width: PAGE_SIZE_INFO[size].width,
                height: PAGE_SIZE_INFO[size].height
              })
          }}
        />
        {page.size === 'custom' ? (
          <>
            <NumberField
              label="Width"
              value={page.width}
              min={2}
              max={17}
              step={0.01}
              unit="in"
              onChange={(width) => change({ width })}
            />
            <NumberField
              label="Height"
              value={page.height}
              min={2}
              max={17}
              step={0.01}
              unit="in"
              onChange={(height) => change({ height })}
            />
          </>
        ) : null}
      </FieldGrid>
      <h3 className={SECTION_TITLE}>Margins</h3>
      <FieldGrid>
        <NumberField
          label="Top"
          value={page.margins.top}
          min={0}
          max={3}
          step={0.05}
          unit="in"
          onChange={(v) => margin('top', v)}
        />
        <NumberField
          label="Bottom"
          value={page.margins.bottom}
          min={0}
          max={3}
          step={0.05}
          unit="in"
          onChange={(v) => margin('bottom', v)}
        />
        <NumberField
          label={page.mirrored ? 'Inside' : 'Left'}
          value={page.margins.inside}
          min={0}
          max={3}
          step={0.05}
          unit="in"
          onChange={(v) => margin('inside', v)}
        />
        <NumberField
          label={page.mirrored ? 'Outside' : 'Right'}
          value={page.margins.outside}
          min={0}
          max={3}
          step={0.05}
          unit="in"
          onChange={(v) => margin('outside', v)}
        />
        <CheckField
          label="Mirrored margins (facing pages: inside and outside swap on left-hand pages)"
          checked={page.mirrored}
          onChange={(mirrored) => change({ mirrored })}
        />
        <NumberField
          label="Gutter"
          value={page.gutter}
          min={0}
          max={1.5}
          step={0.025}
          unit="in"
          onChange={(gutter) => change({ gutter })}
        />
      </FieldGrid>
      <p className={HINT}>The gutter is added to the inside margin for the binding.</p>
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// Headers and footers

function FurnitureFields({
  label,
  furniture,
  onChange
}: {
  label: string
  furniture: PageFurniture
  onChange: (furniture: PageFurniture) => void
}): React.JSX.Element {
  const slots = ['left', 'center', 'right'] as const
  const names = { left: 'left', center: 'centre', right: 'right' }
  return (
    <>
      <h3 className={SECTION_TITLE}>{label}</h3>
      <FieldGrid>
        {(['header', 'footer'] as const).flatMap((part) =>
          slots.map((slot) => (
            <TextField
              key={`${part}-${slot}`}
              label={`${label} ${part}, ${names[slot]}`}
              value={furniture[part][slot]}
              maxLength={FURNITURE_SLOT_MAX}
              onChange={(value) =>
                onChange({ ...furniture, [part]: { ...furniture[part], [slot]: value } })
              }
            />
          ))
        )}
      </FieldGrid>
    </>
  )
}

export function HeadersFootersTab({ format, edit }: FormatTabProps): React.JSX.Element {
  const hf = format.headersFooters
  const change = (patch: Partial<CompileFormat['headersFooters']>): void =>
    edit((f) => ({ ...f, headersFooters: { ...f.headersFooters, ...patch } }))
  return (
    <div className="flex flex-col gap-4">
      <p className={HINT}>
        Tokens: {'{author} {surname} {title} {TITLE} {chapter} {page} {wordcount}'}. Text and tokens
        mix, e.g. {'{surname} / {TITLE} / {page}'}.
      </p>
      <FieldGrid>
        <CheckField
          label="Different left and right pages (facing pages)"
          checked={hf.facing}
          onChange={(facing) => change({ facing })}
        />
        <CheckField
          label="No header or footer on chapter-opening pages"
          checked={hf.hideOnOpeners}
          onChange={(hideOnOpeners) => change({ hideOnOpeners })}
        />
      </FieldGrid>
      <FurnitureFields
        label={hf.facing ? 'Right-hand pages' : 'Every page'}
        furniture={hf.recto}
        onChange={(recto) => change({ recto })}
      />
      {hf.facing ? (
        <FurnitureFields
          label="Left-hand pages"
          furniture={hf.verso}
          onChange={(verso) => change({ verso })}
        />
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// Typography

export function TypographyTab({ format, edit }: FormatTabProps): React.JSX.Element {
  const t = format.typography
  const change = (patch: Partial<CompileFormat['typography']>): void =>
    edit((f) => ({ ...f, typography: { ...f.typography, ...patch } }))
  return (
    <div className="flex flex-col gap-4">
      <FieldGrid>
        <SelectField
          label="Body font"
          value={t.font}
          options={FONT_OPTIONS}
          onChange={(font) => change({ font })}
        />
        <SelectField
          label="Heading font"
          value={t.headingFont}
          options={FONT_OPTIONS}
          onChange={(headingFont) => change({ headingFont })}
        />
        <NumberField
          label="Body size"
          value={t.size}
          min={7}
          max={24}
          step={0.5}
          unit="pt"
          onChange={(size) => change({ size })}
        />
        <SelectField
          label="Line spacing"
          value={t.lineSpacing.mode}
          options={[
            { value: 'multiple', label: 'Multiple' },
            { value: 'exact', label: 'Exact' }
          ]}
          onChange={(mode) =>
            change({
              lineSpacing:
                mode === 'multiple'
                  ? { mode, value: 1.5 }
                  : { mode, points: Math.round(t.size * 1.3 * 2) / 2 }
            })
          }
        />
        {t.lineSpacing.mode === 'multiple' ? (
          <NumberField
            label="Lines"
            value={t.lineSpacing.value}
            min={0.8}
            max={3}
            step={0.05}
            unit="×"
            onChange={(value) => change({ lineSpacing: { mode: 'multiple', value } })}
          />
        ) : (
          <NumberField
            label="Leading"
            value={t.lineSpacing.points}
            min={6}
            max={48}
            step={0.5}
            unit="pt"
            onChange={(points) => change({ lineSpacing: { mode: 'exact', points } })}
          />
        )}
        <NumberField
          label="Paragraph indent"
          value={t.indent}
          min={0}
          max={4}
          step={0.25}
          unit="em"
          onChange={(indent) => change({ indent })}
        />
        <NumberField
          label="Space after paragraphs"
          value={t.paragraphSpacing}
          min={0}
          max={36}
          unit="pt"
          onChange={(paragraphSpacing) => change({ paragraphSpacing })}
        />
        <CheckField
          label="Justify"
          checked={t.justify}
          onChange={(justify) => change({ justify })}
        />
        <CheckField
          label="Hyphenate"
          checked={t.hyphenate}
          onChange={(hyphenate) => change({ hyphenate })}
        />
        <NumberField
          label="Widow and orphan lines"
          value={t.widowControl}
          min={0}
          max={5}
          onChange={(widowControl) => change({ widowControl })}
        />
      </FieldGrid>
      <p className={HINT}>
        Fonts are bundled (SIL Open Font License) and embedded in PDFs. Widow and orphan lines: the
        fewest lines kept together at a page top or bottom; 0 turns it off.
      </p>
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// Front and back matter

export function MatterTab({ format, edit }: FormatTabProps): React.JSX.Element {
  const m = format.matter
  const change = (patch: Partial<CompileFormat['matter']>): void =>
    edit((f) => ({ ...f, matter: { ...f.matter, ...patch } }))
  return (
    <div className="flex flex-col gap-4">
      <p className={HINT}>
        Generated pages read the project&apos;s Book details; a page with nothing to print is left
        out.
      </p>
      <FieldGrid>
        <SelectField
          label="Title page"
          value={m.titlePage}
          options={options(TITLE_PAGE_STYLES, TITLE_PAGE_LABELS)}
          onChange={(titlePage) => change({ titlePage })}
        />
        <CheckField
          label="Copyright page"
          checked={m.copyrightPage}
          onChange={(copyrightPage) => change({ copyrightPage })}
        />
        <CheckField
          label="Dedication"
          checked={m.dedication}
          onChange={(dedication) => change({ dedication })}
        />
        <CheckField
          label="Epigraph"
          checked={m.epigraph}
          onChange={(epigraph) => change({ epigraph })}
        />
        <CheckField label="Table of contents" checked={m.toc} onChange={(toc) => change({ toc })} />
        <CheckField
          label="The project's front matter"
          checked={m.frontMatter}
          onChange={(frontMatter) => change({ frontMatter })}
        />
        <CheckField
          label="The project's end matter"
          checked={m.endMatter}
          onChange={(endMatter) => change({ endMatter })}
        />
        <CheckField
          label="About the author"
          checked={m.aboutAuthor}
          onChange={(aboutAuthor) => change({ aboutAuthor })}
        />
        <CheckField label="Also by" checked={m.alsoBy} onChange={(alsoBy) => change({ alsoBy })} />
      </FieldGrid>
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// Replacements

const EMPTY_RULE: Replacement = {
  enabled: true,
  find: '',
  replace: '',
  regex: false,
  caseSensitive: true
}

export function ReplacementsTab({ format, edit }: FormatTabProps): React.JSX.Element {
  const rules = format.replacements
  const change = (index: number, patch: Partial<Replacement>): void =>
    edit((f) => ({
      ...f,
      replacements: f.replacements.map((rule, i) => (i === index ? { ...rule, ...patch } : rule))
    }))
  return (
    <div className="flex flex-col gap-3">
      <p className={HINT}>
        Applied to the text in order when compiling (e.g. -- → —). AI marks and the # of tags are
        always stripped from PDF and EPUB.
      </p>
      {rules.length === 0 ? <p className={HINT}>No replacements.</p> : null}
      <ul aria-label="Replacements" className="m-0 flex list-none flex-col gap-2 p-0">
        {rules.map((rule, index) => {
          const error = replacementError(rule)
          return (
            <li
              key={index}
              aria-label={`Replacement ${index + 1}`}
              className="flex flex-col gap-1 rounded-md border border-line p-2 text-sm"
            >
              <div className="flex flex-wrap items-center gap-2">
                <input
                  type="checkbox"
                  aria-label="Enabled"
                  checked={rule.enabled}
                  onChange={(event) => change(index, { enabled: event.target.checked })}
                />
                <input
                  type="text"
                  aria-label="Find"
                  placeholder="Find"
                  value={rule.find}
                  maxLength={REPLACEMENT_FIELD_MAX}
                  aria-invalid={error !== null}
                  onChange={(event) => change(index, { find: event.target.value })}
                  className={`${FIELD} min-w-0 flex-1`}
                />
                <span aria-hidden="true">→</span>
                <input
                  type="text"
                  aria-label="Replace with"
                  placeholder="Replace with"
                  value={rule.replace}
                  maxLength={REPLACEMENT_FIELD_MAX}
                  onChange={(event) => change(index, { replace: event.target.value })}
                  className={`${FIELD} min-w-0 flex-1`}
                />
                <button
                  type="button"
                  aria-label="Remove replacement"
                  title="Remove"
                  onClick={() =>
                    edit((f) => ({
                      ...f,
                      replacements: f.replacements.filter((_, i) => i !== index)
                    }))
                  }
                  className="rounded-md p-1 text-fg-muted hover:bg-surface hover:text-fg"
                >
                  <Trash2 size={14} aria-hidden="true" />
                </button>
              </div>
              <div className="flex flex-wrap gap-3 text-xs">
                <label className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={rule.regex}
                    onChange={(event) => change(index, { regex: event.target.checked })}
                  />
                  Regular expression
                </label>
                <label className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={rule.caseSensitive}
                    onChange={(event) => change(index, { caseSensitive: event.target.checked })}
                  />
                  Match case
                </label>
                {error !== null ? <span className="text-danger">{error}</span> : null}
              </div>
            </li>
          )
        })}
      </ul>
      <div>
        <button
          type="button"
          disabled={rules.length >= REPLACEMENTS_MAX}
          onClick={() => edit((f) => ({ ...f, replacements: [...f.replacements, EMPTY_RULE] }))}
          className="flex items-center gap-1 rounded-md border border-line px-3 py-1 text-sm hover:bg-surface disabled:opacity-50"
        >
          <Plus size={14} aria-hidden="true" />
          Add replacement
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// Metadata

export function MetadataTab({ format, edit }: FormatTabProps): React.JSX.Element {
  const meta = format.metadata
  const change = (patch: Partial<CompileFormat['metadata']>): void =>
    edit((f) => ({ ...f, metadata: { ...f.metadata, ...patch } }))
  return (
    <div className="flex flex-col gap-4">
      <p className={HINT}>
        Title, author, series, ISBNs, language, description, and keywords come from the
        project&apos;s Book details.
      </p>
      <FieldGrid>
        <CheckField
          label="Include the cover image (EPUB)"
          checked={meta.includeCover}
          onChange={(includeCover) => change({ includeCover })}
        />
        <TextField
          label="ISBN edition"
          value={meta.isbnEdition}
          maxLength={60}
          placeholder="Paperback, Ebook… (empty: the first ISBN)"
          onChange={(isbnEdition) => change({ isbnEdition })}
        />
      </FieldGrid>
    </div>
  )
}
