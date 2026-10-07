import { useState } from 'react'
import { X } from 'lucide-react'
import {
  DevLogLevel,
  DevLogSource,
  type DevAiRequest,
  type DevLogEntry,
  type DevRequestText
} from '@shared/devtools'
import { useDevToolsStore } from './devToolsStore'

const BUTTON =
  'shrink-0 rounded-md border border-line px-2 py-0.5 text-xs hover:bg-bg disabled:opacity-50'
const SELECT = 'rounded-md border border-line bg-bg px-1 py-0.5 text-xs'

type PanelTab = 'log' | 'ai'

/**
 * The developer panel (2026-10-07): a drawer over the bottom of the window, not a dock column,
 * so the writing layout never moves and the editor above stays usable while it is open — the
 * author can type and watch VibeWrite's requests arrive (decided by Claude, unconfirmed;
 * `QUESTIONS.md`). Two tabs: the live log and the AI inspector. Opened from Help › Developer tools
 * or Ctrl+Shift+D, only while the switch in Settings › Advanced is on.
 */
export function DevToolsPanel(): React.JSX.Element | null {
  const open = useDevToolsStore((s) => s.open)
  const enabled = useDevToolsStore((s) => s.enabled)
  const log = useDevToolsStore((s) => s.log)
  const requests = useDevToolsStore((s) => s.requests)
  const error = useDevToolsStore((s) => s.error)
  const [tab, setTab] = useState<PanelTab>('ai')
  if (!open || !enabled) return null
  const store = useDevToolsStore.getState()

  return (
    <section
      aria-label="Developer tools"
      data-testid="devtools-panel"
      className="fixed inset-x-0 bottom-0 z-40 flex h-[45vh] flex-col border-t border-line bg-surface text-fg shadow-lg"
    >
      <header className="flex items-center gap-2 border-b border-line px-3 py-1.5">
        <h2 className="m-0 text-sm font-medium">Developer tools</h2>
        <div role="tablist" aria-label="Developer tools views" className="ml-2 flex gap-1">
          <TabButton id="ai" current={tab} onSelect={setTab}>
            AI requests ({requests.length})
          </TabButton>
          <TabButton id="log" current={tab} onSelect={setTab}>
            Log ({log.length})
          </TabButton>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <button type="button" className={BUTTON} onClick={() => void store.copyReport()}>
            Copy diagnostics
          </button>
          <button type="button" className={BUTTON} onClick={() => void store.openChromium()}>
            Chromium DevTools
          </button>
          <button
            type="button"
            aria-label="Close developer tools"
            className="rounded p-0.5 hover:bg-bg"
            onClick={store.closePanel}
          >
            <X size={14} aria-hidden />
          </button>
        </div>
      </header>
      {error === null ? null : (
        <p role="alert" className="m-0 border-b border-line px-3 py-1 text-xs text-danger">
          {error}
        </p>
      )}
      <div className="min-h-0 flex-1 overflow-auto">
        {tab === 'ai' ? <AiInspector requests={requests} /> : <LiveLog entries={log} />}
      </div>
    </section>
  )
}

function TabButton({
  id,
  current,
  onSelect,
  children
}: {
  id: PanelTab
  current: PanelTab
  onSelect: (id: PanelTab) => void
  children: React.ReactNode
}): React.JSX.Element {
  const selected = id === current
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      onClick={() => onSelect(id)}
      className={`rounded-md px-2 py-0.5 text-xs ${selected ? 'bg-bg font-medium' : 'text-fg-muted hover:bg-bg'}`}
    >
      {children}
    </button>
  )
}

type LevelFilter = DevLogLevel | 'all'
type SourceFilter = DevLogSource | 'all'

