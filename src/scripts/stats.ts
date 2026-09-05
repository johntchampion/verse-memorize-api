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

const fields = [
  { key: 'email', label: 'Email' },
  { key: 'created', label: 'Created' },
  { key: 'timezone', label: 'Timezone' },
  { key: 'translation', label: 'Translation' },
  { key: 'lastAttempt', label: 'Last Attempt' },
  { key: 'streak', label: 'Streak' },
  { key: 'started', label: 'Started' },
  { key: 'practiced', label: 'Practiced' },
  { key: 'attempts24h', label: 'Attempts/24h' },
  { key: 'attempts7d', label: 'Attempts/7d' },
  { key: 'attempts30d', label: 'Attempts/30d' },
] as const

const slottedLabel = 'Slotted Verses'

const tableRows = rows.map((r) => ({
  email: r.email,
  created: fmtDate(r.created_at),
  timezone: r.timezone,
  translation: r.translation,
  lastAttempt: fmtDate(r.last_attempt_at),
  streak: String(streakFor(r.id, r.timezone)),
  started: String(r.verses_started),
  practiced: String(r.verses_practiced),
  attempts24h: String(r.attempts_24h),
  attempts7d: String(r.attempts_7d),
  attempts30d: String(r.attempts_30d),
  slotted: slottedLinesFor(r.id, r.translation),
}))

const labelWidth = Math.max(
  slottedLabel.length,
  ...fields.map((f) => f.label.length),
)

console.log(`Total accounts: ${total}\n`)

tableRows.forEach((r, index) => {
  const header = `-[ RECORD ${index + 1} ]`
  console.log(header + '-'.repeat(Math.max(0, labelWidth + 3 - header.length)))
  for (const f of fields) {
    console.log(`${f.label.padEnd(labelWidth)} | ${r[f.key]}`)
  }
  r.slotted.forEach((line, i) => {
    const label = i === 0 ? slottedLabel : ''
    console.log(`${label.padEnd(labelWidth)} | ${line}`)
  })
})

db.close()
