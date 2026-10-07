import { useId, useMemo, useState } from 'react'
import { Loader2, Check, X } from 'lucide-react'
import { DEFAULT_MODELS, outputBudget, type Tier } from '@shared/ai'
import { type AiSource } from '@shared/aiSettings'
import { isFeatureAllowed } from '@shared/aiSettings'
import {
  BUILTIN_PRESET_IDS,
  BUILTIN_PRESETS,
  EDIT_PASS_DESCRIPTION,
  EDIT_PASS_INSTRUCTION_MAX,
  EDIT_PASS_LABEL,
  EDIT_PASS_PRESET_NAME_MAX,
  EDIT_PASS_PRESETS_MAX,
  EDIT_PASS_TIER,
  EDIT_PASS_TYPES,
  estimateEditPass,
  presetInstruction,
  type BuiltinPresetId,
  type EditPassSummary,
  type EditPassType
} from '@shared/editPass'
import { useAiSettingsStore } from '@renderer/features/ai/aiSettingsStore'
import { providerOf, routedTier, useAiStore } from '@renderer/features/ai/aiStore'
import { formatCount, formatUsd } from '@renderer/features/ai/usageFormat'
import { descendantDocuments, useTreeStore } from '@renderer/features/manuscript/treeStore'
import { listOutline } from '@renderer/features/outline/outlineRows'
import { dialogs } from '@renderer/features/shell/dialogs/dialogStore'
import { runningPass, useEditPassStore } from './editPassStore'
import { useEditPassViewStore } from './editPassViewStore'
import { passTitle } from './passFormat'

const SECTION = 'flex flex-col gap-2 border-b border-line px-6 py-4'
const HEADING = 'm-0 text-sm font-semibold text-fg'
const SMALL_BUTTON =
  'rounded-md border border-line px-2 py-0.5 text-xs hover:bg-surface-raised disabled:opacity-40 disabled:hover:bg-transparent'
const INDENT = ['pl-0', 'pl-4', 'pl-8', 'pl-12', 'pl-16'] as const

/**
 * The tier and model a pass of this kind goes out on for this project's source (F-5.11, F-15.4),
 * after the author's model choice (AI-BILLING-SPEC M8, R4), as the estimate prices it.
 */
function usePassModel(type: EditPassType): { tier: Tier; model: string; source: AiSource } {
  const source = useAiSettingsStore((s) => s.settings?.source ?? 'ownKey')
  const status = useAiStore((s) => s.status)
  const choice = useAiStore((s) => s.choice)
  const tier = routedTier(choice, source, 'editPass', EDIT_PASS_TIER[type])
  const model = status?.models[providerOf(status, source)][tier] ?? DEFAULT_MODELS[tier]
  return { tier, model, source }
}

/**
 * The Edits workspace (F-14.15), the main pane's own screen for a pass: choose the kind of edit
 * (or write a custom instruction, from a built-in or saved preset), tick the scenes it covers
 * (quick picks for this scene, this chapter, the whole manuscript), compare what it would cost
 * with what an editor typically charges for the same words, and start it. While a pass runs the
 * workspace shows its progress scene by scene with Stop; the scenes in it are read-only in the
 * editor until it ends, and the report opens when it finishes.
 */
export function EditPassWorkspace(): React.JSX.Element {
  const running = useEditPassStore((s) => runningPass(s))
  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto"
      data-testid="edit-pass-workspace"
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-line px-6 py-3">
        <h2 className="m-0 flex-1 text-base font-semibold">Edit pass</h2>
        <button
          type="button"
          aria-label="Close the edit pass workspace"
          className="rounded-md p-1 text-fg-muted hover:bg-surface-raised hover:text-fg"
          onClick={() => useEditPassViewStore.getState().close()}
        >
          <X size={16} aria-hidden="true" />
        </button>
      </header>
      {running === null ? <PassSetup /> : <PassProgress pass={running} />}
    </div>
  )
}

