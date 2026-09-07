/**
 * Every `attempt` query.
 *
 * `attempt` has no user_id — it hangs off user_verse — so the per-user lookups
 * all join. The access path is idx_attempt_uv (user_verse_id, created_at)
 * reached through idx_user_verse_user, which stays cheap only while the
 * created_at range is bounded. Attempts are never pruned, so an unbounded MAX
 * over a year-old account walks tens of thousands of index entries; that is why
 * each of these takes explicit bounds.
 */
import { randomUUID } from 'node:crypto'
import { db } from '../db/client'
import type { AttemptRow, ExerciseType } from '../db/rows'

/** Most recent attempts first; bounded so a long history can't be dumped whole. */
export function recentForUserVerse(
  userVerseId: string,
  limit: number,
): AttemptRow[] {
  return db
    .prepare(
      `SELECT * FROM attempt WHERE user_verse_id = ?
        ORDER BY created_at DESC LIMIT ?`,
    )
    .all(userVerseId, limit) as AttemptRow[]
}

export function record(
  userVerseId: string,
  exerciseType: ExerciseType,
  correct: boolean,
  now: string,
): void {
  db.prepare(
    `INSERT INTO attempt (id, user_verse_id, exercise_type, correct, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(randomUUID(), userVerseId, exerciseType, correct ? 1 : 0, now)
}

function instant(sql: string, ...params: unknown[]): string | null {
  const row = db.prepare(sql).get(...params) as
    { at: string | null } | undefined
  return row?.at ?? null
}

/** How the reminder finds its anchor day: the most recent prior day they
    attempted anything is the day their most recent prior attempt fell on, so
    one MAX answers it and no grouping is needed. */
export function lastAttemptBefore(
  userId: string,
  range: { since: string; before: string },
): string | null {
  return instant(
    `SELECT MAX(a.created_at) AS at
       FROM attempt a
       JOIN user_verse uv ON uv.id = a.user_verse_id
      WHERE uv.user_id = ?
        AND a.created_at >= ?
        AND a.created_at < ?`,
    userId,
    range.since,
    range.before,
  )
}

export function firstAttemptBetween(
  userId: string,
  fromIso: string,
  toIso: string,
): string | null {
  return instant(
    `SELECT MIN(a.created_at) AS at
       FROM attempt a
       JOIN user_verse uv ON uv.id = a.user_verse_id
      WHERE uv.user_id = ?
        AND a.created_at >= ?
        AND a.created_at < ?`,
    userId,
    fromIso,
    toIso,
  )
}

/** Bounded to the last few minutes by its only caller, which uses it to tell
    whether someone is mid-session right now. */
export function lastAttemptSince(
  userId: string,
  sinceIso: string,
): string | null {
  return instant(
    `SELECT MAX(a.created_at) AS at
       FROM attempt a
       JOIN user_verse uv ON uv.id = a.user_verse_id
      WHERE uv.user_id = ? AND a.created_at >= ?`,
    userId,
    sinceIso,
  )
}