function LiveLog({ entries }: { entries: DevLogEntry[] }): React.JSX.Element {
  const [level, setLevel] = useState<LevelFilter>('all')
  const [source, setSource] = useState<SourceFilter>('all')
  const shown = entries
    .filter(
      (e) => (level === 'all' || e.level === level) && (source === 'all' || e.source === source)
    )
    .reverse()
  return (
    <div className="flex flex-col">
      <div className="sticky top-0 flex items-center gap-2 border-b border-line bg-surface px-3 py-1 text-xs">
        <label className="flex items-center gap-1">
          Level
          <select
            className={SELECT}
            value={level}
            onChange={(e) => setLevel(e.target.value as LevelFilter)}
          >
            <option value="all">All</option>
            {DevLogLevel.options.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1">
          Source
          <select
            className={SELECT}
            value={source}
            onChange={(e) => setSource(e.target.value as SourceFilter)}
          >
            <option value="all">All</option>
            {DevLogSource.options.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className={`${BUTTON} ml-auto`}
          onClick={() => void useDevToolsStore.getState().clear('log')}
        >
          Clear log
        </button>
      </div>
      {shown.length === 0 ? (
        <p className="m-0 px-3 py-2 text-xs text-fg-muted">No errors or warnings recorded.</p>
      ) : (
        <ul className="m-0 list-none p-0" data-testid="devtools-log">
          {shown.map((entry) => (
            <LogRow key={entry.id} entry={entry} />
          ))}
        </ul>
      )}
    </div>
  )
}

function LogRow({ entry }: { entry: DevLogEntry }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  return (
    <li className="border-b border-line px-3 py-1 font-mono text-xs">
      <div className="flex gap-2">
        <span className="text-fg-muted">{timeOf(entry.at)}</span>
        <span className={entry.level === 'error' ? 'text-danger' : 'text-warning'}>
          {entry.level}
        </span>
        <span className="text-fg-muted">[{entry.source}]</span>
        <span className="min-w-0 flex-1 break-words">{entry.message}</span>
        {entry.details === null ? null : (
          <button
            type="button"
            className="text-fg-muted underline"
            aria-expanded={expanded}
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? 'Hide details' : 'Details'}
          </button>
        )}
      </div>
      {expanded && entry.details !== null ? (
        <pre className="m-0 mt-1 whitespace-pre-wrap text-fg-muted">{entry.details}</pre>
      ) : null}
    </li>
  )
}

function AiInspector({ requests }: { requests: DevAiRequest[] }): React.JSX.Element {
  const shown = [...requests].reverse()
  return (
    <div className="flex flex-col">
      <div className="sticky top-0 flex items-center gap-2 border-b border-line bg-surface px-3 py-1 text-xs text-fg-muted">
        <span>
          Every request through the AI path, newest first. Prompt and answer text stay in memory and
          show only when you ask.
        </span>
        <button
          type="button"
          className={`${BUTTON} ml-auto`}
          onClick={() => void useDevToolsStore.getState().clear('requests')}
        >
          Clear requests
        </button>
      </div>
      {shown.length === 0 ? (
        <p className="m-0 px-3 py-2 text-xs text-fg-muted">No AI requests recorded yet.</p>
      ) : (
        <ul className="m-0 list-none p-0" data-testid="devtools-requests">
          {shown.map((row) => (
            <RequestRow key={row.id} row={row} />
          ))}
        </ul>
      )}
    </div>
  )
}

const STATUS_CLASS: Record<DevAiRequest['status'], string> = {
  running: 'text-accent',
  ok: 'text-fg',
  cached: 'text-fg-muted',
  failed: 'text-danger',
  cancelled: 'text-fg-muted',
  skipped: 'text-fg-muted'
}

function RequestRow({ row }: { row: DevAiRequest }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const text = useDevToolsStore((s) => (row.id in s.texts ? s.texts[row.id] : undefined))
  const store = useDevToolsStore.getState()
  return (
    <li className="border-b border-line px-3 py-1 text-xs" data-testid="devtools-request">
      <button
        type="button"
        className="flex w-full items-baseline gap-2 text-left font-mono"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
      >
        <span className="text-fg-muted">{timeOf(row.startedAt)}</span>
        <span className="w-28 shrink-0 truncate">{row.feature}</span>
        <span className={`w-16 shrink-0 ${STATUS_CLASS[row.status]}`}>{row.status}</span>
        <span className="w-40 shrink-0 truncate text-fg-muted">{row.model ?? '-'}</span>
        <span className="w-20 shrink-0">{ms(row.totalMs)}</span>
        <span className="min-w-0 flex-1 truncate text-fg-muted">
          {row.errorCode !== null
            ? `${row.errorCode}: ${row.errorMessage ?? ''}`
            : (row.note ?? '')}
        </span>
      </button>
      {expanded ? (
        <div className="mt-1 flex flex-col gap-1 pl-2">
          <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 font-mono">
            <Field label="Request id" value={row.requestId ?? '-'} />
            <Field
              label="Provider · model"
              value={`${row.provider ?? '-'} · ${row.model ?? '-'}`}
            />
            <Field
              label="Tier · prompt"
              value={`${row.tier ?? '-'} · ${row.promptVersion ?? '-'}`}
            />
            <Field
              label="Timing"
              value={`waiting ${ms(row.waitMs)} · first token ${row.streamed ? ms(row.firstTokenMs) : 'not streamed'} · total ${ms(row.totalMs)}`}
            />
            <Field
              label="Tokens"
              value={`${row.inputTokens ?? '-'} in (${row.cachedTokens ?? 0} cached) · ${row.outputTokens ?? '-'} out${row.reasoningTokens === null ? '' : ` (${row.reasoningTokens} reasoning)`} · cap ${row.maxTokens ?? '-'}`}
            />
            <Field
              label="Answer"
              value={`${row.answerChars ?? '-'} characters · finish ${row.finishReason ?? '-'}`}
            />
            <Field label="Cost" value={row.costUsd === null ? '-' : `$${row.costUsd.toFixed(6)}`} />
            {row.errorCode === null ? null : (
              <Field label="Error" value={`${row.errorCode}: ${row.errorMessage ?? ''}`} />
            )}
            {row.note === null ? null : <Field label="Note" value={row.note} />}
          </dl>
          {row.hasText ? (
            <div>
              {text === undefined ? (
                <button
                  type="button"
                  className={BUTTON}
                  onClick={() => void store.revealText(row.id)}
                >
                  Show text
                </button>
              ) : (
                <>
                  <button type="button" className={BUTTON} onClick={() => store.hideText(row.id)}>
                    Hide text
                  </button>
                  <RequestText text={text} />
                </>
              )}
            </div>
          ) : null}
        </div>
      ) : null}
    </li>
  )
}

function RequestText({ text }: { text: DevRequestText | null }): React.JSX.Element {
  if (text === null) return <p className="m-0 mt-1 text-fg-muted">Loading…</p>
  return (
    <div className="mt-1 flex flex-col gap-1">
      {text.messages.map((m, i) => (
        <pre
          key={i}
          className="m-0 max-h-48 overflow-auto rounded border border-line bg-bg p-1 font-mono whitespace-pre-wrap"
        >
          <strong>{m.role}</strong>
          {`\n${m.content}`}
        </pre>
      ))}
      <pre className="m-0 max-h-48 overflow-auto rounded border border-line bg-bg p-1 font-mono whitespace-pre-wrap">
        <strong>answer</strong>
        {`\n${text.response ?? '(none)'}`}
      </pre>
    </div>
  )
}

function Field({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <>
      <dt className="text-fg-muted">{label}</dt>
      <dd className="m-0 break-words">{value}</dd>
    </>
  )
}

function ms(value: number | null): string {
  return value === null ? '-' : `${Math.round(value)} ms`
}

function timeOf(iso: string): string {
  return iso.slice(11, 23)
}
