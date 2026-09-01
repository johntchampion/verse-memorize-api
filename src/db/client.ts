import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'

// Row shapes live in ./rows. Re-exported so the many existing importers of
// `db` and a row type keep working from one import.
export type {
  AttemptRow,
  ExerciseType,
  SessionLogRow,
  UserRow,
  UserVerseRow,
} from './rows'

const DB_PATH = process.env.DB_PATH ?? path.join(process.cwd(), 'data.sqlite')

export const db = new Database(DB_PATH)

db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

function tableExists(table: string): boolean {
  const found = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table)
  return found !== undefined
}

/** Returns false for a column of a table that doesn't exist yet: PRAGMA
    table_info yields no rows for an unknown table rather than erroring. */
function columnExists(table: string, column: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as {
    name: string
  }[]
  return columns.some((c) => c.name === column)
}

/**
 * Adds a column to an existing table, or does nothing if it is already there.
 * The CREATE TABLE statements in schema.sql are all IF NOT EXISTS, so they are
 * inert against a database that already has the table — a new column has to be
 * applied separately or existing databases never see it.
 *
 * SQLite allows ADD COLUMN ... NOT NULL only with a non-null default, which is
 * what backfills the existing rows.
 */
function addColumnIfMissing(
  table: string,
  column: string,
  definition: string,
): void {
  if (columnExists(table, column)) return
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
}

/**
 * Schema that only the pre-rewrite progression model created. Each is reported
 * rather than just the first, so a partially hand-edited file names everything
 * still wrong with it.
 */
function preRewriteMarkers(): string[] {
  const markers: string[] = []
  if (tableExists('review_schedule')) markers.push('a review_schedule table')
  for (const column of ['strength', 'correct_streak_in_tier']) {
    if (columnExists('user_verse', column)) {
      markers.push(`a user_verse.${column} column`)
    }
  }
  return markers
}

/**
 * Applies schema.sql, then any additive column migrations. Every statement is
 * IF NOT EXISTS or guarded, so this is safe to run on every boot — there is no
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
  rejectPreRewriteDatabase()

  // Resolved relative to this module so it works from both src/ (tsx) and
  // dist/ (compiled); the build script copies schema.sql alongside.
  const schemaPath = path.join(__dirname, 'schema.sql')
  db.exec(fs.readFileSync(schemaPath, 'utf8'))

  // Existing users were reading WEB before there was anything else to read, so
  // the default backfills them to exactly what they already had.
  addColumnIfMissing('users', 'translation', "TEXT NOT NULL DEFAULT 'WEB'")
}

/**
 * Refuses a database from before the progression rewrite.
 *
 * Such a file has a `user_verse` table of the old shape. `CREATE TABLE IF NOT
 * EXISTS` will not reshape it, so the scheduling columns the app reads —
 * due_at, interval_days, streak_date, needs_relearning — would simply never
 * exist, and every read would come back missing them. Failing here names the
 * cause; failing later names only a symptom, several layers away.
 *
 * There is no upgrade path: the old model stored a 0-100 strength score and the
 * new one stores streak counters and an interval ladder, and one cannot be
 * derived from the other.
 */
function rejectPreRewriteDatabase(): void {
  const markers = preRewriteMarkers()
  if (markers.length === 0) return

  throw new Error(
    `${DB_PATH} was written by the pre-rewrite progression model (found ${markers.join(', ')}).\n` +
      'The current schema cannot reshape it, and the old strength score cannot ' +
      'be converted into the streak counters and interval ladder that replaced ' +
      'it. Move the file aside and let a fresh one be created.',
  )
}
