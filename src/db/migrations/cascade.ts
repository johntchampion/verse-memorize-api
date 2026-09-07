import { db } from '../client'

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
      'stage',
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
        stage TEXT,
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
 * Adds ON DELETE CASCADE to every foreign key. SQLite cannot ALTER a foreign
 * key's ON DELETE clause in place, so an existing table is rebuilt: a shadow
 * table with the cascading constraint, rows copied across, then swapped in
 * under the original name.
 *
 * Runs after the column migrations on purpose: those normalize each table to
 * its full column set first, so the explicit column lists line up on both
 * sides of the INSERT however old the file being migrated is.
 *
 * foreign_keys must be off for all of it: SQLite refuses to DROP a table that
 * is an active FK target while enforcement is on, and each of these six is a
 * target for another. The pragma is a documented no-op inside a transaction,
 * so it is toggled outside the transaction, not inside.
 */
export function migrateAddCascadeDeletes(): void {
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
