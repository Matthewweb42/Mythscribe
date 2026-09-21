import { describe, expect, it } from 'vitest'
import { AI_FEATURE_IDS } from './ai'
import {
  CRASH_MESSAGE_MAX,
  CRASH_STACK_FRAMES,
  CrashReport,
  DIAGNOSTIC_COUNTERS,
  DIAGNOSTIC_QUEUE_MAX,
  DiagnosticCounter,
  DiagnosticsSettings,
  EXTERNAL_FRAME,
  aiRequestCounter,
  defaultDiagnosticsSettings,
  scrubMessage,
  scrubStack
} from './diagnostics'

const environment = {
  appVersion: '0.3.0',
  platform: 'win32',
  arch: 'x64',
  electron: '44.3.0'
}

describe('diagnostic counters (F-15.8)', () => {
  it('covers every AI feature and refuses a counter outside the set', () => {
    for (const feature of AI_FEATURE_IDS) {
      expect(DIAGNOSTIC_COUNTERS).toContain(aiRequestCounter(feature))
      expect(DiagnosticCounter.parse(aiRequestCounter(feature))).toBe(`ai.request.${feature}`)
    }
    expect(DIAGNOSTIC_COUNTERS).toContain('app.launch')
    expect(DiagnosticCounter.safeParse('ai.request.somethingElse').success).toBe(false)
    expect(DiagnosticCounter.safeParse('scene.title.The Fall of Ys').success).toBe(false)
  })

  it('has no duplicate counters', () => {
    expect(new Set(DIAGNOSTIC_COUNTERS).size).toBe(DIAGNOSTIC_COUNTERS.length)
  })
})

describe('scrubMessage (F-15.8)', () => {
  it('takes a manuscript sentence out of an error message', () => {
    const message =
      'Could not parse "She turned from the window, and the lamp guttered out." at offset 12'
    const scrubbed = scrubMessage(message)
    expect(scrubbed).toBe('Could not parse <text> at offset 12')
    expect(scrubbed).not.toContain('window')
    expect(scrubbed).not.toContain('lamp')
  })

  it('scrubs single quotes, backticks and curly quotes too', () => {
    expect(scrubMessage("Unknown tag 'dark forest' in chapter")).toBe(
      'Unknown tag <text> in chapter'
    )
    expect(scrubMessage('Bad template `He woke again.`')).toBe('Bad template <text>')
    expect(scrubMessage('Bad line \u201cHe woke again.\u201d')).toBe('Bad line <text>')
  })

  it('takes a Windows home path out, folder names and all', () => {
    const scrubbed = scrubMessage(
      'ENOENT: no such file or directory, open C:\\Users\\Matthew\\Documents\\My Novel.mythscribe\\project.db'
    )
    expect(scrubbed).not.toContain('Matthew')
    expect(scrubbed).not.toContain('Novel')
    expect(scrubbed).not.toContain('project.db')
    expect(scrubbed).toContain('<path>')
  })

  it('takes a POSIX path, a URL and an email address out', () => {
    expect(scrubMessage('failed at /home/lostfromlight/coding/mythscribe/out/main/index.js')).toBe(
      'failed at <path>'
    )
    expect(scrubMessage('POST https://api.mythscribe.app/diagnostics failed')).toBe(
      'POST <url> failed'
    )
    expect(scrubMessage('no account for author@example.com')).toBe('no account for <email>')
  })

  it('collapses whitespace and caps the message', () => {
    expect(scrubMessage('  two\n  lines  ')).toBe('two lines')
    const long = scrubMessage('x'.repeat(CRASH_MESSAGE_MAX * 2))
    expect(long.length).toBe(CRASH_MESSAGE_MAX)
    expect(long.endsWith('\u2026')).toBe(true)
  })
})

