import { db } from '../db/client'
import type { ExerciseType, SessionEventRow } from '../db/rows'
import { advance, type Transition } from '../domain/progression'
import { attemptEvent, slotEvent } from '../domain/sessionEvent'
import type { Stage } from '../domain/stage'
import { DailySession } from '../models/DailySession'
import { PracticeQueue } from '../models/PracticeQueue'
import { Slots } from '../models/Slots'
import type { UserVerse } from '../models/UserVerse'
import { todayInTimezone } from '../lib/dates'
import * as attempts from '../repositories/attemptRepository'
import * as sessionEvents from '../repositories/sessionEventRepository'
import * as userVerses from '../repositories/userVerseRepository'

export interface AttemptOutcome {
  userVerse: UserVerse
  graduated: boolean
  /** Verses slotted by the refill this attempt triggered — new or relearning. */
  slotsFilled: UserVerse[]
  /**
   * Just this attempt's events, not the day's: a client stepping through a
   * session appends as it goes and picks the rest up on resume.
   */
  events: SessionEventRow[]
}

interface Context {
  verse: UserVerse
  today: string
  now: string
}

/**
 * Records one exercise attempt and applies its consequences.
 *
 * The rules live in domain/progression.ts, which is pure; this is the part that
 * touches the world. Wrapped in a transaction so a tier change and the slot
 * refill it triggers cannot half-apply.
 */
export const recordAttempt = db.transaction(
  (
    verse: UserVerse,
    exerciseType: ExerciseType,
    correct: boolean,
    timezone: string,
  ): AttemptOutcome => {
    const context: Context = {
      verse,
      today: todayInTimezone(timezone),
      now: new Date().toISOString(),
    }
    // The stage before any of this runs, which is the only honest "from".
    const from = verse.stage

    attempts.record(verse.id, exerciseType, correct, context.now)

    const transition = applyProgression(context, correct)
    const slotsFilled = runFollowUp(context, transition)

    // Read back after the refill, so a verse demoted out of review and
    // re-seated in the same transaction is classified by where it landed
    // rather than by the flag it wore in between.
    const after = userVerses.findById(verse.id)!

    return {
      userVerse: after,
      graduated: transition.graduated,
      slotsFilled,
      events: recordEvents(context, from, after, transition, slotsFilled),
    }
  },
)

function applyProgression(context: Context, correct: boolean): Transition {
  const { verse, today, now } = context

  // Before the progress is saved, so the plan is built from the state that made
  // this exercise due: a graduating verse would otherwise be dropped from the
  // day's plan by the very attempt that graduated it. Here rather than only in
  // the session route, so a client that answers without fetching the session
  // first still ticks items off.
  const session = new DailySession(verse.userId, today)
  session.ensurePlan()

  const transition = advance(verse.progress, correct, today, now)
  userVerses.saveProgress(verse.id, transition.next)

  // A no-op once the verse has nothing outstanding today — which is exactly
  // what extra practice after the session should be.
  session.completeNextForVerse(verse.id, now, correct)

  return transition
}

/** A graduation empties a slot; a demotion adds a claimant for one. */
function runFollowUp(context: Context, transition: Transition): UserVerse[] {
  const { verse } = context

  if (transition.bumpRelearning) {
    new PracticeQueue(verse.userId).bumpRelearningToFront(verse.verseId)
  }

  return transition.needsRefill ? new Slots(verse.userId).refill() : []
}

function recordEvents(
  context: Context,
  from: Stage,
  after: UserVerse,
  transition: Transition,
  slotsFilled: UserVerse[],
): SessionEventRow[] {
  const { verse, today, now } = context
  const events: SessionEventRow[] = []

  const moved = attemptEvent(from, after, transition)
  if (moved) events.push(sessionEvents.record(verse.userId, today, now, moved))

  // A demotion that found a free slot appears both here and in slotsFilled;
  // the event above already reported it, so it is skipped rather than told
  // twice.
  for (const filled of slotsFilled) {
    if (filled.id === verse.id) continue
    events.push(
      sessionEvents.record(verse.userId, today, now, slotEvent(filled)),
    )
  }

  return events
}
