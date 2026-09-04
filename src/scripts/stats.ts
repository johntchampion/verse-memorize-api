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
import { getVerse } from '../data/verses'
import type { SessionLogRow } from '../db/rows'
import type { Stage } from '../domain/stage'

interface StatsRow {
  id: string
  email: string
  created_at: string
  timezone: string
  translation: string
  verses_started: number
  verses_practiced: number
  last_attempt_at: string | null
  attempts_24h: number
  attempts_7d: number
  attempts_30d: number
}

interface SlottedVerseRow {
  user_id: string
  verse_id: string
  stage: Stage
  slot: number
}

const DB_PATH = process.env.DB_PATH ?? path.join(process.cwd(), 'data.sqlite')
const db = new Database(DB_PATH, { readonly: true })

const { total } = db.prepare('SELECT COUNT(*) AS total FROM users').get() as {
  total: number
}

const rows = db
  .prepare(
    `SELECT
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
            AND a.created_at >= datetime('now', '-30 days')) AS attempts_30d
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

const slottedByUser = new Map<string, SlottedVerseRow[]>()
for (const row of db
  .prepare(
    `SELECT user_id, verse_id, stage, slot FROM user_verse
     WHERE slot IS NOT NULL ORDER BY user_id, slot`,
  )
  .all() as SlottedVerseRow[]) {
  const list = slottedByUser.get(row.user_id)
  if (list) list.push(row)
  else slottedByUser.set(row.user_id, [row])
}

function slottedLinesFor(userId: string, translation: string): string[] {
  const slotted = slottedByUser.get(userId)
  if (!slotted || slotted.length === 0) return ['—']
  return slotted.map((uv) => {
    const reference = getVerse(uv.verse_id, translation)?.reference ?? uv.verse_id
    return `${reference} (${uv.stage})`
  })
}

const fmtDate = (iso: string | null) => (iso ? iso.slice(0, 10) : '—')

const columns = [
  { key: 'email', header: 'Email', align: 'left' },
  { key: 'created', header: 'Created', align: 'left' },
  { key: 'lastAttempt', header: 'Last Attempt', align: 'left' },
  { key: 'streak', header: 'Streak', align: 'right' },
  { key: 'started', header: 'Started', align: 'right' },
  { key: 'practiced', header: 'Practiced', align: 'right' },
  { key: 'attempts24h', header: 'Attempts/24h', align: 'right' },
  { key: 'attempts7d', header: 'Attempts/7d', align: 'right' },
  { key: 'attempts30d', header: 'Attempts/30d', align: 'right' },
] as const

const tableRows = rows.map((r) => ({
  email: r.email,
  created: fmtDate(r.created_at),
  lastAttempt: fmtDate(r.last_attempt_at),
  streak: String(streakFor(r.id, r.timezone)),
  started: String(r.verses_started),
  practiced: String(r.verses_practiced),
  attempts24h: String(r.attempts_24h),
  attempts7d: String(r.attempts_7d),
  attempts30d: String(r.attempts_30d),
  slotted: slottedLinesFor(r.id, r.translation),
}))

const widths = columns.map((c) =>
  Math.max(c.header.length, ...tableRows.map((r) => r[c.key].length)),
)

const slottedHeader = 'Slotted Verses (Stage)'
const slottedWidth = Math.max(
  slottedHeader.length,
  ...tableRows.flatMap((r) => r.slotted).map((s) => s.length),
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
console.log(formatRow(columns.map((c) => c.header)) + '  ' + slottedHeader)
console.log(
  formatRow(widths.map((w) => '-'.repeat(w))) + '  ' + '-'.repeat(slottedWidth),
)
for (const r of tableRows) {
  const lineCount = Math.max(1, r.slotted.length)
  for (let i = 0; i < lineCount; i++) {
    const values = i === 0 ? columns.map((c) => r[c.key]) : columns.map(() => '')
    console.log(formatRow(values) + '  ' + (r.slotted[i] ?? ''))
  }
}

db.close()
