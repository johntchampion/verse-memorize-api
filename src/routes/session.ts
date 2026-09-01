import { randomUUID } from 'node:crypto'
import { Router } from 'express'
import { z } from 'zod'
import { db, type SessionLogRow, type UserRow } from '../db/client'
import * as userVerses from '../db/userVerseRepository'
import { legacyUserVerseBody } from '../domain/userVerse'
import { todayInTimezone } from '../lib/dates'
import { translationFor } from '../lib/translation'
import { userId } from '../middleware/auth'
import { buildTodaySession } from '../services/sessionBuilder'
import { refillSlots } from '../services/slotRefill'
import { recordAttempt } from '../services/stageMachine'

export const sessionRouter = Router()

/** The per-user settings the session endpoints need, in one read. */
interface Settings {
  timezone: string
  /** Raw stored preference; null for a user row that has gone missing. */
  translation: string | null
}

function settingsFor(id: string): Settings {
  const user = db
    .prepare('SELECT timezone, translation FROM users WHERE id = ?')
    .get(id) as Pick<UserRow, 'timezone' | 'translation'> | undefined
  return {
    timezone: user?.timezone ?? 'UTC',
    translation: user?.translation ?? null,
  }
}

function timezoneFor(id: string): string {
  return settingsFor(id).timezone
}

/** Today's ordered exercise queue. */
sessionRouter.get('/session/today', (req, res) => {
  const id = userId(req)
  const settings = settingsFor(id)
  const translation = translationFor(req, settings.translation)
  if (!translation) {
    res.status(400).json({ error: 'unknown translation' })
    return
  }

  const exercises = buildTodaySession(id, settings.timezone, translation)
  res.json({ translation, exercises, count: exercises.length })
})

const attemptBody = z.object({
  userVerseId: z.uuid(),
  exerciseType: z.enum(['tile_fill_blank', 'type_fill_blank']),
  correct: z.boolean(),
})

/**
 * Records one attempt and returns the updated user_verse so the client can
 * reflect stage changes immediately.
 */
sessionRouter.post('/attempt', (req, res) => {
  const id = userId(req)
  const parsed = attemptBody.safeParse(req.body)
  if (!parsed.success) {
    res
      .status(400)
      .json({ error: 'invalid body', details: z.treeifyError(parsed.error) })
    return
  }

  const userVerse = userVerses.findByIdForUser(parsed.data.userVerseId, id)
  if (!userVerse) {
    res.status(404).json({ error: 'user_verse not found' })
    return
  }

  const outcome = recordAttempt(
    userVerse,
    parsed.data.exerciseType,
    parsed.data.correct,
    timezoneFor(id),
  )

  res.json({
    userVerse: legacyUserVerseBody(outcome.userVerse),
    graduated: outcome.graduated,
    slotsFilled: outcome.slotsFilled.map(legacyUserVerseBody),
  })
})

/**
 * Marks the daily session complete and tops up any empty slots.
 * Idempotent per calendar day in the user's timezone.
 */
sessionRouter.post('/session/complete', (req, res) => {
  const id = userId(req)
  const timezone = timezoneFor(id)
  const today = todayInTimezone(timezone)

  // completed_at is a UTC instant, so "already logged today" is decided by
  // rendering recent rows back into the user's local date.
  const recent = db
    .prepare(
      'SELECT * FROM session_log WHERE user_id = ? ORDER BY completed_at DESC LIMIT 10',
    )
    .all(id) as SessionLogRow[]

  const alreadyLogged = recent.some(
    (row) => todayInTimezone(timezone, new Date(row.completed_at)) === today,
  )

  if (!alreadyLogged) {
    db.prepare(
      'INSERT INTO session_log (id, user_id, completed_at) VALUES (?, ?, ?)',
    ).run(randomUUID(), id, new Date().toISOString())
  }

  // Runs either way: a refill that failed earlier (bank exhausted, slot freed
  // between calls) should still get picked up on a repeat call.
  const slotsFilled = refillSlots(id)

  const { sessionsCompleted } = db
    .prepare(
      'SELECT COUNT(*) AS sessionsCompleted FROM session_log WHERE user_id = ?',
    )
    .get(id) as { sessionsCompleted: number }

  res.json({
    recorded: !alreadyLogged,
    sessionsCompleted,
    slotsFilled: slotsFilled.map(legacyUserVerseBody),
  })
})