/** The running pass: every scene with where it stands, the spend so far, and Stop. */
function PassProgress({ pass }: { pass: EditPassSummary }): React.JSX.Element {
  const byId = useTreeStore((s) => s.byId)
  const done = new Set(pass.doneNodeIds)
  return (
    <section className={SECTION} aria-label="Pass progress" data-testid="edit-pass-progress">
      <h3
        className={HEADING}
      >{`${passTitle(pass)}: ${done.size} of ${pass.nodeIds.length} scenes`}</h3>
      <progress
        className="h-2 w-full"
        max={pass.nodeIds.length}
        value={done.size}
        aria-label="Edit pass progress"
      />
      <p className="m-0 text-xs text-fg-muted">
        {`${formatUsd(pass.costUsd)} so far · ${formatCount(pass.tokensIn)} tokens in · ${formatCount(pass.tokensOut)} out. The scenes in the pass are read-only until it ends; the report opens when it finishes.`}
      </p>
      <ol className="m-0 flex list-none flex-col gap-0.5 p-0 text-sm">
        {pass.nodeIds.map((id) => (
          <li key={id} className="flex items-center gap-2" data-testid="edit-pass-scene">
            {done.has(id) ? (
              <Check size={14} className="text-success" aria-label="Done" />
            ) : id === pass.currentNodeId ? (
              <Loader2 size={14} className="animate-spin text-accent" aria-label="Reading" />
            ) : (
              <span className="inline-block w-3.5" aria-label="Waiting" />
            )}
            <span className={done.has(id) ? 'text-fg-muted' : 'text-fg'}>
              {byId[id]?.title ?? 'Deleted scene'}
            </span>
          </li>
        ))}
      </ol>
      <div>
        <button
          type="button"
          className={SMALL_BUTTON}
          data-testid="edit-pass-stop"
          onClick={() => void useEditPassStore.getState().cancel(pass.id)}
        >
          Stop the pass
        </button>
      </div>
    </section>
  )
}

/** The set-up: type, instruction, scope, estimate, Start. */
function PassSetup(): React.JSX.Element {
  const [type, setType] = useState<EditPassType>('line')
  const [instruction, setInstruction] = useState('')
  const [starting, setStarting] = useState(false)
  const scope = useScope()
  const settings = useAiSettingsStore((s) => s.settings)
  const allowed = settings !== null && isFeatureAllowed(settings, 'editPass')
  const wordCounts = useTreeStore((s) => s.wordCountRollup)
  const { model, source } = usePassModel(type)
  // AI-BILLING-SPEC C4: hosted users see dollars and words, not tokens.
  const hosted = source === 'cloud'
  const ordered = scope.ordered
  const estimate = useMemo(
    () =>
      estimateEditPass(
        type,
        ordered.map((id) => wordCounts[id] ?? 0),
        model,
        outputBudget('editPass')
      ),
    [type, ordered, wordCounts, model]
  )
  const needsInstruction = type === 'custom' && instruction.trim() === ''
  const reason = !allowed
    ? 'Edit passes need Use AI on for this project (Settings, AI).'
    : ordered.length === 0
      ? 'Tick at least one scene.'
      : needsInstruction
        ? 'Write the instruction for the custom pass.'
        : null

  const start = async (): Promise<void> => {
    setStarting(true)
    await useEditPassStore.getState().start({
      type,
      instruction: type === 'custom' ? instruction.trim() : null,
      nodeIds: ordered
    })
    setStarting(false)
  }

  return (
    <>
      <TypePicker type={type} onChange={setType} />
      {type === 'custom' ? (
        <InstructionEditor value={instruction} onChange={setInstruction} words={estimate.words} />
      ) : null}
      <ScopePicker scope={scope} />
      <section className={SECTION} aria-label="Estimate" data-testid="edit-pass-estimate">
        <h3 className={HEADING}>Estimate</h3>
        <p className="m-0 text-sm">
          {`${formatCount(estimate.scenes, 'scene')} · ${formatCount(estimate.words, 'word')} · ${formatCount(estimate.chunks, 'request')}`}
        </p>
        <p className="m-0 text-sm" data-testid="edit-pass-estimate-ai">
          {estimate.priced
            ? hosted
              ? `With MythScribe: about ${formatUsd(estimate.costUsd)} on ${model}.`
              : `With MythScribe: about ${formatUsd(estimate.costUsd)} on ${model} (about ${formatCount(estimate.tokensIn)} tokens in, ${formatCount(estimate.tokensOut)} out at most).`
            : hosted
              ? `With MythScribe: ${model} has no published price here, so the cost is not estimated.`
              : `With MythScribe: ${model} has no published price here, so the cost is not estimated (about ${formatCount(estimate.tokensIn)} tokens in).`}
        </p>
      </section>
      <div className="flex items-center gap-3 px-6 py-4">
        <button
          type="button"
          data-testid="edit-pass-start"
          disabled={reason !== null || starting}
          onClick={() => void start()}
          className="rounded-md bg-accent px-4 py-1.5 text-sm font-medium text-accent-fg hover:bg-accent-hover disabled:opacity-50 disabled:hover:bg-accent"
        >
          Start the pass
        </button>
        <span className="text-xs text-fg-muted">
          {reason ?? 'Every change comes back as a tracked change you accept or reject.'}
        </span>
      </div>
    </>
  )
}

