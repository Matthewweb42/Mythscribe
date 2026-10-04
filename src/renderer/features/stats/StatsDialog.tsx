import { useEffect, useId, useState, type ReactNode } from 'react'
import {
  bestHour,
  dailySeries,
  describeStatsDay,
  formatHour,
  heatLevel,
  heatmapGrid,
  heatThresholds,
  WORDS_PER_DAY_DAYS,
  type AppearanceRow,
  type StatsDashboard
} from '@shared/statsDashboard'
import { useDocumentStore } from '@renderer/features/editor/documentStore'
import { formatActiveTime } from '@renderer/features/goals/goalFormat'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
import { ipc } from '@renderer/lib/ipc'
import { StatsFrame } from './StatsFrame'

interface StatsDialogProps {
  onClose: () => void
}

/** Heatmap shades by level, 0 (no words) to 4: design tokens only. */
const HEAT_CLASSES = ['bg-line', 'bg-accent/25', 'bg-accent/50', 'bg-accent/75', 'bg-accent']

const plural = (n: number, one: string, many = `${one}s`): string =>
  `${n.toLocaleString()} ${n === 1 ? one : many}`

/** The share of `value` in `max` as a CSS percentage (the one dynamic inline style). */
const percent = (value: number, max: number): string =>
  `${max <= 0 ? 0 : Math.max(0, Math.min(1, value / max)) * 100}%`

function Section({
  id,
  title,
  children
}: {
  id: string
  title: string
  children: ReactNode
}): React.JSX.Element {
  const headingId = useId()
  return (
    <section aria-labelledby={headingId} data-testid={id} className="flex flex-col gap-2">
      <h3 id={headingId} className="m-0 text-sm font-semibold">
        {title}
      </h3>
      {children}
    </section>
  )
}

function Empty({ children }: { children: ReactNode }): React.JSX.Element {
  return <p className="m-0 text-xs text-fg-muted">{children}</p>
}

/** A horizontal bar list: name, a bar scaled to the largest value, and the value's text. */
function BarList({
  rows
}: {
  rows: { key: string; name: ReactNode; value: number; detail: string }[]
}): React.JSX.Element {
  const max = Math.max(0, ...rows.map((row) => row.value))
  return (
    <ul className="m-0 flex list-none flex-col gap-1 p-0">
      {rows.map((row) => (
        <li
          key={row.key}
          data-testid="stats-row"
          className="grid grid-cols-[minmax(0,11rem)_1fr_auto] items-center gap-3 text-xs"
        >
          <span className="truncate">{row.name}</span>
          <span className="h-2 rounded-sm bg-line">
            <span
              className="block h-2 rounded-sm bg-accent"
              style={{ width: percent(row.value, max) }}
            />
          </span>
          <span className="text-right text-fg-muted tabular-nums">{row.detail}</span>
        </li>
      ))}
    </ul>
  )
}

function Heatmap({ stats }: { stats: StatsDashboard }): React.JSX.Element {
  const grid = heatmapGrid(stats.days, stats.today)
  const thresholds = heatThresholds(stats.days)
  const written = stats.days.filter((d) => d.words > 0)
  const total = written.reduce((sum, d) => sum + d.words, 0)
  return (
    <Section id="stats-heatmap" title="Writing calendar">
      <div className="flex gap-[3px] overflow-x-auto">
        {grid.map((week, w) => (
          <div key={w} className="flex flex-col gap-[3px]">
            {week.map((cell, d) => {
              if (cell === null) return <span key={d} className="size-2.5" />
              const level = heatLevel(cell.words, thresholds)
              const label = describeStatsDay(cell.day, cell.words)
              return (
                <span
                  key={d}
                  data-testid="heat-cell"
                  data-day={cell.day}
                  data-level={level}
                  title={label}
                  aria-label={label}
                  className={`size-2.5 rounded-[2px] ${HEAT_CLASSES[level] ?? ''}`}
                />
              )
            })}
          </div>
        ))}
      </div>
      {written.length === 0 ? (
        <Empty>No writing logged yet: words you write in the editor appear here.</Empty>
      ) : (
        <p className="m-0 text-xs text-fg-muted">
          {plural(total, 'word')} on {plural(written.length, 'day')} in the last year.
        </p>
      )}
    </Section>
  )
}

