import { randomUUID } from 'node:crypto'
import { db, type ExerciseType } from '../db/client'
import * as userVerses from '../db/userVerseRepository'
import { advance } from '../domain/progression'
import { progressOf, type UserVerse } from '../domain/userVerse'
import { todayInTimezone } from '../lib/dates'
import { refillSlots } from './slotRefill'
import { bumpRelearningToFront } from './queue'

export interface AttemptOutcome {
  userVerse: UserVerse
  /** True when this attempt graduated the verse out of learning_heavy. */
  graduated: boolean
  /** Verses slotted by the refill this attempt triggered — new or relearning. */
  slotsFilled: UserVerse[]
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

    db.prepare(
      `INSERT INTO attempt (id, user_verse_id, exercise_type, correct, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(randomUUID(), userVerse.id, exerciseType, correct ? 1 : 0, now)

    const transition = advance(progressOf(userVerse), correct, today, now)
    userVerses.saveProgress(userVerse.id, transition.next)

    if (transition.bumpRelearning) {
      bumpRelearningToFront(userVerse.userId, userVerse.verseId)
    }

    // A graduation empties a slot; a demotion adds a claimant for one. Either
    // way the queue may now be able to move.
    const slotsFilled = transition.needsRefill
      ? refillSlots(userVerse.userId)
      : []

    return {
      userVerse: userVerses.findById(userVerse.id)!,
      graduated: transition.graduated,
      slotsFilled,
    }
  },
)
