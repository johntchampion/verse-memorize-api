import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { migrateAddCascadeDeletes } from './migrations/cascade'
import { migrateAddColumns } from './migrations/columns'
import { rejectPreRewriteDatabase } from './migrations/guard'

// Row shapes live in ./rows. Re-exported so the many existing importers of
// `db` and a row type keep working from one import.
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
 * Applies schema.sql, then any additive migrations. Every statement is IF NOT
 * EXISTS or guarded, so this is safe to run on every boot — there is no
 * migration tooling in v1.
 *
 * That also means it cannot reshape a table that already exists, which is why
 * it refuses a database written before the progression rewrite. Called from
 * server.ts before the port is opened, so a rejection stops the boot.
 */
export function migrate(): void {
  // Before any schema is applied: the current schema.sql would create
  // user_queue and add users.translation to the old file, leaving it neither
  // shape and making the problem harder to see than it is right now.
  rejectPreRewriteDatabase(DB_PATH)

  // Resolved relative to this module so it works from both src/ (tsx) and
  // dist/ (compiled); the build script copies schema.sql alongside.
  db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'))

  migrateAddColumns()
  migrateAddCascadeDeletes()
}
