/**
 * Attempt queries that ask about a *user* rather than a verse.
 *
 * `attempt` has no user_id — it hangs off user_verse — so every one of these
 * joins. The access path is idx_attempt_uv (user_verse_id, created_at) reached
 * through idx_user_verse_user: one short index range per verse the user has
 * started. That stays cheap only while the created_at range is bounded, which
 * is why each of these takes explicit bounds rather than scanning all history.
 * Attempts are never pruned, so an unbounded MAX over a year-old account walks
 * tens of thousands of index entries.
 *
 * Statements are prepared per call rather than at module load: this module is
 * imported before migrate() has created the tables.
 */
import { db } from './client'

/** All three of these are one aggregate over one bounded range. */
function instant(sql: string, ...params: unknown[]): string | null {
  const row = db.prepare(sql).get(...params) as
    { at: string | null } | undefined
  return row?.at ?? null
}

/**
 * The user's most recent attempt in `[sinceIso, beforeIso)`, or null.
 *
 * This is how the reminder finds its anchor day: "the most recent prior day on
 * which they attempted anything" is, by definition, the day their most recent
 * prior attempt fell on — so one MAX answers it and no grouping is needed.
 */
export function lastAttemptBefore(
  userId: string,
  beforeIso: string,
  sinceIso: string,
): string | null {
  return instant(
    `SELECT MAX(a.created_at) AS at
       FROM attempt a
       JOIN user_verse uv ON uv.id = a.user_verse_id
      WHERE uv.user_id = ?
        AND a.created_at >= ?
        AND a.created_at < ?`,
    userId,
    sinceIso,
    beforeIso,
  )
}

/** The user's first attempt in `[fromIso, toIso)` — one local day's worth. */
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

/**
 * The user's most recent attempt at or after `sinceIso`. Bounded to the last
 * few minutes by its only caller, which uses it to tell whether someone is
 * mid-session right now.
 */
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
