import { getVerse } from '../../data/verses'
import { formatInTimezone, todayInTimezone } from '../../lib/dates'
import { Streak } from '../../models/Streak'
import type { Snapshot } from './queries'

const FIELDS = [
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

const SLOTTED_LABEL = 'Slotted Verses'
const NONE = '—'

type Record = { [K in (typeof FIELDS)[number]['key']]: string } & {
  slotted: string[]
}

const asDateTime = (iso: string | null, timezone: string) =>
  iso ? formatInTimezone(timezone, new Date(iso)) : NONE

function toRecords(snapshot: Snapshot): Record[] {
  return snapshot.accounts.map((account) => {
    const sessions = snapshot.sessionsByUser.get(account.id) ?? []
    const streak = new Streak(sessions, account.timezone)

    return {
      email: account.email,
      created: asDateTime(account.created_at, account.timezone),
      timezone: account.timezone,
      translation: account.translation,
      lastAttempt: asDateTime(account.last_attempt_at, account.timezone),
      streak: String(streak.lengthAsOf(todayInTimezone(account.timezone))),
      started: String(account.verses_started),
      practiced: String(account.verses_practiced),
      attempts24h: String(account.attempts_24h),
      attempts7d: String(account.attempts_7d),
      attempts30d: String(account.attempts_30d),
      slotted: slottedLines(snapshot, account.id, account.translation),
    }
  })
}

function slottedLines(
  snapshot: Snapshot,
  userId: string,
  translation: string,
): string[] {
  const slotted = snapshot.slottedByUser.get(userId) ?? []
  if (slotted.length === 0) return [NONE]
  return slotted.map((verse) => {
    const reference =
      getVerse(verse.verse_id, translation)?.reference ?? verse.verse_id
    return `${reference} (${verse.stage})`
  })
}

export function renderReport(snapshot: Snapshot): string {
  const records = toRecords(snapshot)
  const width = Math.max(
    SLOTTED_LABEL.length,
    ...FIELDS.map((field) => field.label.length),
  )

  const lines = [`Total accounts: ${snapshot.totalAccounts}`, '']

  records.forEach((record, index) => {
    const header = `-[ RECORD ${index + 1} ]`
    lines.push(header + '-'.repeat(Math.max(0, width + 3 - header.length)))
    for (const field of FIELDS) {
      lines.push(`${field.label.padEnd(width)} | ${record[field.key]}`)
    }
    record.slotted.forEach((line, i) => {
      const label = i === 0 ? SLOTTED_LABEL : ''
      lines.push(`${label.padEnd(width)} | ${line}`)
    })
  })

  return lines.join('\n')
}
