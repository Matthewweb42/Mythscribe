import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { docToText } from '@shared/docText'
import { dismissedKey } from '@shared/memory/dismissed'
import { checkMemoryInvariants } from '@shared/memory/invariants'
import { pageTextBlocks } from '@shared/memory/pageMarks'
import type { SwitchoverConsent } from '@shared/memory/switchover'
import { FILED_BY_AI_HEADING } from '@shared/memory/switchoverMapping'
import { TAG_RANGE_MARK } from '@shared/tagRanges'
import type { TiptapNodeT } from '@shared/tiptap'
import {
  dismissed,
  draftText,
  label,
  labelLink,
  node,
  record,
  researchDoc,
  sceneDetail,
  snapshotText
} from '../../db/schema'
import { openProject, type ProjectSession } from '../../project/projectStore'
import { getStoryMemory } from '../../project/settingsStore'
import { researchRootId } from '../../research/researchTree'
import { documentJson } from '../../voice/profile'
import { getRecord, invariantAliases, listRecords } from '../recordStore'
import { ALREADY_SWITCHED, convertSwitchover, prepareSwitchover } from './convert'
import { buildFixtureV1, type FixtureV1 } from './fixtureV1'
import { inlineTagReplacements } from './plan'
import { createTrialCopy, NOT_A_TRIAL, requireSwitchoverTarget, switchoverTrialOf } from './trial'

let tmp: string
let fixture: FixtureV1
let session: ProjectSession

const NOW = new Date('2026-10-12T09:00:00.000Z')

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-switchover-'))
  fixture = await buildFixtureV1(path.join(tmp, 'Harbour Book.mythscribe'))
  session = fixture.session
})

