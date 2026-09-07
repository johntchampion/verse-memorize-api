import { Router } from 'express'
import { z } from 'zod'
import { Streak } from '../models/Streak'
import { User } from '../models/User'
import * as sessionLogs from '../repositories/sessionLogRepository'
import * as users from '../repositories/userRepository'
import * as userVerses from '../repositories/userVerseRepository'
import { getVerse, isTranslation, normalizeTranslation } from '../data/verses'
import {
  BadRequestError,
  NotFoundError,
  UnauthorizedError,
} from '../lib/errors'
import { validate, validated } from '../lib/http'
import { userId } from '../middleware/auth'
import { MAX_SLOTS } from '../services/slotRefill'

export const meRouter = Router()

/** The GET /api/me response body, shared with PATCH so both return one shape. */
function profileFor(id: string) {
  const row = users.findById(id)
  if (!row) return null

  const user = new User(row)
  const sessions = sessionLogs.allForUser(id)
  const streak = new Streak(sessions, user.timezone)

  const active = userVerses.slottedForUser(id)
  const versesStarted = userVerses.countForUser(id)

  const today = user.today()
  const translation = user.translation

  return {
    user: {
      id: user.id,
      email: user.email,
      timezone: user.timezone,
      translation,
      createdAt: user.createdAt,
      remindersEnabled: user.remindersEnabled,
    },
    streak: streak.lengthAsOf(today),
    completedToday: streak.completedOn(today),
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
        tierChangeUsedToday: verse.tierChangeUsedToday(today),
      })),
    },
  }
}

/** Profile, streak and slot state. */
meRouter.get('/me', (req, res) => {
  const profile = profileFor(userId(req))
  if (!profile) throw new NotFoundError('user not found')
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
meRouter.patch('/me', validate(patchBody), (req, res) => {
  const id = userId(req)
  const { timezone, translation, remindersEnabled } = validated(req, patchBody)

  if (timezone !== undefined && !isValidTimezone(timezone)) {
    throw new BadRequestError('unknown timezone')
  }
  if (translation !== undefined && !isTranslation(translation)) {
    throw new BadRequestError('unknown translation')
  }

  const updated = users.updateSettings(id, {
    timezone,
    translation:
      translation === undefined
        ? undefined
        : normalizeTranslation(translation)!,
    remindersEnabled,
  })
  if (!updated) throw new NotFoundError('user not found')

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
meRouter.post(
  '/me/delete-account',
  validate(deleteAccountBody),
  async (req, res) => {
    const id = userId(req)
    const { password } = validated(req, deleteAccountBody)

    const row = users.findById(id)
    if (!row) throw new NotFoundError('user not found')

    const ok = await new User(row).verifyPassword(password)
    if (!ok) throw new UnauthorizedError('invalid password')

    users.remove(id)
    res.json({ deleted: true })
  },
)
