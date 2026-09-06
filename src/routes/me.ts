import bcrypt from 'bcrypt'
import { Router } from 'express'
import { z } from 'zod'
import { db, type SessionLogRow, type UserRow } from '../db/client'
import * as userVerses from '../db/userVerseRepository'
import {
  getVerse,
  isTranslation,
  normalizeTranslation,
  resolveTranslation,
} from '../data/verses'
import { addDays, todayInTimezone } from '../lib/dates'
import { parseBody } from '../lib/http'
import { userId } from '../middleware/auth'
import { MAX_SLOTS } from '../services/slotRefill'

export const meRouter = Router()

/** Local dates (YYYY-MM-DD) on which a session was completed. */
export function sessionDates(
  rows: SessionLogRow[],
  timezone: string,
): Set<string> {
  return new Set(
    rows.map((r) => todayInTimezone(timezone, new Date(r.completed_at))),
  )
}

/**
 * Consecutive days ending today (or yesterday, if today's session isn't done
 * yet) that have a session_log row, counted in the user's local dates.
 */
export function currentStreak(days: Set<string>, today: string): number {
  // An unfinished today shouldn't zero out a streak that's still alive.
  let cursor = days.has(today) ? today : addDays(today, -1)

  let streak = 0
  while (days.has(cursor)) {
    streak += 1
    cursor = addDays(cursor, -1)
  }
  return streak
}

/** The GET /api/me response body, shared with PATCH so both return one shape. */
function profileFor(id: string) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as
    UserRow | undefined
  if (!user) return null

  const sessions = db
    .prepare(
      'SELECT * FROM session_log WHERE user_id = ? ORDER BY completed_at DESC',
    )
    .all(id) as SessionLogRow[]

  const active = userVerses.slottedForUser(id)
  const versesStarted = userVerses.countForUser(id)

  const today = todayInTimezone(user.timezone)
  const translation = resolveTranslation(user.translation)
  const sessionDays = sessionDates(sessions, user.timezone)

  return {
    user: {
      id: user.id,
      email: user.email,
      timezone: user.timezone,
      translation,
      createdAt: user.created_at,
      remindersEnabled: user.reminders_enabled === 1,
    },
    streak: currentStreak(sessionDays, today),
    completedToday: sessionDays.has(today),
    sessionsCompleted: sessions.length,
    versesStarted,
    slots: {
      max: MAX_SLOTS,
      active: active.map((verse) => ({
        slot: verse.slot,
        userVerseId: verse.id,
        verseId: verse.verseId,
        reference: getVerse(verse.verseId, translation)?.reference ?? null,
        stage: verse.stage,
        consecutiveCorrect: verse.consecutiveCorrect,
        consecutiveIncorrect: verse.consecutiveIncorrect,
        // The correct-run only counts toward an upgrade if it was accrued
        // today, so the client needs the date to tell a live run from a dead
        // one carried over from yesterday.
        streakDate: verse.streakDate,
        // The one-tier-change-per-day cap, already spent: further correct
        // answers today are practice, not progress.
        tierChangeUsedToday:
          verse.lastUpgradeDate === today || verse.lastDowngradeDate === today,
      })),
    },
  }
}

/** Profile, streak and slot state. */
meRouter.get('/me', (req, res) => {
  const profile = profileFor(userId(req))
  if (!profile) {
    res.status(404).json({ error: 'user not found' })
    return
  }
  res.json(profile)
})

// Every field optional so a client can change one without restating the
// others, but an empty body is a mistake rather than a no-op update.
const patchBody = z
  .object({
    timezone: z.string().min(1).optional(),
    translation: z.string().min(1).optional(),
    remindersEnabled: z.boolean().optional(),
  })
  .refine(
    (body) =>
      body.timezone !== undefined ||
      body.translation !== undefined ||
      body.remindersEnabled !== undefined,
    {
      message:
        'expected timezone, translation, remindersEnabled, or a combination',
    },
  )

/** True when `Intl` recognises the timezone — the same check dates.ts relies on. */
function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone })
    return true
  } catch {
    return false
  }
}

/**
 * Updates profile settings.
 *
 * `timezone` drives every day-boundary calculation (streaks, due dates,
 * session idempotency). `translation` selects the text and decoys served, and
 * changing it touches no progress at all — user_verse rows key off a
 * translation-independent verse id. `remindersEnabled` is the daily-reminder
 * opt-in; turning it off deliberately leaves the user's push subscriptions in
 * place, so switching it back on costs no permission prompt and no
 * re-subscribe — the scheduler gates on this flag, not on having a device.
 */
meRouter.patch('/me', (req, res) => {
  const id = userId(req)
  const body = parseBody(patchBody, req, res)
  if (!body) return

  const { timezone, translation, remindersEnabled } = body

  if (timezone !== undefined && !isValidTimezone(timezone)) {
    res.status(400).json({ error: 'unknown timezone' })
    return
  }
  if (translation !== undefined && !isTranslation(translation)) {
    res.status(400).json({ error: 'unknown translation' })
    return
  }

  // Only the supplied fields are written, so a partial PATCH leaves the rest
  // of the row alone.
  const updates: string[] = []
  // Widened past string because SQLite spells a boolean 0 or 1.
  const values: (string | number)[] = []
  if (timezone !== undefined) {
    updates.push('timezone = ?')
    values.push(timezone)
  }
  if (translation !== undefined) {
    updates.push('translation = ?')
    values.push(normalizeTranslation(translation)!)
  }
  if (remindersEnabled !== undefined) {
    updates.push('reminders_enabled = ?')
    values.push(remindersEnabled ? 1 : 0)
  }

  const result = db
    .prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`)
    .run(...values, id)
  if (result.changes === 0) {
    res.status(404).json({ error: 'user not found' })
    return
  }

  res.json(profileFor(id))
})

const deleteAccountBody = z.object({ password: z.string().min(1) })

/**
 * Permanently deletes the caller's account and everything derived from it.
 *
 * POST rather than DELETE because it needs a body to re-confirm the password
 * before an irreversible action, and a DELETE body is the sort of thing
 * intermediaries feel free to drop (same reasoning as push/unsubscribe).
 * Deleting the users row is enough on its own: every dependent table
 * (user_verse, user_queue, session_log, session_exercise, session_event,
 * push_subscription, and attempt transitively via user_verse) is declared
 * ON DELETE CASCADE in schema.sql, proven by cascadeDelete.test.ts.
 */
meRouter.post('/me/delete-account', async (req, res) => {
  const id = userId(req)
  const body = parseBody(deleteAccountBody, req, res)
  if (!body) return

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as
    UserRow | undefined
  if (!user) {
    res.status(404).json({ error: 'user not found' })
    return
  }

  const ok = await bcrypt.compare(body.password, user.password_hash)
  if (!ok) {
    res.status(401).json({ error: 'invalid password' })
    return
  }

  db.prepare('DELETE FROM users WHERE id = ?').run(id)
  res.json({ deleted: true })
})