function Daily({ stats }: { stats: StatsDashboard }): React.JSX.Element {
  const series = dailySeries(stats.days, stats.today, WORDS_PER_DAY_DAYS)
  const max = Math.max(0, ...series.map((d) => d.words))
  const net = series.reduce((sum, d) => sum + d.words, 0)
  const written = series.filter((d) => d.words > 0)
  const average =
    written.length === 0
      ? 0
      : Math.round(written.reduce((sum, d) => sum + d.words, 0) / written.length)
  return (
    <Section id="stats-daily" title={`Words per day, last ${WORDS_PER_DAY_DAYS} days`}>
      {written.length === 0 ? (
        <Empty>No words written in the last {WORDS_PER_DAY_DAYS} days.</Empty>
      ) : (
        <>
          <div className="flex h-20 items-end gap-[2px] border-b border-line">
            {series.map((d) => (
              <span
                key={d.day}
                data-testid="day-bar"
                title={describeStatsDay(d.day, d.words)}
                className="flex-1 rounded-t-sm bg-accent"
                style={{ height: percent(d.words, max) }}
              />
            ))}
          </div>
          <p className="m-0 text-xs text-fg-muted tabular-nums">
            {plural(net, 'word')} in total · {plural(average, 'word')} a day on the{' '}
            {plural(written.length, 'day')} you wrote
          </p>
        </>
      )}
    </Section>
  )
}

function Hours({ stats }: { stats: StatsDashboard }): React.JSX.Element {
  const best = bestHour(stats.hours)
  const max = Math.max(0, ...stats.hours.map((h) => h.words))
  const activeMs = stats.hours.reduce((sum, h) => sum + h.activeMs, 0)
  return (
    <Section id="stats-hours" title="Productive hours">
      {best === null ? (
        <Empty>No writing logged yet: the hours you write in appear here.</Empty>
      ) : (
        <>
          <div className="flex h-16 items-end gap-[2px] border-b border-line">
            {stats.hours.map((h) => (
              <span
                key={h.hour}
                title={`${formatHour(h.hour)}–${formatHour((h.hour + 1) % 24)}: ${plural(h.words, 'word')}`}
                className={`flex-1 rounded-t-sm ${h.hour === best ? 'bg-accent' : 'bg-accent/50'}`}
                style={{ height: percent(h.words, max) }}
              />
            ))}
          </div>
          <div className="flex justify-between text-[10px] text-fg-subtle tabular-nums">
            <span>00</span>
            <span>06</span>
            <span>12</span>
            <span>18</span>
            <span>24</span>
          </div>
          <p className="m-0 text-xs text-fg-muted">
            Most words between {formatHour(best)} and {formatHour((best + 1) % 24)} · writing time{' '}
            {formatActiveTime(activeMs)}
          </p>
        </>
      )}
    </Section>
  )
}

function SceneLengths({ stats }: { stats: StatsDashboard }): React.JSX.Element {
  const { scenes } = stats
  return (
    <Section id="stats-scene-lengths" title="Scene lengths">
      {scenes.count === 0 ? (
        <Empty>No scenes yet.</Empty>
      ) : (
        <>
          <p className="m-0 text-xs text-fg-muted tabular-nums" data-testid="scene-count">
            {plural(scenes.count, 'scene')} · median {plural(scenes.median, 'word')} · mean{' '}
            {plural(scenes.mean, 'word')}
          </p>
          <BarList
            rows={scenes.buckets.map((bucket) => ({
              key: bucket.label,
              name: `${bucket.label} words`,
              value: bucket.count,
              detail: plural(bucket.count, 'scene')
            }))}
          />
          {scenes.shortest && scenes.longest ? (
            <p className="m-0 text-xs text-fg-muted">
              Shortest: {scenes.shortest.title} ({plural(scenes.shortest.words, 'word')}) · Longest:{' '}
              {scenes.longest.title} ({plural(scenes.longest.words, 'word')})
            </p>
          ) : null}
        </>
      )}
    </Section>
  )
}

