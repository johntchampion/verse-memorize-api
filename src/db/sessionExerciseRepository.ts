import { randomUUID } from 'node:crypto'
import { db } from './client'
import type { SessionExerciseRow } from './rows'
import {
  type PlannedExercise,
  type SessionQueue,
  toPlannedExercise,
} from '../domain/sessionExercise'

/**
 * Every session_exercise query. Like userVerseRepository, statements are
 * prepared per call rather than at module load: this module is imported before
 * migrate() has created the table.
 */

/** What ensureTodayPlan hands down to be appended; position is assigned here. */
export interface NewPlanItem {
  userVerseId: string
  queue: SessionQueue
  instance: number
}

/** Today's plan in order. Empty means the day hasn't been started yet. */
export function forDay(userId: string, date: string): PlannedExercise[] {
  const rows = db
    .prepare(
      `SELECT * FROM session_exercise
        WHERE user_id = ? AND session_date = ?
        ORDER BY position`,
    )
    .all(userId, date) as SessionExerciseRow[]
  return rows.map(toPlannedExercise)
}

/**
 * Appends items to the end of a day's plan, numbering from `startPosition`.
 * Callers never renumber what is already there — a position, once handed to a
 * client, is the client's place in the queue for the rest of the day.
 */
export function append(
  userId: string,
  date: string,
  items: NewPlanItem[],
  startPosition: number,
): void {
  const insert = db.prepare(
    `INSERT INTO session_exercise
       (id, user_id, session_date, position, user_verse_id, queue, instance)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
  items.forEach((item, offset) => {
    insert.run(
      randomUUID(),
      userId,
      date,
      startPosition + offset,
      item.userVerseId,
      item.queue,
      item.instance,
    )
  })
}

/**
 * Marks the earliest outstanding exercise for this verse as done, recording how
 * it was answered. Returns false when there is nothing left to mark — which is
 * the normal case for a practice attempt made after the day's exercises are
 * finished, and why a drill's answers never land on the day's tally.
 */
export function completeNext(
  userId: string,
  date: string,
  userVerseId: string,
  now: string,
  correct: boolean,
): boolean {
  const result = db
    .prepare(
      `UPDATE session_exercise SET completed_at = ?, correct = ?
        WHERE id = (
          SELECT id FROM session_exercise
           WHERE user_id = ? AND session_date = ? AND user_verse_id = ?
             AND completed_at IS NULL
           ORDER BY position
           LIMIT 1
        )`,
    )
    .run(now, correct ? 1 : 0, userId, date, userVerseId)
  return result.changes > 0
}

/** Drops a user's finished days. Nothing reads a past day's plan. */
export function pruneBefore(userId: string, date: string): void {
  db.prepare(
    'DELETE FROM session_exercise WHERE user_id = ? AND session_date < ?',
  ).run(userId, date)
}
