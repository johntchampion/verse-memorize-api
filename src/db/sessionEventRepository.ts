import { randomUUID } from 'node:crypto'
import { db } from './client'
import type { SessionEventRow } from './rows'
import type { NewSessionEvent } from '../domain/sessionEvent'

/**
 * Every session_event query. Like the other repositories here, statements are
 * prepared per call rather than at module load: this module is imported before
 * migrate() has created the table.
 */

/**
 * Records one event against a user's day and hands back the row it wrote, so a
 * caller that has to report what it just did doesn't have to read the day back
 * and work out which rows are new.
 */
export function record(
  userId: string,
  date: string,
  now: string,
  event: NewSessionEvent,
): SessionEventRow {
  const row: SessionEventRow = {
    id: randomUUID(),
    user_id: userId,
    session_date: date,
    created_at: now,
    kind: event.kind,
    user_verse_id: event.userVerseId,
    verse_id: event.verseId,
    stage_from: event.stageFrom,
    stage_to: event.stageTo,
    slot: event.slot,
  }

  db.prepare(
    `INSERT INTO session_event
       (id, user_id, session_date, created_at, kind, user_verse_id, verse_id,
        stage_from, stage_to, slot)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.user_id,
    row.session_date,
    row.created_at,
    row.kind,
    row.user_verse_id,
    row.verse_id,
    row.stage_from,
    row.stage_to,
    row.slot,
  )

  return row
}

/**
 * A day's events, oldest first.
 *
 * Ordered by rowid after the timestamp because an attempt writes its own event
 * and any slot events it triggered inside one transaction, sharing a
 * `created_at` to the millisecond — insertion order is the only thing that
 * separates them, and it is the order they should be read back in.
 */
export function forDay(userId: string, date: string): SessionEventRow[] {
  return db
    .prepare(
      `SELECT * FROM session_event
        WHERE user_id = ? AND session_date = ?
        ORDER BY created_at, rowid`,
    )
    .all(userId, date) as SessionEventRow[]
}

/** Drops a user's finished days, alongside the plans they belong to. */
export function pruneBefore(userId: string, date: string): void {
  db.prepare(
    'DELETE FROM session_event WHERE user_id = ? AND session_date < ?',
  ).run(userId, date)
}
