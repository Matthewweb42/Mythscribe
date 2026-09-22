import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { AiModels, defaultAiModels } from '@shared/ai'
import { RecentProjectEntry } from '@shared/ipc/contract'
import { DiagnosticsSettings, defaultDiagnosticsSettings } from '@shared/diagnostics'
import { StoredLayout, defaultLayout } from '@shared/layout'
import { SupporterSettings, defaultSupporterSettings } from '@shared/license'
import { UpdateSettings, defaultUpdateSettings } from '@shared/updates'
import { ViewSettings, defaultViewSettings } from '@shared/zoom'
import { AiUsageState, defaultAiUsageState } from '../ai/dailyCap'

/** Persistent, app-wide state (not project state) kept as one JSON file in userData. */
export const AppState = z.object({
  version: z.literal(1),
  recents: z.array(RecentProjectEntry),
  /**
   * F-7.2; defaulted so files written before it parse to the same layout as a fresh install,
   * and read leniently so a file from before F-7.3 (no sidebar tab) still loads.
   */
  layout: StoredLayout.default(defaultLayout),
  /** F-5.11: the tier → model mapping per provider; defaulted so older files load unchanged. */
  models: AiModels.default(defaultAiModels),
  /** F-5.14: the app-wide daily spend cap and the day's tally; defaulted for older files. */
  aiUsage: AiUsageState.default(defaultAiUsageState),
  /** F-15.7: the update channel, the automatic check, and the notes of the last download. */
  updates: UpdateSettings.default(defaultUpdateSettings),
  /**
   * F-15.8: the diagnostics switch (off on every install, including older files) and whatever
   * it has recorded but not sent. Nothing is recorded while it is off.
   */
  diagnostics: DiagnosticsSettings.default(defaultDiagnosticsSettings),
  /**
   * F-15.9: the last verified Supporter license token and the chosen accent; defaulted so older
   * files load as unlicensed. The token is signed, so plain JSON is safe: a tampered one fails
   * verification and is dropped.
   */
  supporter: SupporterSettings.default(defaultSupporterSettings),
  /**
   * F-7.10: the document zoom and the interface size, app-wide and applied on launch; defaulted
   * so older files open at 100 % and Medium. Main is the only writer, so a zoom off the step
   * table can only come from a hand-edited file, and the next keystroke snaps it back on.
   */
  view: ViewSettings.default(defaultViewSettings)
})
export type AppState = z.infer<typeof AppState>

export const EMPTY_APP_STATE: AppState = {
  version: 1,
  recents: [],
  layout: defaultLayout(),
  models: defaultAiModels(),
  aiUsage: defaultAiUsageState(),
  updates: defaultUpdateSettings(),
  diagnostics: defaultDiagnosticsSettings(),
  supporter: defaultSupporterSettings(),
  view: defaultViewSettings()
}

export class AppStateStore {
  private cache: AppState | null = null

  constructor(private readonly file: string) {}

  /** Reads lazily on first call; a missing file is empty, an invalid one warns once and is empty. */
  get(): AppState {
    if (this.cache) return this.cache
    this.cache = this.read()
    return this.cache
  }

  /** Computes the next state, writes it atomically, and returns it. */
  update(fn: (state: AppState) => AppState): AppState {
    const next = AppState.parse(fn(this.get()))
    this.write(next)
    this.cache = next
    return next
  }

  private read(): AppState {
    if (!fs.existsSync(this.file)) return EMPTY_APP_STATE
    try {
      const parsed = AppState.safeParse(JSON.parse(fs.readFileSync(this.file, 'utf8')))
      if (parsed.success) return parsed.data
      console.warn(`Ignoring invalid app state at ${this.file}`, parsed.error.issues)
    } catch (err) {
      console.warn(`Could not read app state at ${this.file}`, err)
    }
    return EMPTY_APP_STATE
  }

  private write(state: AppState): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8')
    fs.renameSync(tmp, this.file)
  }
}
