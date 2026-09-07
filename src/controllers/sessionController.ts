import type { Request } from 'express'
import { slotEvent } from '../domain/sessionEvent'
import { todayInTimezone } from '../lib/dates'
import { NotFoundError } from '../lib/errors'
import { userId } from '../middleware/auth'
import { translation } from '../middleware/translation'
import { DailySession } from '../models/DailySession'
import { PracticeDrill } from '../models/PracticeDrill'
import { SessionEvent } from '../models/SessionEvent'
import { Slots } from '../models/Slots'
import * as sessionEvents from '../repositories/sessionEventRepository'
import * as sessionLogs from '../repositories/sessionLogRepository'
import * as userVerses from '../repositories/userVerseRepository'
import { recordAttempt } from '../services/attemptRecorder'
import { sessionView } from '../views/sessionView'
import type { AttemptInput } from '../schemas'

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
 * Today's ordered exercise queue, or with `?practice=true` a short drill of the
 * slotted verses.
 *
 * `events` and `correctCount` cover the whole day, not the part of it the
 * caller was present for, which is what lets a resumed session recap everything
 * it moved. A drill gets neither: its recap is its own.
 */
export function today(req: Request) {
  const id = userId(req)
  const translationCode = translation(req)
  const practice = practiceRequested(req)
  const date = todayInTimezone(timezoneFor(req))

  if (practice) {
    return sessionView({
      translation: translationCode,
      practice,
      exercises: new PracticeDrill(id).exercises(translationCode),
      events: [],
    })
  }

  return sessionView({
    translation: translationCode,
    practice,
    exercises: new DailySession(id, date).exercises(translationCode),
    events: SessionEvent.bodies(
      sessionEvents.forDay(id, date),
      translationCode,
    ),
  })
}

/**
 * `events` is what *this* attempt moved, not the day's — a client stepping
 * through a session appends as it goes and picks the rest up on resume.
 */
export function attempt(req: Request, body: AttemptInput) {
  const id = userId(req)

  const userVerse = userVerses.findByIdForUser(body.userVerseId, id)
  if (!userVerse) throw new NotFoundError('user_verse not found')

  const outcome = recordAttempt(
    userVerse,
    body.exerciseType,
    body.correct,
    timezoneFor(req),
  )

  return {
    userVerse: outcome.userVerse.toLegacyBody(),
    graduated: outcome.graduated,
    slotsFilled: outcome.slotsFilled.map((verse) => verse.toLegacyBody()),
    events: SessionEvent.bodies(outcome.events, translation(req)),
  }
}

/** Idempotent per calendar day in the user's timezone. */
export function complete(req: Request) {
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
  const slotsFilled = new Slots(id).refill()

  const now = new Date().toISOString()
  const events = slotsFilled.map((verse) =>
    sessionEvents.record(id, today, now, slotEvent(verse)),
  )

  // Nothing reads a past day's plan or events; this is the one routine call
  // that can clear them out.
  new DailySession(id, today).prunePastDays()
  sessionEvents.pruneBefore(id, today)

  return {
    recorded: !alreadyLogged,
    sessionsCompleted: sessionLogs.countForUser(id),
    slotsFilled: slotsFilled.map((verse) => verse.toLegacyBody()),
    // Like /attempt, only what this call moved — the slots it just topped up.
    events: SessionEvent.bodies(events, translation(req)),
  }
}
