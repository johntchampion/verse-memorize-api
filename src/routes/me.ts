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
function sessionDates(rows: SessionLogRow[], timezone: string): Set<string> {
  return new Set(
    rows.map((r) => todayInTimezone(timezone, new Date(r.completed_at))),
  )
}

/**
 * Consecutive days ending today (or yesterday, if today's session isn't done
 * yet) that have a session_log row, counted in the user's local dates.
 */
function currentStreak(days: Set<string>, today: string): number {
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

// Both fields optional so a client can change one without restating the
// other, but an empty body is a mistake rather than a no-op update.
const patchBody = z
  .object({
    timezone: z.string().min(1).optional(),
    translation: z.string().min(1).optional(),
  })
  .refine(
    (body) => body.timezone !== undefined || body.translation !== undefined,
    {
      message: 'expected timezone, translation, or both',
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
 * translation-independent verse id.
 */
meRouter.patch('/me', (req, res) => {
  const id = userId(req)
  const body = parseBody(patchBody, req, res)
  if (!body) return

  const { timezone, translation } = body

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
  const values: string[] = []
  if (timezone !== undefined) {
    updates.push('timezone = ?')
    values.push(timezone)
  }
  if (translation !== undefined) {
    updates.push('translation = ?')
    values.push(normalizeTranslation(translation)!)
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
