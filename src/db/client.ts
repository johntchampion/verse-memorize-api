import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'

// Row shapes live in ./rows. Re-exported so the many existing importers of
// `db` and a row type keep working from one import.
export type {
  AttemptRow,
  ExerciseType,
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

interface ForeignKeyListRow {
  on_delete: string
}

/**
 * True once every foreign key on `table` cascades on delete. False for a
 * table with no declared foreign keys — none of the six tables
 * migrateAddCascadeDeletes() checks should ever hit that branch, but treating
 * it as "not done" rather than silently skipping is the safer failure mode if
 * a typo ever creeps into CASCADE_REBUILDS.
 */
function hasCascadeDeletes(table: string): boolean {
  const fks = db
    .prepare(`PRAGMA foreign_key_list(${table})`)
    .all() as ForeignKeyListRow[]
  return fks.length > 0 && fks.every((fk) => fk.on_delete === 'CASCADE')
}

interface CascadeRebuild {
  table: string
  /** CREATE TABLE statement for `${table}_new`, with ON DELETE CASCADE. */
  createNew: string
  /** Full, ordered column list used for the INSERT ... SELECT. */
  columns: string[]
  /** Indexes to reapply after the rename — DROP TABLE also drops them. */
  indexes: string[]
}

const CASCADE_REBUILDS: CascadeRebuild[] = [
  {
    table: 'user_verse',
    columns: [
      'id',
      'user_id',
      'verse_id',
      'stage',
      'consecutive_correct',
      'consecutive_incorrect',
      'streak_date',
      'interval_days',
      'due_at',
      'last_upgrade_date',
      'last_downgrade_date',
      'needs_relearning',
      'relearning_queued_at',
      'slot',
      'activated_at',
      'graduated_at',
    ],
    createNew: `
      CREATE TABLE user_verse_new (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        verse_id TEXT NOT NULL,
        stage TEXT NOT NULL,
        consecutive_correct INTEGER NOT NULL DEFAULT 0,
        consecutive_incorrect INTEGER NOT NULL DEFAULT 0,
        streak_date TEXT,
        interval_days INTEGER,
        due_at TEXT,
        last_upgrade_date TEXT,
        last_downgrade_date TEXT,
        needs_relearning INTEGER NOT NULL DEFAULT 0,
        relearning_queued_at TEXT,
        slot INTEGER,
        activated_at TEXT NOT NULL,
        graduated_at TEXT,
        UNIQUE(user_id, verse_id)
      )`,
    indexes: [
      'CREATE INDEX idx_user_verse_user ON user_verse(user_id)',
      'CREATE INDEX idx_user_verse_relearn ON user_verse(user_id, needs_relearning, relearning_queued_at)',
    ],
  },
  {
    table: 'user_queue',
    columns: ['user_id', 'verse_order', 'updated_at'],
    createNew: `
      CREATE TABLE user_queue_new (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        verse_order TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
    indexes: [],
  },
  {
    table: 'attempt',
    columns: ['id', 'user_verse_id', 'exercise_type', 'correct', 'created_at'],
    createNew: `
      CREATE TABLE attempt_new (
        id TEXT PRIMARY KEY,
        user_verse_id TEXT NOT NULL REFERENCES user_verse(id) ON DELETE CASCADE,
        exercise_type TEXT NOT NULL,
        correct INTEGER NOT NULL,
        created_at TEXT NOT NULL
      )`,
    indexes: [
      'CREATE INDEX idx_attempt_uv ON attempt(user_verse_id, created_at)',
    ],
  },
  {
    table: 'session_log',
    columns: ['id', 'user_id', 'completed_at'],
    createNew: `
      CREATE TABLE session_log_new (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        completed_at TEXT NOT NULL
      )`,
    indexes: [
      'CREATE INDEX idx_session_log_user ON session_log(user_id, completed_at)',
    ],
  },
  {
    table: 'session_exercise',
    columns: [
      'id',
      'user_id',
      'session_date',
      'position',
      'user_verse_id',
      'queue',
      'instance',
      'completed_at',
      'correct',
    ],
    createNew: `
      CREATE TABLE session_exercise_new (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        session_date TEXT NOT NULL,
        position INTEGER NOT NULL,
        user_verse_id TEXT NOT NULL REFERENCES user_verse(id) ON DELETE CASCADE,
        queue TEXT NOT NULL,
        instance INTEGER NOT NULL,
        completed_at TEXT,
        correct INTEGER,
        UNIQUE(user_id, session_date, position),
        UNIQUE(user_id, session_date, user_verse_id, queue, instance)
      )`,
    indexes: [
      'CREATE INDEX idx_session_exercise_day ON session_exercise(user_id, session_date, position)',
    ],
  },
  {
    table: 'session_event',
    columns: [
      'id',
      'user_id',
      'session_date',
      'created_at',
      'kind',
      'user_verse_id',
      'verse_id',
      'stage_from',
      'stage_to',
      'slot',
    ],
    createNew: `
      CREATE TABLE session_event_new (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        session_date TEXT NOT NULL,
        created_at TEXT NOT NULL,
        kind TEXT NOT NULL,
        user_verse_id TEXT NOT NULL REFERENCES user_verse(id) ON DELETE CASCADE,
        verse_id TEXT NOT NULL,
        stage_from TEXT,
        stage_to TEXT,
        slot INTEGER
      )`,
    indexes: [
      'CREATE INDEX idx_session_event_day ON session_event(user_id, session_date, created_at)',
    ],
  },
]

function rebuildWithCascade({
  table,
  createNew,
  columns,
  indexes,
}: CascadeRebuild): void {
  const cols = columns.join(', ')
  db.exec(createNew)
  db.exec(`INSERT INTO ${table}_new (${cols}) SELECT ${cols} FROM ${table}`)
  db.exec(`DROP TABLE ${table}`)
  db.exec(`ALTER TABLE ${table}_new RENAME TO ${table}`)
  for (const indexSql of indexes) db.exec(indexSql)
}

/**
 * Adds ON DELETE CASCADE to every foreign key, so deleting a user or a
 * user_verse row cleans up its dependents instead of SQLite rejecting the
 * delete (foreign_keys is ON). SQLite cannot ALTER a foreign key's ON DELETE
 * clause in place, so an existing table is rebuilt: a shadow table with the
 * same columns plus the cascading constraint, rows copied across, then
 * swapped in under the original name.
 *
 * Runs after the addColumnIfMissing() calls on purpose: those normalize each
 * table to its full, current column set first, so the explicit column lists
 * above line up on both sides of the INSERT regardless of how old the file
 * being migrated is. Table order among the six doesn't matter, since
 * foreign_keys is off for the whole transaction.
 *
 * foreign_keys must be off for all of it: SQLite refuses to DROP a table that
 * is an active FK target while enforcement is on, and every one of these six
 * tables is a target for at least one other. The pragma is a documented no-op
 * inside a transaction, so it's toggled outside the transaction, not inside.
 */
function migrateAddCascadeDeletes(): void {
  const pending = CASCADE_REBUILDS.filter((r) => !hasCascadeDeletes(r.table))
  if (pending.length === 0) return

  db.pragma('foreign_keys = OFF')
  try {
    db.transaction(() => {
      for (const rebuild of pending) rebuildWithCascade(rebuild)
    })()
  } finally {
    db.pragma('foreign_keys = ON')
  }
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

  // Nullable on purpose: an exercise answered before correctness was recorded
  // has no honest value to backfill, and NULL reads as "answered, unknown"
  // rather than as a miss.
  addColumnIfMissing('session_exercise', 'correct', 'INTEGER')

  migrateAddCascadeDeletes()
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