function Pov({ stats }: { stats: StatsDashboard }): React.JSX.Element {
  const anySet = stats.pov.some((row) => row.pov !== null)
  return (
    <Section id="stats-pov" title="Point of view">
      {stats.scenes.count === 0 ? (
        <Empty>No scenes yet.</Empty>
      ) : !anySet ? (
        <Empty>No POV set on any scene: set it in a scene&apos;s metadata.</Empty>
      ) : (
        <BarList
          rows={stats.pov.map((row) => ({
            key: row.pov ?? '',
            name: row.pov ?? <span className="text-fg-muted">No POV set</span>,
            value: row.scenes,
            detail: `${plural(row.scenes, 'scene')} · ${plural(row.words, 'word')}`
          }))}
        />
      )}
    </Section>
  )
}

function Appearances({
  id,
  title,
  rows,
  truncated,
  empty
}: {
  id: string
  title: string
  rows: AppearanceRow[]
  truncated: boolean
  empty: string
}): React.JSX.Element {
  return (
    <Section id={id} title={title}>
      {rows.length === 0 ? (
        <Empty>{empty}</Empty>
      ) : (
        <>
          <BarList
            rows={rows.map((row) => ({
              key: row.tagId ?? `location:${row.name}`,
              name:
                row.tagId === null ? (
                  <>
                    {row.name} <span className="text-fg-subtle">(location, no tag)</span>
                  </>
                ) : (
                  row.name
                ),
              value: row.scenes,
              detail: [
                plural(row.scenes, 'scene'),
                ...(row.tagId === null ? [] : [plural(row.mentions, 'mention')]),
                ...(row.povScenes ? [`${row.povScenes.toLocaleString()} POV`] : [])
              ].join(' · ')
            }))}
          />
          {truncated ? <Empty>Showing the top {rows.length.toLocaleString()}.</Empty> : null}
        </>
      )}
    </Section>
  )
}

/**
 * Tools › Statistics… (F-10.5): the writing calendar, words per day, productive hours, scene
 * lengths, POVs, character appearances, and setting usage. Drafts are flushed first so the stored
 * counts include unsaved typing; then main answers everything at once (`stats:dashboard`).
 * Escape, Close, and the backdrop close it.
 */
export function StatsDialog({ onClose }: StatsDialogProps): React.JSX.Element {
  const [stats, setStats] = useState<StatsDashboard | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = async (): Promise<void> => {
      // A failed save is reported by the autosave itself; the stored figures are still worth showing.
      await useDocumentStore
        .getState()
        .flush()
        .catch(() => undefined)
      const answer = await ipc().invoke('stats:dashboard', undefined)
      if (!cancelled) setStats(answer)
    }
    load().catch((err: unknown) => toast.error(describeError(err)))
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <StatsFrame title="Statistics" widthClassName="w-[880px]" onClose={onClose}>
      {stats === null ? (
        <p className="m-0 text-xs text-fg-muted">Loading…</p>
      ) : (
        <div className="flex flex-col gap-5">
          <Heatmap stats={stats} />
          <div className="grid gap-5 md:grid-cols-2">
            <Daily stats={stats} />
            <Hours stats={stats} />
            <SceneLengths stats={stats} />
            <Pov stats={stats} />
            <Appearances
              id="stats-characters"
              title="Characters"
              rows={stats.characters}
              truncated={stats.truncated.characters}
              empty="No character tags yet: tag your characters to see where they appear."
            />
            <Appearances
              id="stats-settings"
              title="Settings"
              rows={stats.settings}
              truncated={stats.truncated.settings}
              empty="No setting tags or scene locations yet."
            />
          </div>
        </div>
      )}
    </StatsFrame>
  )
}
