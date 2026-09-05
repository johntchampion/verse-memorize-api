import { randomUUID } from 'node:crypto'
import { Router, type Request } from 'express'
import { z } from 'zod'
import {
  db,
  type SessionEventRow,
  type SessionLogRow,
  type UserRow,
} from '../db/client'
import * as sessionEvents from '../db/sessionEventRepository'
import * as userVerses from '../db/userVerseRepository'
import { getVerse } from '../data/verses'
import { slotEvent } from '../domain/sessionEvent'
import { legacyUserVerseBody } from '../domain/userVerse'
import { todayInTimezone } from '../lib/dates'
import { parseBody } from '../lib/http'
import { userId } from '../middleware/auth'
import { resolveTranslation, translation } from '../middleware/translation'
import {
  buildPracticeSession,
  buildTodaySession,
} from '../services/sessionBuilder'
import { pruneBefore } from '../services/sessionPlan'
import { refillSlots } from '../services/slotRefill'
import { recordAttempt } from '../services/stageMachine'

export const sessionRouter = Router()

/** UTC for a user row that has gone missing, rather than throwing. */
function timezoneFor(id: string): string {
  const user = db.prepare('SELECT timezone FROM users WHERE id = ?').get(id) as
    Pick<UserRow, 'timezone'> | undefined
  return user?.timezone ?? 'UTC'
}

/** Accepts `true` or `1`; anything else, including absent, is false. */
function practiceRequested(req: Request): boolean {
  const flag = req.query.practice
  return flag === 'true' || flag === '1'
}

/**
 * A recorded event, as the completion screen needs it.
 *
 * The stored row keeps only the verse slug, because a slug is what stays true
 * across a translation change; the human reference is rendered here, from the
 * bank the reader is currently on. That is also what lets a slot event name the
 * verse that arrived instead of just the slot it landed in.
 *
 * A verse missing from the bank is dropped rather than served referenceless —
 * the same call sessionBuilder.render makes.
 */
function sessionEventBody(row: SessionEventRow, translationCode: string) {
  const verse = getVerse(row.verse_id, translationCode)
  if (!verse) return null

  return {
    id: row.id,
    kind: row.kind,
    verseId: row.verse_id,
    reference: verse.reference,
    stageFrom: row.stage_from,
    stageTo: row.stage_to,
    slot: row.slot,
    createdAt: row.created_at,
  }
}

/** Every event in `rows` that still has a verse behind it. */
function sessionEventBodies(rows: SessionEventRow[], translationCode: string) {
  return rows
    .map((row) => sessionEventBody(row, translationCode))
    .filter((body) => body !== null)
}

/**
 * Today's ordered exercise queue, or with `?practice=true` a short drill of
 * the slotted verses.
 *
 * The daily queue is stable for the day and each exercise carries `completed`,
 * so a client that quit part-way through resumes rather than restarting. The
 * practice drill is separate work: it never counts toward finishing the day,
 * and it is meant to be called repeatedly.
 *
 * `events` and `correctCount` cover the whole day, not the part of it the
 * caller was present for, which is what lets a resumed session recap everything
 * it moved. A drill gets neither: its recap is its own, and the day's events
 * are not its to report.
 */
sessionRouter.get('/session/today', resolveTranslation, (req, res) => {
  const id = userId(req)
  const translationCode = translation(req)
  const practice = practiceRequested(req)

  const exercises = practice
    ? buildPracticeSession(id, translationCode)
    : buildTodaySession(id, timezoneFor(id), translationCode)

  const events = practice
    ? []
    : sessionEventBodies(
        sessionEvents.forDay(id, todayInTimezone(timezoneFor(id))),
        translationCode,
      )

  res.json({
    translation: translationCode,
    practice,
    exercises,
    count: exercises.length,
    completedCount: exercises.filter((exercise) => exercise.completed).length,
    // Trues rather than "not falses": an exercise answered before correctness
    // was recorded is null, and guessing at it would inflate the tally.
    correctCount: exercises.filter((exercise) => exercise.correct === true)
      .length,
    events,
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
 *
 * `events` is what *this* attempt moved, not the day's — a client stepping
 * through a session appends them as it goes, and picks up everything earlier
 * from GET /api/session/today when it resumes.
 */
sessionRouter.post('/attempt', resolveTranslation, (req, res) => {
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
    events: sessionEventBodies(outcome.events, translation(req)),
  })
})

/**
 * Marks the daily session complete and tops up any empty slots.
 * Idempotent per calendar day in the user's timezone.
 */
sessionRouter.post('/session/complete', resolveTranslation, (req, res) => {
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

  const now = new Date().toISOString()
  const events = slotsFilled.map((row) =>
    sessionEvents.record(id, today, now, slotEvent(row)),
  )

  // Nothing reads a past day's plan or a past day's events; this is the one
  // routine call that can clear them out.
  pruneBefore(id, today)
  sessionEvents.pruneBefore(id, today)

  const { sessionsCompleted } = db
    .prepare(
      'SELECT COUNT(*) AS sessionsCompleted FROM session_log WHERE user_id = ?',
    )
    .get(id) as { sessionsCompleted: number }

  res.json({
    recorded: !alreadyLogged,
    sessionsCompleted,
    slotsFilled: slotsFilled.map(legacyUserVerseBody),
    // Like /attempt, only what this call moved — the slots it just topped up.
    events: sessionEventBodies(events, translation(req)),
  })
})