function TypePicker({
  type,
  onChange
}: {
  type: EditPassType
  onChange: (type: EditPassType) => void
}): React.JSX.Element {
  const name = useId()
  const source = useAiSettingsStore((s) => s.settings?.source ?? 'ownKey')
  const choice = useAiStore((s) => s.choice)
  return (
    <fieldset className={`${SECTION} m-0 border-x-0 border-t-0`}>
      <legend className="sr-only">Kind of edit</legend>
      <h3 className={HEADING} aria-hidden="true">
        Kind of edit
      </h3>
      {/* Cards at least 13rem wide, as many per row as the pane holds. */}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(13rem,1fr))] gap-2">
        {EDIT_PASS_TYPES.map((value) => (
          <label
            key={value}
            className={`flex cursor-pointer flex-col gap-1 rounded-md border px-3 py-2 text-sm ${value === type ? 'border-accent bg-surface-raised' : 'border-line hover:bg-surface-raised'}`}
          >
            <span className="flex items-center gap-2">
              <input
                type="radio"
                name={name}
                value={value}
                checked={value === type}
                onChange={() => onChange(value)}
              />
              <span className="font-medium">{EDIT_PASS_LABEL[value]}</span>
            </span>
            <span className="text-xs text-fg-muted">{EDIT_PASS_DESCRIPTION[value]}</span>
            <span className="text-xs text-fg-subtle">
              {routedTier(choice, source, 'editPass', EDIT_PASS_TIER[value]) === 'strong'
                ? 'Strong model'
                : 'Fast model'}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  )
}

function InstructionEditor({
  value,
  onChange,
  words
}: {
  value: string
  onChange: (value: string) => void
  words: number
}): React.JSX.Element {
  const id = useId()
  const presets = useEditPassStore((s) => s.presets)
  const [preset, setPreset] = useState<BuiltinPresetId>('trimPercent')
  const spec = BUILTIN_PRESETS[preset]
  const [n, setN] = useState(spec.number?.default ?? 0)

  const savePreset = async (): Promise<void> => {
    const name = await dialogs.prompt({
      title: 'Save this instruction as a preset',
      placeholder: 'Preset name',
      confirmLabel: 'Save',
      validate: (text) =>
        text.trim() === ''
          ? 'Give the preset a name.'
          : text.trim().length > EDIT_PASS_PRESET_NAME_MAX
            ? `At most ${EDIT_PASS_PRESET_NAME_MAX} characters.`
            : null
    })
    if (name === null) return
    await useEditPassStore
      .getState()
      .savePresets([
        ...presets,
        { id: `p-${Date.now().toString(36)}`, name: name.trim(), instruction: value.trim() }
      ])
  }

  return (
    <section className={SECTION} aria-label="Instruction">
      <label htmlFor={id} className={HEADING}>
        Your instruction
      </label>
      <textarea
        id={id}
        data-testid="edit-pass-instruction"
        value={value}
        maxLength={EDIT_PASS_INSTRUCTION_MAX}
        rows={3}
        placeholder="For example: cut every adverb that repeats its verb."
        onChange={(event) => onChange(event.target.value)}
        className="w-full resize-y rounded-md border border-line bg-bg px-2 py-1 text-sm"
      />
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-fg-muted">Preset</span>
        <select
          aria-label="Built-in preset"
          value={preset}
          onChange={(event) => {
            const next = BUILTIN_PRESET_IDS.find((p) => p === event.target.value) ?? 'trimPercent'
            setPreset(next)
            setN(BUILTIN_PRESETS[next].number?.default ?? 0)
          }}
          className="rounded-md border border-line bg-bg px-1 py-0.5"
        >
          {BUILTIN_PRESET_IDS.map((p) => (
            <option key={p} value={p}>
              {BUILTIN_PRESETS[p].label}
            </option>
          ))}
        </select>
        {spec.number === null ? null : (
          <input
            type="number"
            aria-label={spec.number.label}
            min={spec.number.min}
            max={spec.number.max}
            value={n}
            onChange={(event) => setN(Number(event.target.value))}
            className="w-24 rounded-md border border-line bg-bg px-1 py-0.5"
          />
        )}
        <button
          type="button"
          className={SMALL_BUTTON}
          onClick={() => onChange(presetInstruction(preset, n, words))}
        >
          Use preset
        </button>
        <button
          type="button"
          className={SMALL_BUTTON}
          disabled={value.trim() === '' || presets.length >= EDIT_PASS_PRESETS_MAX}
          onClick={() => void savePreset()}
        >
          Save as preset…
        </button>
      </div>
      {presets.length === 0 ? null : (
        <ul className="m-0 flex list-none flex-wrap gap-1 p-0" aria-label="Saved presets">
          {presets.map((saved) => (
            <li key={saved.id} className="flex items-center rounded-md border border-line text-xs">
              <button
                type="button"
                className="px-2 py-0.5 hover:bg-surface-raised"
                title={saved.instruction}
                onClick={() => onChange(saved.instruction)}
              >
                {saved.name}
              </button>
              <button
                type="button"
                aria-label={`Delete preset ${saved.name}`}
                className="px-1 py-0.5 text-fg-muted hover:text-danger"
                onClick={() =>
                  void useEditPassStore
                    .getState()
                    .savePresets(presets.filter((p) => p.id !== saved.id))
                }
              >
                <X size={12} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

interface Scope {
  /** The ticked scenes in reading order. */
  ordered: string[]
  selected: ReadonlySet<string>
  setSelected: (ids: Iterable<string>) => void
  toggle: (id: string) => void
  /** Reading-order manuscript documents. */
  all: string[]
  rows: { id: string; depth: number }[]
  documentsUnder: (id: string) => string[]
}

/** The ticked scenes, starting from the scene the author has open. */
function useScope(): Scope {
  const rootIds = useTreeStore((s) => s.rootIds)
  const childrenOf = useTreeStore((s) => s.childrenOf)
  const sectionOf = useTreeStore((s) => s.sectionOf)
  const byId = useTreeStore((s) => s.byId)
  const rows = useMemo(
    () => listOutline(rootIds, childrenOf, sectionOf),
    [rootIds, childrenOf, sectionOf]
  )
  const all = useMemo(
    () => rows.map((r) => r.id).filter((id) => byId[id]?.kind === 'document'),
    [rows, byId]
  )
  const [selected, setSelectedState] = useState<ReadonlySet<string>>(() => {
    const open = useTreeStore.getState().selectedId
    return new Set(open !== null && all.includes(open) ? [open] : [])
  })
  const ordered = useMemo(() => all.filter((id) => selected.has(id)), [all, selected])
  return {
    ordered,
    selected,
    setSelected: (ids) => setSelectedState(new Set(ids)),
    toggle: (id) => {
      const under = descendantDocuments({ byId, childrenOf }, id)
      const next = new Set(selected)
      const on = under.every((doc) => next.has(doc))
      for (const doc of under) {
        if (on) next.delete(doc)
        else next.add(doc)
      }
      setSelectedState(next)
    },
    all,
    rows,
    documentsUnder: (id) => descendantDocuments({ byId, childrenOf }, id)
  }
}

function ScopePicker({ scope }: { scope: Scope }): React.JSX.Element {
  const byId = useTreeStore((s) => s.byId)
  const open = useTreeStore((s) => s.selectedId)
  const words = useTreeStore((s) => s.wordCountRollup)
  const openDoc = open !== null && scope.all.includes(open) ? open : null
  const chapter = openDoc === null ? null : (byId[openDoc]?.parentId ?? null)
  return (
    <section className={SECTION} aria-label="Scenes in the pass">
      <h3 className={HEADING}>Scenes in the pass</h3>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={SMALL_BUTTON}
          disabled={openDoc === null}
          onClick={() => openDoc !== null && scope.setSelected([openDoc])}
        >
          This scene
        </button>
        <button
          type="button"
          className={SMALL_BUTTON}
          disabled={chapter === null}
          onClick={() => chapter !== null && scope.setSelected(scope.documentsUnder(chapter))}
        >
          This chapter
        </button>
        <button
          type="button"
          className={SMALL_BUTTON}
          data-testid="edit-pass-whole"
          onClick={() => scope.setSelected(scope.all)}
        >
          Whole manuscript
        </button>
        <button type="button" className={SMALL_BUTTON} onClick={() => scope.setSelected([])}>
          None
        </button>
      </div>
      {scope.rows.length === 0 ? (
        <p className="m-0 text-xs text-fg-muted">The manuscript has no scenes yet.</p>
      ) : (
        <ul
          className="m-0 flex max-h-72 list-none flex-col gap-0.5 overflow-y-auto p-0"
          aria-label="Manuscript"
        >
          {scope.rows.map(({ id, depth }) => {
            const node = byId[id]
            if (!node) return null
            const docs = scope.documentsUnder(id)
            const count = docs.filter((doc) => scope.selected.has(doc)).length
            const checked = docs.length > 0 && count === docs.length
            return (
              <li key={id} className={INDENT[Math.min(depth, INDENT.length - 1)]}>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={docs.length === 0}
                    ref={(el) => {
                      if (el) el.indeterminate = count > 0 && !checked
                    }}
                    onChange={() => scope.toggle(id)}
                  />
                  <span className={node.kind === 'folder' ? 'font-medium' : ''}>{node.title}</span>
                  <span className="text-xs text-fg-muted">
                    {formatCount(words[id] ?? 0, 'word')}
                  </span>
                </label>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
