import { randomUUID } from 'node:crypto'
import { db } from '../db/client'
import type { UserRow } from '../db/rows'
import { NotFoundError } from '../lib/errors'

export interface NewUser {
  email: string
  passwordHash: string
  timezone: string
  translation: string
  /** ISO 8601. */
  now: string
}

export interface UserSettings {
  timezone?: string
  translation?: string
  remindersEnabled?: boolean
}

export interface ReminderCandidateRow {
  id: string
  timezone: string
  reminder_last_sent_date: string | null
}

export function findById(id: string): UserRow | undefined {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) as
    UserRow | undefined
}

export function findByEmail(email: string): UserRow | undefined {
  return db.prepare('SELECT * FROM users WHERE email = ?').get(email) as
    UserRow | undefined
}

export function existsByEmail(email: string): boolean {
  return (
    db.prepare('SELECT id FROM users WHERE email = ?').get(email) !== undefined
  )
}

export function create(input: NewUser): string {
  const id = randomUUID()
  db.prepare(
    `INSERT INTO users (id, email, password_hash, created_at, timezone, translation)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.email,
    input.passwordHash,
    input.now,
    input.timezone,
    input.translation,
  )
  return id
}

/**
 * Writes only the fields present, so a partial update leaves the rest of the
 * row alone. Returns false when no such user exists.
 */
export function updateSettings(id: string, settings: UserSettings): boolean {
  const assignments: string[] = []
  // Widened past string because SQLite spells a boolean 0 or 1.
  const values: (string | number)[] = []

  if (settings.timezone !== undefined) {
    assignments.push('timezone = ?')
    values.push(settings.timezone)
  }
  if (settings.translation !== undefined) {
    assignments.push('translation = ?')
    values.push(settings.translation)
  }
  if (settings.remindersEnabled !== undefined) {
    assignments.push('reminders_enabled = ?')
    values.push(settings.remindersEnabled ? 1 : 0)
  }
  if (assignments.length === 0) return findById(id) !== undefined

  const result = db
    .prepare(`UPDATE users SET ${assignments.join(', ')} WHERE id = ?`)
    .run(...values, id)
  return result.changes > 0
}

export function updatePasswordHash(id: string, passwordHash: string): void {
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(
    passwordHash,
    id,
  )
}

/**
 * Revokes every token issued so far. Returns the new value rather than making
 * the caller re-read: signing from a row fetched before the bump would mint a
 * token that is already stale, so the reset would sign the user straight out.
 */
export function bumpTokenVersion(id: string): number {
  const row = db
    .prepare(
      'UPDATE users SET token_version = token_version + 1 WHERE id = ? RETURNING token_version',
    )
    .get(id) as { token_version: number } | undefined
  if (!row) throw new NotFoundError('user not found')
  return row.token_version
}

/** Every dependent table is ON DELETE CASCADE, so this is the whole account. */
export function remove(id: string): void {
  db.prepare('DELETE FROM users WHERE id = ?').run(id)
}

/**
 * No index on reminders_enabled: a two-valued column is the textbook case where
 * one buys nothing, and a filtered scan of `users` once a minute is microseconds.
 */
export function reminderCandidates(): ReminderCandidateRow[] {
  return db
    .prepare(
      `SELECT u.id, u.timezone, u.reminder_last_sent_date
         FROM users u
        WHERE u.reminders_enabled = 1
          AND EXISTS (SELECT 1 FROM push_subscription s WHERE s.user_id = u.id)`,
    )
    .all() as ReminderCandidateRow[]
}

/**
 * Claims today's reminder, atomically. Conditional so that two overlapping
 * ticks cannot both win.
 */
export function claimReminderDay(id: string, today: string): boolean {
  return (
    db
      .prepare(
        `UPDATE users SET reminder_last_sent_date = ?
          WHERE id = ?
            AND (reminder_last_sent_date IS NULL OR reminder_last_sent_date <> ?)`,
      )
      .run(today, id, today).changes === 1
  )
}
