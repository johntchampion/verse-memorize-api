import { db } from '../client'
import { columnExists } from '../introspect'

/** schema.sql's CREATE TABLEs are IF NOT EXISTS, so they are inert against a
    database that already has the table: new columns have to be applied here. */
function addColumnIfMissing(
  table: string,
  column: string,
  definition: string,
): void {
  if (columnExists(table, column)) return
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
}

export function migrateAddColumns(): void {
  // The default backfills existing users to what they were already reading.
  addColumnIfMissing('users', 'translation', "TEXT NOT NULL DEFAULT 'WEB'")

  // Nullable: NULL reads as "answered, unknown" rather than as a miss.
  addColumnIfMissing('session_exercise', 'correct', 'INTEGER')

  // Nullable: a day planned before stages were pinned keeps rendering at the
  // verse's live stage until the day rolls over.
  addColumnIfMissing('session_exercise', 'stage', 'TEXT')

  // Opt-in: an existing user shouldn't start getting reminders just because
  // the column arrived.
  addColumnIfMissing('users', 'reminders_enabled', 'INTEGER NOT NULL DEFAULT 0')
  addColumnIfMissing('users', 'reminder_last_sent_date', 'TEXT')
}
