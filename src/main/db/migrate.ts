import type Database from 'better-sqlite3'
import { AppError } from '../ipc/errors'

export interface Migration {
  id: number
  name: string
  sql: string
}

const STATEMENT_BREAKPOINT = '--> statement-breakpoint'
const FILE_PATTERN = /(?:^|\/)(\d{4})_([\w-]+)\.sql$/

const bundled: Record<string, string> = import.meta.glob('./migrations/*.sql', {
  query: '?raw',
  import: 'default',
  eager: true
})

/** Parses `NNNN_name.sql` files into ordered migrations and checks the sequence is contiguous. */
export function loadMigrations(source: Record<string, string> = bundled): Migration[] {
  const migrations = Object.entries(source)
    .map(([file, sql]) => {
      const match = FILE_PATTERN.exec(file)
      if (!match) throw new Error(`Migration file name is not NNNN_name.sql: ${file}`)
      return { id: Number(match[1]), name: match[2]!, sql }
    })
    .sort((a, b) => a.id - b.id)

  migrations.forEach((m, index) => {
    if (m.id !== index) {
      throw new Error(
        `Migration ids must be contiguous from 0000; found ${m.id} at position ${index}`
      )
    }
  })
  return migrations
}

export function splitStatements(sql: string): string[] {
  return sql
    .split(STATEMENT_BREAKPOINT)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

export interface MigrateResult {
  applied: string[]
  version: number
}

/**
 * Applies pending migrations in order inside one transaction each and records them in
 * `schema_migrations`. Refuses to open a database that has migrations this build does not know.
 */
export function migrate(
  db: Database.Database,
  migrations: Migration[] = loadMigrations()
): MigrateResult {
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )`
  )
  const rows = db.prepare('SELECT id, name FROM schema_migrations ORDER BY id').all() as {
    id: number
    name: string
  }[]
  const known = new Map(migrations.map((m) => [m.id, m]))
  for (const row of rows) {
    const m = known.get(row.id)
    if (m?.name !== row.name) {
      throw new AppError(
        'IO',
        `This project was saved by a newer version of MythScribe (unknown migration ${row.id}_${row.name}). Update the app to open it.`
      )
    }
  }

  const appliedIds = new Set(rows.map((r) => r.id))
  const applied: string[] = []
  const insert = db.prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)')

  for (const m of migrations) {
    if (appliedIds.has(m.id)) continue
    db.transaction(() => {
      for (const statement of splitStatements(m.sql)) db.exec(statement)
      insert.run(m.id, m.name, new Date().toISOString())
    })()
    applied.push(`${String(m.id).padStart(4, '0')}_${m.name}`)
  }

  const version = migrations.length === 0 ? 0 : (migrations.at(-1)?.id ?? 0) + 1
  db.pragma(`user_version = ${version}`)
  return { applied, version }
}

export function currentVersion(db: Database.Database): number {
  return db.pragma('user_version', { simple: true }) as number
}
