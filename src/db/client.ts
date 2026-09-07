import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { migrateAddCascadeDeletes } from './migrations/cascade'
import { migrateAddColumns } from './migrations/columns'
import { rejectPreRewriteDatabase } from './migrations/guard'

export type {
  AttemptRow,
  ExerciseType,
  PushSubscriptionRow,
  SessionEventRow,
  SessionExerciseRow,
  SessionLogRow,
  UserRow,
  UserVerseRow,
} from './rows'

const DB_PATH = process.env.DB_PATH ?? path.join(process.cwd(), 'data.sqlite')

export const db = new Database(DB_PATH)

db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

/**
 * Every statement is IF NOT EXISTS or guarded, so this is safe on every boot —
 * there is no migration tooling in v1. That also means it cannot reshape an
 * existing table, which is why it refuses a pre-rewrite database.
 */
export function migrate(): void {
  // Before any schema is applied: schema.sql would half-migrate the old file,
  // leaving it neither shape and the problem harder to see.
  rejectPreRewriteDatabase(DB_PATH)

  // Relative to this module so it works from both src/ (tsx) and dist/.
  db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'))

  migrateAddColumns()
  migrateAddCascadeDeletes()
}
