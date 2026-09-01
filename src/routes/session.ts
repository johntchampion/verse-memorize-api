import { randomUUID } from 'node:crypto'
import { Router } from 'express'
import { z } from 'zod'
import { db, type SessionLogRow, type UserRow } from '../db/client'
import * as userVerses from '../db/userVerseRepository'
import { legacyUserVerseBody } from '../domain/userVerse'
import { todayInTimezone } from '../lib/dates'
import { parseBody } from '../lib/http'
import { userId } from '../middleware/auth'
import { resolveTranslation, translation } from '../middleware/translation'
import { buildTodaySession } from '../services/sessionBuilder'
import { refillSlots } from '../services/slotRefill'
import { recordAttempt } from '../services/stageMachine'

export const sessionRouter = Router()

/** UTC for a user row that has gone missing, rather than throwing. */
function timezoneFor(id: string): string {
  const user = db.prepare('SELECT timezone FROM users WHERE id = ?').get(id) as
    Pick<UserRow, 'timezone'> | undefined
  return user?.timezone ?? 'UTC'
}

/** Today's ordered exercise queue. */
sessionRouter.get('/session/today', resolveTranslation, (req, res) => {
  const id = userId(req)
  const translationCode = translation(req)

  const exercises = buildTodaySession(id, timezoneFor(id), translationCode)
  res.json({
    translation: translationCode,
    exercises,
    count: exercises.length,
  })
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
  const body = parseBody(attemptBody, req, res)
  if (!body) return

  const userVerse = userVerses.findByIdForUser(body.userVerseId, id)
  if (!userVerse) {
    res.status(404).json({ error: 'user_verse not found' })
    return
  }

  const outcome = recordAttempt(
    userVerse,
    body.exerciseType,
    body.correct,
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
