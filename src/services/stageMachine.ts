import { randomUUID } from 'node:crypto'
import { db, type ExerciseType, type SessionEventRow } from '../db/client'
import * as sessionEvents from '../db/sessionEventRepository'
import * as userVerses from '../db/userVerseRepository'
import { advance } from '../domain/progression'
import { attemptEvent, slotEvent } from '../domain/sessionEvent'
import { progressOf, type UserVerse } from '../domain/userVerse'
import { todayInTimezone } from '../lib/dates'
import { refillSlots } from './slotRefill'
import { bumpRelearningToFront } from './queue'
import { completeNextForVerse, ensureTodayPlan } from './sessionPlan'

export interface AttemptOutcome {
  userVerse: UserVerse
  /** True when this attempt graduated the verse out of learning_heavy. */
  graduated: boolean
  /** Verses slotted by the refill this attempt triggered — new or relearning. */
  slotsFilled: UserVerse[]
  /**
   * What this attempt moved, recorded against the day. Just this attempt's
   * events, not the day's — GET /api/session/today serves the whole day, and
   * a client that has been running since the session started already holds
   * everything before this.
   */
  events: SessionEventRow[]
}

/**
 * Records one exercise attempt and applies its consequences.
 *
 * The rules themselves live in domain/progression.ts, which is pure; this is
 * the part that touches the world — logging the attempt, saving the result, and
 * running the follow-up work the transition asks for. Wrapped in a transaction
 * so a tier change and the slot refill it triggers can't half-apply.
 */
export const recordAttempt = db.transaction(
  (
    userVerse: UserVerse,
    exerciseType: ExerciseType,
    correct: boolean,
    timezone: string,
  ): AttemptOutcome => {
    const now = new Date().toISOString()
    const today = todayInTimezone(timezone)
    // The stage as it stands before any of this runs, which is the only honest
    // "from" for the event below.
    const from = userVerse.stage

    db.prepare(
      `INSERT INTO attempt (id, user_verse_id, exercise_type, correct, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(randomUUID(), userVerse.id, exerciseType, correct ? 1 : 0, now)

    // Before the progress is saved, so the plan is built from the state that
    // made this exercise due: a graduating verse would otherwise be dropped
    // from the day's plan by the very attempt that graduated it. Doing this
    // here rather than only in the session route means a client that answers
    // without fetching the session first still ticks items off.
    ensureTodayPlan(userVerse.userId, today)

    const transition = advance(progressOf(userVerse), correct, today, now)
    userVerses.saveProgress(userVerse.id, transition.next)

    // A no-op once the verse has nothing outstanding today — which is exactly
    // what extra practice after the session should be.
    completeNextForVerse(userVerse.userId, today, userVerse.id, now, correct)

    if (transition.bumpRelearning) {
      bumpRelearningToFront(userVerse.userId, userVerse.verseId)
    }

    // A graduation empties a slot; a demotion adds a claimant for one. Either
    // way the queue may now be able to move.
    const slotsFilled = transition.needsRefill
      ? refillSlots(userVerse.userId)
      : []

    // Read back after the refill, so a verse demoted out of review and re-seated
    // in the same transaction is classified by where it landed rather than by
    // the flag it wore in between.
    const after = userVerses.findById(userVerse.id)!

    const events: SessionEventRow[] = []

    const moved = attemptEvent(from, after, transition)
    if (moved) {
      events.push(sessionEvents.record(userVerse.userId, today, now, moved))
    }

    // A demotion that found a free slot appears both here and in slotsFilled;
    // the event above already reported it, so it is skipped rather than told
    // twice.
    for (const row of slotsFilled) {
      if (row.id === userVerse.id) continue
      events.push(
        sessionEvents.record(userVerse.userId, today, now, slotEvent(row)),
      )
    }

    return {
      userVerse: after,
      graduated: transition.graduated,
      slotsFilled,
      events,
    }
  },
)
