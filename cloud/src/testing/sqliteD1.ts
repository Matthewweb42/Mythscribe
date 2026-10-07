/**
 * The Worker's unit tests run the production store (`d1Store`) against an in-memory SQLite
 * database built from the real migrations, so every SQL statement that ships — the conditional
 * hold, the append-only triggers, the partial refund — is the one under test. `node:sqlite` is
 * synchronous; this wraps it in the slice of D1 the store uses (`SqlDatabase`), with a batch run
 * as one transaction like D1's. Tests only: nothing in the Worker imports this file.
 */
import { DatabaseSync } from 'node:sqlite'
import {
  d1Store,
  type HoldRow,
  type LedgerEntryRow,
  type RawHold,
  type RawLedgerEntry,
  type SqlDatabase,
  type SqlResult,
  type SqlStatement,
  type SqlValue,
  type Store,
  type StoredDiagnosticCount,
  type StoredDiagnosticCrash,
  toHold,
  toLedgerEntry
} from '../store'

/** Every migration, by file name, in the order `wrangler d1 migrations apply` runs them. */
const MIGRATIONS: [string, string][] = Object.entries(
  import.meta.glob<string>('../../migrations/*.sql', {
    query: '?raw',
    import: 'default',
    eager: true
  })
)
  .map(([path, sql]): [string, string] => [path.slice(path.lastIndexOf('/') + 1), sql])
  .sort(([a], [b]) => a.localeCompare(b))

export const MIGRATION_NAMES: readonly string[] = MIGRATIONS.map(([name]) => name)

/** Apply the migrations in order; `until` stops before the named one (for migration tests). */
export function migrate(db: DatabaseSync, options: { from?: string; until?: string } = {}): void {
  for (const [name, sql] of MIGRATIONS) {
    if (options.from !== undefined && name < options.from) continue
    if (options.until !== undefined && name >= options.until) break
    db.exec(sql)
  }
}

class Statement implements SqlStatement {
  constructor(
    private readonly db: DatabaseSync,
    private readonly sql: string,
    private readonly values: SqlValue[] = []
  ) {}

  bind(...values: SqlValue[]): SqlStatement {
    return new Statement(this.db, this.sql, values)
  }

  /** What D1 answers for one statement: the rows it returned, and the rows it changed. */
  execute(): SqlResult<unknown> {
    const statement = this.db.prepare(this.sql)
    if (statement.columns().length > 0) {
      const rows = statement.all(...this.values)
      return { results: rows, meta: { changes: rows.length } }
    }
    const outcome = statement.run(...this.values)
    return { results: [], meta: { changes: Number(outcome.changes) } }
  }

  first<T>(): Promise<T | null> {
    try {
      const row = this.execute().results[0]
      return Promise.resolve(row === undefined ? null : (row as T))
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)))
    }
  }

  all<T>(): Promise<SqlResult<T>> {
    try {
      const result = this.execute()
      return Promise.resolve({ results: result.results as T[], meta: result.meta })
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)))
    }
  }

  run(): Promise<SqlResult<unknown>> {
    try {
      return Promise.resolve(this.execute())
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)))
    }
  }
}

/** D1's surface over one `node:sqlite` database. */
export function sqliteD1(db: DatabaseSync): SqlDatabase {
  return {
    prepare: (query) => new Statement(db, query),
    batch(statements) {
      db.exec('BEGIN')
      try {
        const results = statements.map((statement) => {
          if (!(statement instanceof Statement)) throw new Error('Not a statement of this database')
          return statement.execute()
        })
        db.exec('COMMIT')
        return Promise.resolve(results)
      } catch (error) {
        db.exec('ROLLBACK')
        return Promise.reject(error instanceof Error ? error : new Error(String(error)))
      }
    }
  }
}

/** The production store plus the read-backs the tests assert on; no handler reads these. */
export interface TestStore extends Store {
  readonly db: DatabaseSync
  diagnosticCounts(): StoredDiagnosticCount[]
  diagnosticCrashes(): StoredDiagnosticCrash[]
  /** Every ledger row, oldest first. */
  ledger(): Promise<LedgerEntryRow[]>
  holds(): Promise<HoldRow[]>
  /** Write one `billing_config` row, as the operator would with `wrangler d1 execute`. */
  setConfig(key: string, value: unknown): void
}

/** A fresh, fully migrated database behind the production store. */
export function testStore(db: DatabaseSync = new DatabaseSync(':memory:')): TestStore {
  if (!db.prepare("SELECT name FROM sqlite_master WHERE name = 'users'").all().length) migrate(db)
  const sql = sqliteD1(db)
  const rows = (query: string): Record<string, unknown>[] => db.prepare(query).all()
  return {
    ...d1Store(sql),
    db,
    diagnosticCounts: () =>
      rows('SELECT * FROM diagnostic_counts ORDER BY rowid').map((row) => ({
        day: String(row.day),
        appVersion: String(row.app_version),
        platform: String(row.platform),
        counter: String(row.counter),
        total: Number(row.total)
      })),
    diagnosticCrashes: () =>
      rows('SELECT * FROM diagnostic_crashes ORDER BY rowid').map((row) => ({
        fingerprint: String(row.fingerprint),
        kind: String(row.kind),
        name: String(row.name),
        message: String(row.message),
        stack: String(row.stack),
        appVersion: String(row.app_version),
        platform: String(row.platform),
        arch: String(row.arch),
        count: Number(row.count),
        firstSeen: Number(row.first_seen),
        lastSeen: Number(row.last_seen)
      })),
    ledger: async () =>
      (
        await sql
          .prepare('SELECT * FROM ledger_entries ORDER BY created_at, rowid')
          .all<RawLedgerEntry>()
      ).results.map(toLedgerEntry),
    holds: async () =>
      (
        await sql.prepare('SELECT * FROM holds ORDER BY created_at, rowid').all<RawHold>()
      ).results.map(toHold),
    setConfig: (key, value) => {
      db.prepare(
        `INSERT INTO billing_config (key, value, updated_at) VALUES (?, ?, 0)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`
      ).run(key, typeof value === 'string' ? value : JSON.stringify(value))
    }
  }
}
