/**
 * The two Node and Vite features the Worker's unit tests use, typed by hand: the Worker
 * `tsconfig` compiles against the Workers runtime types, not `@types/node` (whose globals would
 * clash with them), so only what `sqliteD1.ts` calls is declared here. Tests only; nothing in the
 * Worker bundle imports either.
 */

declare module 'node:sqlite' {
  type SqliteValue = string | number | bigint | null | Uint8Array

  export interface StatementResultingChanges {
    changes: number | bigint
    lastInsertRowid: number | bigint
  }

  export class StatementSync {
    all(...params: SqliteValue[]): Record<string, SqliteValue>[]
    run(...params: SqliteValue[]): StatementResultingChanges
    columns(): { name: string }[]
  }

  export class DatabaseSync {
    constructor(path: string)
    exec(sql: string): void
    prepare(sql: string): StatementSync
    close(): void
  }
}

/** Vite's eager glob import (`import.meta.glob`), as `sqliteD1.ts` uses it for the migrations. */
interface ImportMeta {
  glob<T>(
    pattern: string,
    options: { query: '?raw'; import: 'default'; eager: true }
  ): Record<string, T>
}