describe('scrubStack (F-15.8)', () => {
  const root = '/home/lostfromlight/coding/mythscribe'
  const stack = [
    'Error: something broke',
    `    at summarizeScene (${root}/out/main/index.js:12:3)`,
    `    at ${root}/out/main/index.js:40:9`,
    '    at processTicksAndRejections (node:internal/process/task_queues:95:5)',
    '    at /usr/lib/electron/resources/default_app.asar/main.js:110:2'
  ].join('\n')

  it('keeps app frames app-relative and turns every other frame into <external>', () => {
    expect(scrubStack(stack, [root])).toEqual([
      'out/main/index.js:12:3',
      'out/main/index.js:40:9',
      EXTERNAL_FRAME,
      EXTERNAL_FRAME
    ])
  })

  it('drops the message line and keeps nothing when no root matches', () => {
    expect(scrubStack(stack, [])).toEqual([
      EXTERNAL_FRAME,
      EXTERNAL_FRAME,
      EXTERNAL_FRAME,
      EXTERNAL_FRAME
    ])
    expect(scrubStack('TypeError: x is not a function', [root])).toEqual([])
    expect(scrubStack(null, [root])).toEqual([])
  })

  it('reads a Windows root and a file URL, whatever the separators', () => {
    const winRoot = 'C:\\Program Files\\MythScribe\\resources\\app.asar'
    const frames = scrubStack(
      [
        '    at run (C:\\Program Files\\MythScribe\\resources\\app.asar\\out\\main\\index.js:7:1)',
        '    at file:///C:/Program%20Files/MythScribe/resources/app.asar/out/main/other.js:8:2'
      ],
      [winRoot]
    )
    expect(frames[0]).toBe('out/main/index.js:7:1')
    // The percent-encoded form is another program's spelling of the same path, so it is external
    // rather than guessed at: nothing is sent that the scrubber is not sure about.
    expect(frames[1]).toBe(EXTERNAL_FRAME)
  })

  it('keeps at most CRASH_STACK_FRAMES frames', () => {
    const deep = Array.from({ length: 50 }, (_, i) => `    at ${root}/out/main/index.js:${i}:1`)
    expect(scrubStack(deep, [root])).toHaveLength(CRASH_STACK_FRAMES)
  })

  it('produces frames a crash report accepts', () => {
    const report = {
      ...environment,
      kind: 'main' as const,
      name: 'TypeError',
      message: scrubMessage('x is not a function'),
      stack: scrubStack(stack, [root])
    }
    expect(CrashReport.parse(report)).toEqual(report)
  })
})

describe('diagnostics settings (F-15.8)', () => {
  it('installs off, with nothing recorded and nothing ever sent', () => {
    expect(defaultDiagnosticsSettings()).toEqual({
      enabled: false,
      counts: {},
      queue: [],
      lastSentDay: null
    })
  })

  it('fills every field in for a stored object written before one of them existed', () => {
    expect(DiagnosticsSettings.parse({})).toEqual(defaultDiagnosticsSettings())
    expect(DiagnosticsSettings.parse({ enabled: true })).toEqual({
      ...defaultDiagnosticsSettings(),
      enabled: true
    })
  })

  it('refuses a day that is not a calendar day, a counter outside the set, and a long queue', () => {
    expect(
      DiagnosticsSettings.safeParse({ counts: { 'last week': { 'app.launch': 1 } } }).success
    ).toBe(false)
    expect(
      DiagnosticsSettings.safeParse({ counts: { '2026-09-21': { 'scene.opened': 1 } } }).success
    ).toBe(false)
    expect(
      DiagnosticsSettings.safeParse({ counts: { '2026-09-21': { 'app.launch': 3 } } }).success
    ).toBe(true)
    const crash = {
      ...environment,
      kind: 'renderer' as const,
      name: 'Error',
      message: 'boom',
      stack: []
    }
    expect(
      DiagnosticsSettings.safeParse({
        queue: Array.from({ length: DIAGNOSTIC_QUEUE_MAX + 1 }, () => crash)
      }).success
    ).toBe(false)
  })
})
