import { db } from '../client'
import { columnExists } from '../introspect'

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

export function migrateAddColumns(): void {
  // Existing users were reading WEB before there was anything else to read, so
  // the default backfills them to exactly what they already had.
  addColumnIfMissing('users', 'translation', "TEXT NOT NULL DEFAULT 'WEB'")

  // Nullable on purpose: an exercise answered before correctness was recorded
  // has no honest value to backfill, and NULL reads as "answered, unknown"
  // rather than as a miss.
  addColumnIfMissing('session_exercise', 'correct', 'INTEGER')

  // Also nullable, for the same reason: a day planned before the stage was
  // pinned has none to backfill, and those rows keep rendering at the verse's
  // live stage until the day rolls over.
  addColumnIfMissing('session_exercise', 'stage', 'TEXT')

  // Opt-in. An existing user who never asked for reminders shouldn't start
  // getting them just because the column arrived.
  addColumnIfMissing('users', 'reminders_enabled', 'INTEGER NOT NULL DEFAULT 0')

  // Nullable, so "never reminded" is representable and an existing user is
  // correctly treated as not yet reminded today.
  addColumnIfMissing('users', 'reminder_last_sent_date', 'TEXT')
}
