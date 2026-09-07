import { Router, type Request } from 'express'
import { z } from 'zod'
import * as sessionEvents from '../repositories/sessionEventRepository'
import * as sessionLogs from '../repositories/sessionLogRepository'
import * as userVerses from '../repositories/userVerseRepository'
import { getVerse } from '../data/verses'
import { slotEvent } from '../domain/sessionEvent'
import { SessionEvent } from '../models/SessionEvent'
import { todayInTimezone } from '../lib/dates'
import { NotFoundError } from '../lib/errors'
import { validate, validated } from '../lib/http'
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
function timezoneFor(req: Request): string {
  return req.user?.timezone ?? 'UTC'
}

/** Accepts `true` or `1`; anything else, including absent, is false. */
function practiceRequested(req: Request): boolean {
  const flag = req.query.practice
  return flag === 'true' || flag === '1'
}

/**
 * Today's ordered exercise queue, or with `?practice=true` a short drill of
 * the slotted verses.
 *
 * The daily queue is fixed for the day — which exercises, in what order, at
 * what difficulty, all decided when the day is first opened and unchanged by
 * anything that happens after, including a slot swap or a graduation. Note that
 * this means an exercise's `stage` can differ from its `userVerse.stage` later
 * in the day: the first is what it was planned at, the second is where the
 * verse stands now. Each exercise carries `completed`, so a client that quit
 * part-way through resumes rather than restarting. The practice drill is
 * separate work: it tracks the slots as they stand right now, it never counts
 * toward finishing the day, and it is meant to be called repeatedly.
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
    : buildTodaySession(id, timezoneFor(req), translationCode)

  const events = practice
    ? []
    : SessionEvent.bodies(
        sessionEvents.forDay(id, todayInTimezone(timezoneFor(req))),
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
sessionRouter.post(
  '/attempt',
  resolveTranslation,
  validate(attemptBody),
  (req, res) => {
    const id = userId(req)
    const body = validated(req, attemptBody)

    const userVerse = userVerses.findByIdForUser(body.userVerseId, id)
    if (!userVerse) throw new NotFoundError('user_verse not found')

    const outcome = recordAttempt(
      userVerse,
      body.exerciseType,
      body.correct,
      timezoneFor(req),
    )

    res.json({
      userVerse: outcome.userVerse.toLegacyBody(),
      graduated: outcome.graduated,
      slotsFilled: outcome.slotsFilled.map((verse) => verse.toLegacyBody()),
      events: SessionEvent.bodies(outcome.events, translation(req)),
    })
  },
)

/**
 * Marks the daily session complete and tops up any empty slots.
 * Idempotent per calendar day in the user's timezone.
 */
sessionRouter.post('/session/complete', resolveTranslation, (req, res) => {
  const id = userId(req)
  const timezone = timezoneFor(req)
  const today = todayInTimezone(timezone)

  // completed_at is a UTC instant, so "already logged today" is decided by
  // rendering recent rows back into the user's local date.
  const alreadyLogged = sessionLogs
    .recentForUser(id)
    .some(
      (row) => todayInTimezone(timezone, new Date(row.completed_at)) === today,
    )

  if (!alreadyLogged) sessionLogs.insert(id, new Date().toISOString())

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

  const sessionsCompleted = sessionLogs.countForUser(id)

  res.json({
    recorded: !alreadyLogged,
    sessionsCompleted,
    slotsFilled: slotsFilled.map((verse) => verse.toLegacyBody()),
    // Like /attempt, only what this call moved — the slots it just topped up.
    events: SessionEvent.bodies(events, translation(req)),
  })
})