afterEach(() => {
  session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

const db = (): ProjectSession['connection']['orm'] => session.connection.orm

/** The consent with every default replacement, the thread tag's words edited, and no merges. */
function consent(overrides: Partial<SwitchoverConsent> = {}): SwitchoverConsent {
  const replacements = inlineTagReplacements(db()).map((row) => ({
    key: row.key,
    text: row.key === fixture.tags.mill ? 'the burned mill' : row.replacement
  }))
  return { replacements, merges: [], ...overrides }
}

async function convert(given: SwitchoverConsent = consent()): Promise<void> {
  const prepared = await prepareSwitchover(db(), session.folder)
  convertSwitchover(db(), 'novel', prepared, given, NOW)
}

const byName = (name: string): ReturnType<typeof listRecords> =>
  listRecords(db()).filter((each) => each.name === name)

function only(name: string): NonNullable<ReturnType<typeof getRecord>> {
  const [found] = byName(name)
  const full = found === undefined ? null : getRecord(db(), found.id)
  if (full === null) throw new Error(`no record ${name}`)
  return full
}

/** A page's blocks as text, with ✗ before a Not canon one. */
function lines(page: TiptapNodeT | null): string[] {
  if (page === null) return []
  return pageTextBlocks(page).map((block) => `${block.notCanon ? '✗ ' : ''}${block.text}`)
}

function textOf(id: string): string {
  const row = db().select().from(node).where(eq(node.id, id)).get()
  const doc = documentJson({ content: row?.content ?? null })
  return doc === null ? '' : docToText(doc)
}

describe('convertSwitchover (F-16.15, plan P1 §6.2)', () => {
  it('makes a record of every author sheet and of every name and thread tag, and none of the AI’s', async () => {
    await convert()
    const names = listRecords(db()).map((each) => `${each.name} (${each.categoryId})`)
    expect(names.sort()).toEqual(
      [
        'Bell Tower (setting)',
        'Harbour (setting)',
        'Harrow (character)',
        'Harrow (setting)',
        'Ilse (character)',
        'Mara Vell (character)',
        'Missing ring (thread)',
        'Old Mill (setting)',
        'Oren Hale (character)',
        'Silver Coin (item)',
        'The Burned Mill (thread)',
        'Tide Guild (world)',
        'Tomas (character)',
        'Tomaz (character)',
        'Vell (character)'
      ].sort()
    )
    const mara = only('Mara Vell')
    expect(mara.origin).toBe('conversion')
    expect(mara.aliases.map((alias) => `${alias.text}${alias.isMain ? '*' : ''}`)).toEqual([
      'Mara Vell*',
      'Mara'
    ])
    const row = db().select().from(record).where(eq(record.id, mara.id)).get()
    expect(row?.legacyEntityId).toBe(fixture.entities.mara)
    expect(row?.legacyTagId).toBe(fixture.tags.mara)
    expect(only('Tomas').aliases.map((alias) => alias.text)).toEqual(['Tomas', 'Tom'])
    // Two sheets named Harrow share the name: shared on both, the alias invariant clean.
    for (const harrow of byName('Harrow')) {
      expect(getRecord(db(), harrow.id)?.aliases.every((alias) => alias.shared)).toBe(true)
    }
    expect(
      checkMemoryInvariants({
        claims: [],
        sceneHashes: new Map(),
        aliases: invariantAliases(db()),
        citations: []
      })
    ).toEqual([])
  })

  it('writes fields, dated lines, relationships and pages into Pinned, Plan and Idea sheets into Ideas', async () => {
    await convert()
    expect(lines(only('Mara Vell').pinned)).toEqual([
      'Age: 35',
      'Appearance: Grey eyes.',
      'A scar over one brow.',
      'Background: Born at sea, raised inland',
      "Age (from 3.1 'Scene 1'): 36",
      'Relationship: Mentor of Oren Hale (sworn teacher)',
      `✗ ${FILED_BY_AI_HEADING}`,
      '✗ Personality: Stubborn'
    ])
    expect(only('Mara Vell').ideas).toBeNull()
    expect(only('Oren Hale').pinned).toBeNull()
    expect(lines(only('Oren Hale').ideas)).toEqual(['Personality: Quiet'])
    expect(lines(only('Silver Coin').ideas)).toEqual(['Origin: Minted in the old city'])
    expect(lines(only('Missing ring').pinned)).toEqual([
      'Description: Who took the ring?',
      "Opened (from 2.1 'Scene 1'): The ring is gone"
    ])
  })

  it('moves what the AI wrote to the Not canon block and drops the write-up paragraphs', async () => {
    await convert()
    // The library run's page paragraph is the AI's; the sync write-up is gone.
    expect(lines(only('Old Mill').pinned)).toEqual([
      'The mill burned in the flood year.',
      `✗ ${FILED_BY_AI_HEADING}`,
      '✗ The wheel turns at night.'
    ])
    // A sheet a library run made and nobody edited since: all of it.
    expect(lines(only('Bell Tower').pinned)).toEqual([
      `✗ ${FILED_BY_AI_HEADING}`,
      '✗ Atmosphere: Cold and loud'
    ])
  })

  it('turns tone, content and custom tags into labels with their author links', async () => {
    await convert()
    const labels = db().select().from(label).all()
    expect(labels.map((each) => `${each.name}:${each.kind}:${each.colour}`).sort()).toEqual([
      'grief:custom:#6b7280',
      'melancholy:tone:#123456',
      'violence:content:#16a34a'
    ])
    const melancholy = labels.find((each) => each.name === 'melancholy')
    expect(melancholy?.legacyTagId).toBe(fixture.tags.melancholy)
    const links = db()
      .select()
      .from(labelLink)
      .all()
      .map(
        (link) =>
          `${labels.find((each) => each.id === link.labelId)?.name}@${fixture.scenes.indexOf(link.nodeId) + 1}`
      )
    // The AI's melancholy link on scene 2 is not the author's: dropped.
    expect(links.sort()).toEqual(['grief@2', 'melancholy@1', 'violence@2'])
  })

  it('makes Research of the uploads and the Project notes', async () => {
    await convert()
    const root = researchRootId(db())
    expect(root).not.toBeNull()
    const docs = db().select().from(researchDoc).all()
    const titled = docs.map((meta) => {
      const row = db().select().from(node).where(eq(node.id, meta.nodeId)).get()
      return `${row?.title}:${meta.origin}:${meta.fileType ?? '-'}:${meta.converted}:${meta.notCanon}`
    })
    expect(titled.sort()).toEqual([
      'Harbour notes:upload:docx:false:false',
      'Portrait:upload:image:false:false',
      'Project notes:written:-:false:true',
      'Tide tables:upload:pdf:true:false',
      'Timeline:written:-:false:false'
    ])
    const titleOf = (nodeId: string): string =>
      db().select().from(node).where(eq(node.id, nodeId)).get()?.title ?? ''
    const written = docs.filter((meta) => meta.origin === 'written')
    const notes = written.find((meta) => titleOf(meta.nodeId) === 'Project notes')
    expect(textOf(notes?.nodeId ?? '')).toBe('The book ends at the harbour.\nMaybe a sequel.')
    // The timeline's events stay readable while the Timeline section is hidden (P1-D8).
    const timeline = written.find((meta) => titleOf(meta.nodeId) === 'Timeline')
    expect(textOf(timeline?.nodeId ?? '').split('\n')).toEqual([
      'The flood (Spring, year 1820; scenes 1.1, 2.1, 4.1)',
      'The trial (year 1821; scene 3.1)'
    ])
    const tide = docs.find((meta) => meta.fileType === 'pdf')
    expect(textOf(tide?.nodeId ?? '')).toContain('Tide tables for 1820.')
    expect(docs.every((meta) => meta.origin === 'written' || meta.contextFileId !== null)).toBe(
      true
    )
  })

  it('types the scene details: POV and place by name, years on each run, “also here” from links', async () => {
    await convert()
    const [s1, s2, s3, s4] = fixture.scenes
    const detail = (id: string | undefined) =>
      db()
        .select()
        .from(sceneDetail)
        .where(eq(sceneDetail.nodeId, id ?? ''))
        .get()
    const nameOf = (id: string | null | undefined): string | null =>
      id === null || id === undefined ? null : (getRecord(db(), id)?.name ?? null)
    const one = detail(s1)
    expect(nameOf(one?.povRecordId)).toBe('Mara Vell')
    expect(nameOf(one?.placeRecordId)).toBe('Harbour')
    expect(one?.placeText).toBe('harbour')
    expect(one?.timeText).toBe('Spring: The flood')
    expect(one?.storyYear).toBe(1820)
    // Oren is linked to scene 1 and never named there; Tomas is named (by the replaced token).
    expect((JSON.parse(one?.alsoHere ?? '[]') as string[]).map(nameOf)).toEqual(['Oren Hale'])
    const two = detail(s2)
    expect(nameOf(two?.povRecordId)).toBe('Ilse')
    expect(nameOf(two?.placeRecordId)).toBe('Bell Tower')
    expect(two?.storyYear).toBeNull()
    expect(nameOf(detail(s3)?.povRecordId)).toBe('Oren Hale')
    expect(detail(s3)?.storyYear).toBe(1821)
    expect(detail(s4)?.storyYear).toBe(1820)
    // v1's reading order shows scene 4 (back at the flood after the trial) as set earlier, but
    // that flag was computed, never typed: every Flashback switch follows the book (review
    // 2026-10-14); the plan's notes name scene 4.
    expect([s1, s2, s3, s4].map((id) => detail(id)?.flashback)).toEqual([null, null, null, null])
  })

  it('by default names each record in the prose, so a scene that names it lists it under no “also here”', async () => {
    const [s1] = fixture.scenes
    const defaults = inlineTagReplacements(db()).map((row) => ({
      key: row.key,
      text: row.replacement
    }))
    await convert({ replacements: defaults, merges: [] })
    expect(textOf(s1 ?? '')).toBe(
      'Mara walked to the harbour with Tomas at dusk.\nThe The Burned Mill smoked.'
    )
    const row = db()
      .select()
      .from(sceneDetail)
      .where(eq(sceneDetail.nodeId, s1 ?? ''))
      .get()
    const nameOf = (id: string): string | null => getRecord(db(), id)?.name ?? null
    expect((JSON.parse(row?.alsoHere ?? '[]') as string[]).map(nameOf)).toEqual(['Oren Hale'])
  })

  it('rewrites inline tags in contents, notes and inactive drafts with the edited words; snapshots stay byte for byte', async () => {
    const [s1] = fixture.scenes
    const snapshotsBefore = db().select().from(snapshotText).all()
    await convert()
    expect(textOf(s1 ?? '')).toBe(
      'Mara walked to the harbour with Tomas at dusk.\nThe the burned mill smoked.'
    )
    const stored = documentJson({
      content:
        db()
          .select()
          .from(node)
          .where(eq(node.id, s1 ?? ''))
          .get()?.content ?? null
    })
    // The tag range stays, inert (decision P1-D11).
    expect(JSON.stringify(stored)).toContain(TAG_RANGE_MARK)
    expect(JSON.stringify(stored)).not.toContain('inlineTag')
    const notes =
      db()
        .select()
        .from(node)
        .where(eq(node.id, s1 ?? ''))
        .get()?.notes ?? ''
    expect(notes).toContain('Ask Mara Vell later.')
    const draft = db()
      .select()
      .from(draftText)
      .all()
      .find((row) => row.nodeId === s1)
    expect(draft?.content).toContain('with Tomas at dusk')
    expect(draft?.content).not.toContain('inlineTag')
    expect(db().select().from(snapshotText).all()).toEqual(snapshotsBefore)
    expect(JSON.stringify(snapshotsBefore)).toContain('inlineTag')
  })

  it('maps the dismissals that still apply and leaves the rest', async () => {
    await convert()
    const rows = db().select().from(dismissed).all()
    const tomas = only('Tomas').id
    const tomaz = only('Tomaz').id
    const [s1, , , , s5] = fixture.scenes
    expect(rows.map((row) => `${row.kind}:${row.key}`).sort()).toEqual(
      [
        `name:${dismissedKey({ kind: 'name', name: 'brannoc' })}`,
        `name:${dismissedKey({ kind: 'name', name: 'hesk' })}`,
        `notSame:${dismissedKey({ kind: 'notSame', a: tomas, b: tomaz })}`,
        `unlink:scene:${s5}|${s1}`
      ].sort()
    )
  })

  it('merges only the pairs the author ticked among those the dry run offered', async () => {
    const mara = `entity:${fixture.entities.mara}`
    const vell = `tag:${fixture.tags.vell}`
    await convert(
      consent({
        merges: [
          { keep: mara, merge: vell },
          // Not offered: ignored.
          { keep: `entity:${fixture.entities.oren}`, merge: mara }
        ]
      })
    )
    expect(byName('Vell')).toEqual([])
    expect(only('Mara Vell').aliases.map((alias) => alias.text)).toEqual([
      'Mara Vell',
      'Mara',
      'Vell'
    ])
    expect(byName('Oren Hale')).toHaveLength(1)
    expect(byName('Harrow')).toHaveLength(2)
  })

  it('switches the project to v2 once; a second run is refused', async () => {
    await convert()
    expect(getStoryMemory(db())).toEqual({ version: 'v2', switchedAt: NOW.toISOString() })
    await expect(convert()).rejects.toThrow(ALREADY_SWITCHED)
  })
})

/** The sha256 of every file under `folder`, by relative path. */
function folderHash(folder: string): string {
  const hash = createHash('sha256')
  const walk = (dir: string): void => {
    for (const entry of fs
      .readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else hash.update(`${path.relative(folder, full)}\u0000`).update(fs.readFileSync(full))
    }
  }
  walk(folder)
  return hash.digest('hex')
}

/** A database file opened from its bytes in memory (as a rollback-journal database). */
function inMemory(file: string): Database.Database {
  const bytes = fs.readFileSync(file)
  bytes[18] = 1
  bytes[19] = 1
  return new Database(bytes)
}

describe('the trial copy (decision P1-D12)', () => {
  it('refuses a project that is not a trial copy unless the in-place run asks', () => {
    expect(() => requireSwitchoverTarget(db(), { allowInPlace: false })).toThrow(NOT_A_TRIAL)
    expect(() => requireSwitchoverTarget(db(), { allowInPlace: true })).not.toThrow()
  })

  it('converts the copy and leaves the original folder’s bytes as they were', async () => {
    const folder = session.folder
    session.close()
    const before = folderHash(folder)
    // The open project's connection, as the handler has it; read from the bytes, so the test's
    // own reader touches nothing in the folder either.
    const source = inMemory(path.join(folder, 'project.db'))
    let copy: string
    try {
      copy = createTrialCopy({ folder, sqlite: source, name: 'Harbour Book' }, NOW)
    } finally {
      source.close()
    }
    expect(path.basename(copy)).toMatch(
      /^Harbour Book \(story memory test \d{4}-\d\d-\d\d \d{4}\)\.mythscribe$/
    )
    session = openProject(copy)
    expect(switchoverTrialOf(db())?.source).toBe(folder)
    expect(session.info.name).toMatch(/^Harbour Book \(story memory test /)
    requireSwitchoverTarget(db(), { allowInPlace: false })
    await convert()
    expect(getStoryMemory(db()).version).toBe('v2')
    expect(byName('Mara Vell')).toHaveLength(1)
    expect(folderHash(folder)).toBe(before)
    // The original still reads as v1, with its inline tag.
    const original = inMemory(path.join(folder, 'project.db'))
    try {
      const memory = original.prepare("SELECT value FROM settings WHERE key = 'storyMemory'").get()
      expect(memory).toBeUndefined()
      const row = original
        .prepare<[string], { content: string }>('SELECT content FROM node WHERE id = ?')
        .get(fixture.scenes[0] ?? '')
      expect(row?.content).toContain('inlineTag')
    } finally {
      original.close()
    }
  })
})
