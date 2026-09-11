/**
 * Opens its own readonly connection rather than importing db/client.ts, which
 * would open the live file read-write as a side effect of import.
 */
import path from 'node:path'
import Database from 'better-sqlite3'
import type { SessionLogRow } from '../../db/rows'
import type { Stage } from '../../domain/stage'

export interface AccountRow {
  id: string
  email: string
  created_at: string
  timezone: string
  translation: string
  push_enabled: number
  verses_started: number
  verses_practiced: number
  last_attempt_at: string | null
  attempts_24h: number
  attempts_7d: number
  attempts_30d: number
}

export interface SlottedVerseRow {
  user_id: string
  verse_id: string
  stage: Stage
  slot: number
}

export interface Snapshot {
  totalAccounts: number
  accounts: AccountRow[]
  sessionsByUser: Map<string, SessionLogRow[]>
  slottedByUser: Map<string, SlottedVerseRow[]>
}

const ACCOUNTS_SQL = `
  SELECT
    u.id, u.email, u.created_at, u.timezone, u.translation,
    (SELECT COUNT(*) FROM user_verse uv
       WHERE uv.user_id = u.id) AS verses_started,
    (SELECT COUNT(DISTINCT uv.id) FROM user_verse uv
       JOIN attempt a ON a.user_verse_id = uv.id
       WHERE uv.user_id = u.id) AS verses_practiced,
    (SELECT MAX(a.created_at) FROM attempt a
       JOIN user_verse uv ON uv.id = a.user_verse_id
       WHERE uv.user_id = u.id) AS last_attempt_at,
    (SELECT COUNT(*) FROM attempt a
       JOIN user_verse uv ON uv.id = a.user_verse_id
       WHERE uv.user_id = u.id
         AND a.created_at >= datetime('now', '-1 day')) AS attempts_24h,
    (SELECT COUNT(*) FROM attempt a
       JOIN user_verse uv ON uv.id = a.user_verse_id
       WHERE uv.user_id = u.id
         AND a.created_at >= datetime('now', '-7 days')) AS attempts_7d,
    (SELECT COUNT(*) FROM attempt a
       JOIN user_verse uv ON uv.id = a.user_verse_id
       WHERE uv.user_id = u.id
         AND a.created_at >= datetime('now', '-30 days')) AS attempts_30d,
    EXISTS(SELECT 1 FROM push_subscription ps
       WHERE ps.user_id = u.id) AS push_enabled
  FROM users u
  ORDER BY last_attempt_at DESC NULLS LAST`

function groupBy<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>()
  for (const row of rows) {
    const list = grouped.get(key(row))
    if (list) list.push(row)
    else grouped.set(key(row), [row])
  }
  return grouped
}

export function readSnapshot(): Snapshot {
  const dbPath = process.env.DB_PATH ?? path.join(process.cwd(), 'data.sqlite')
  const db = new Database(dbPath, { readonly: true })

  try {
    const { total } = db
      .prepare('SELECT COUNT(*) AS total FROM users')
      .get() as { total: number }

    const sessions = db
      .prepare('SELECT * FROM session_log ORDER BY user_id, completed_at')
      .all() as SessionLogRow[]

    const slotted = db
      .prepare(
        `SELECT user_id, verse_id, stage, slot FROM user_verse
          WHERE slot IS NOT NULL ORDER BY user_id, slot`,
      )
      .all() as SlottedVerseRow[]

    return {
      totalAccounts: total,
      accounts: db.prepare(ACCOUNTS_SQL).all() as AccountRow[],
      sessionsByUser: groupBy(sessions, (row) => row.user_id),
      slottedByUser: groupBy(slotted, (row) => row.user_id),
    }
  } finally {
    db.close()
  }
}
