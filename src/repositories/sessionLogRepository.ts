import { randomUUID } from 'node:crypto'
import { db } from '../db/client'
import type { SessionLogRow } from '../db/rows'

/**
 * Enough rows to decide "did they finish today" after rendering each
 * completed_at into the user's local date. Ten covers any timezone shift.
 */
const RECENT_LIMIT = 10

export function recentForUser(userId: string): SessionLogRow[] {
  return db
    .prepare(
      `SELECT * FROM session_log WHERE user_id = ?
        ORDER BY completed_at DESC LIMIT ?`,
    )
    .all(userId, RECENT_LIMIT) as SessionLogRow[]
}

export function allForUser(userId: string): SessionLogRow[] {
  return db
    .prepare(
      'SELECT * FROM session_log WHERE user_id = ? ORDER BY completed_at DESC',
    )
    .all(userId) as SessionLogRow[]
}

export function countForUser(userId: string): number {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM session_log WHERE user_id = ?')
    .get(userId) as { n: number }
  return row.n
}

export function insert(userId: string, completedAt: string): void {
  db.prepare(
    'INSERT INTO session_log (id, user_id, completed_at) VALUES (?, ?, ?)',
  ).run(randomUUID(), userId, completedAt)
}
