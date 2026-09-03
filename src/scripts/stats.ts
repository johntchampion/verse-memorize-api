/**
 * Admin usage report: total accounts, plus per-account activity.
 * Read-only — opens its own readonly connection rather than importing
 * db/client.ts, which would open the live file read-write as a side effect
 * of import.
 *
 * Run inside the running container:
 *   docker exec -it <container> node dist/scripts/stats.js
 *   docker exec -it <container> npm run stats
 */
import path from 'node:path'
import Database from 'better-sqlite3'
import { currentStreak, sessionDates } from '../routes/me'
import { todayInTimezone } from '../lib/dates'
import type { SessionLogRow } from '../db/rows'

interface StatsRow {
  id: string
  email: string
  created_at: string
  timezone: string
  verses_started: number
  verses_practiced: number
  last_attempt_at: string | null
  attempts_7d: number
}

const DB_PATH = process.env.DB_PATH ?? path.join(process.cwd(), 'data.sqlite')
const db = new Database(DB_PATH, { readonly: true })

const { total } = db.prepare('SELECT COUNT(*) AS total FROM users').get() as {
  total: number
}

const rows = db
  .prepare(
    `SELECT
       u.id, u.email, u.created_at, u.timezone,
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
            AND a.created_at >= datetime('now', '-7 days')) AS attempts_7d
     FROM users u
     ORDER BY last_attempt_at DESC NULLS LAST`,
  )
  .all() as StatsRow[]

const sessionsByUser = new Map<string, SessionLogRow[]>()
for (const row of db
  .prepare('SELECT * FROM session_log ORDER BY user_id, completed_at')
  .all() as SessionLogRow[]) {
  const list = sessionsByUser.get(row.user_id)
  if (list) list.push(row)
  else sessionsByUser.set(row.user_id, [row])
}

function streakFor(userId: string, timezone: string): number {
  const days = sessionDates(sessionsByUser.get(userId) ?? [], timezone)
  return currentStreak(days, todayInTimezone(timezone))
}

const fmtDate = (iso: string | null) => (iso ? iso.slice(0, 10) : '—')

const columns = [
  { key: 'email', header: 'Email', align: 'left' },
  { key: 'created', header: 'Created', align: 'left' },
  { key: 'lastAttempt', header: 'Last Attempt', align: 'left' },
  { key: 'streak', header: 'Streak', align: 'right' },
  { key: 'started', header: 'Started', align: 'right' },
  { key: 'practiced', header: 'Practiced', align: 'right' },
  { key: 'attempts7d', header: 'Attempts/7d', align: 'right' },
] as const

const tableRows = rows.map((r) => ({
  email: r.email,
  created: fmtDate(r.created_at),
  lastAttempt: fmtDate(r.last_attempt_at),
  streak: String(streakFor(r.id, r.timezone)),
  started: String(r.verses_started),
  practiced: String(r.verses_practiced),
  attempts7d: String(r.attempts_7d),
}))

const widths = columns.map((c) =>
  Math.max(c.header.length, ...tableRows.map((r) => r[c.key].length)),
)

function formatRow(values: readonly string[]): string {
  return columns
    .map((c, i) =>
      c.align === 'right'
        ? values[i].padStart(widths[i])
        : values[i].padEnd(widths[i]),
    )
    .join('  ')
}

console.log(`Total accounts: ${total}\n`)
console.log(formatRow(columns.map((c) => c.header)))
console.log(formatRow(widths.map((w) => '-'.repeat(w))))
for (const r of tableRows) {
  console.log(formatRow(columns.map((c) => r[c.key])))
}

db.close()
