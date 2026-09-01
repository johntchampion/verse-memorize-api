import { randomUUID } from 'node:crypto'
import { db, type ExerciseType } from '../db/client'
import * as userVerses from '../db/userVerseRepository'
import {
  isLearningStage,
  nextLearningStage,
  previousLearningStage,
} from '../domain/stage'
import {
  progressOf,
  type UserVerse,
  type VerseProgress,
} from '../domain/userVerse'
import { addDays, todayInTimezone } from '../lib/dates'
import { refillSlots } from './slotRefill'
import { bumpRelearningToFront } from './queue'

// ---------------------------------------------------------------------------
// Tuning constants. Change these here, not at the call sites.
// ---------------------------------------------------------------------------

/** Consecutive correct completions needed to advance a learning tier. */
export const TIER_ADVANCE_THRESHOLD = 3

/** Consecutive misses that drop a verse back a learning tier. */
export const TIER_DOWNGRADE_THRESHOLD = 2

/** Consecutive correct reviews needed to step the interval up a rung. */
export const REVIEW_ADVANCE_THRESHOLD = 3

/** Consecutive missed reviews that pull a verse back into a learning slot. */
export const REVIEW_DEMOTION_THRESHOLD = 2

/** Review interval ladder, in days. */
export const INTERVAL_PROGRESSION = [1, 3, 7, 14, 30] as const
export const MAX_INTERVAL_DAYS =
  INTERVAL_PROGRESSION[INTERVAL_PROGRESSION.length - 1]

/** The next rung up the interval ladder, capped at the top. */
function nextInterval(current: number): number {
  const next = INTERVAL_PROGRESSION.find((days) => days > current)
  return next ?? MAX_INTERVAL_DAYS
}

export interface AttemptOutcome {
  userVerse: UserVerse
  /** True when this attempt graduated the verse out of learning_heavy. */
  graduated: boolean
  /** Verses slotted by the refill this attempt triggered — new or relearning. */
  slotsFilled: UserVerse[]
}

/**
 * Records one exercise attempt and advances the verse.
 *
 * Learning tiers move on streaks of consecutive answers, at most one tier
 * change per verse per day in either direction. Review and mastered move along
 * the interval ladder and, on repeated misses, back into a learning slot. Runs
 * as a single transaction so a tier change and the slot refill it triggers
 * can't half-apply.
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

    const state: VerseProgress = progressOf(userVerse)

    let graduated = false
    let refill = false

    if (isLearningStage(state.stage)) {
      // One tier change per verse per day, and never one of each: an upgrade
      // today rules out a downgrade today, and vice versa.
      const tierChangedToday =
        state.lastUpgradeDate === today || state.lastDowngradeDate === today

      if (correct) {
        // The three-in-a-row has to land inside one calendar day, so a run
        // carried over from yesterday starts again at one.
        const carried =
          state.streakDate === today ? state.consecutiveCorrect : 0
        state.consecutiveCorrect = carried + 1
        state.consecutiveIncorrect = 0
        state.streakDate = today

        if (state.consecutiveCorrect >= TIER_ADVANCE_THRESHOLD) {
          // Whether or not the upgrade lands, the run is spent. A blocked
          // upgrade leaves the extra correct answers as plain practice.
          state.consecutiveCorrect = 0
          state.streakDate = null

          if (!tierChangedToday) {
            const promoted = nextLearningStage(state.stage)
            state.lastUpgradeDate = today

            if (promoted) {
              state.stage = promoted
            } else {
              // Top of the ladder, so the upgrade graduates instead: empty the
              // slot, stamp the graduation timestamp, and open at the bottom of
              // the interval ladder.
              state.stage = 'review'
              state.slot = null
              state.graduatedAt = now
              state.intervalDays = 1
              state.dueAt = addDays(today, 1)
              graduated = true
              refill = true
            }
          }
        }
      } else {
        // Unlike the correct-streak, this one is allowed to span days.
        state.consecutiveIncorrect += 1
        state.consecutiveCorrect = 0
        state.streakDate = null

        if (state.consecutiveIncorrect >= TIER_DOWNGRADE_THRESHOLD) {
          // Spent either way: after a blocked downgrade a fresh pair of misses
          // is needed to trigger one again.
          state.consecutiveIncorrect = 0

          // Null at learning_light, the floor — two misses there change nothing.
          const demoted = previousLearningStage(state.stage)
          if (demoted && !tierChangedToday) {
            state.stage = demoted
            state.lastDowngradeDate = today
          }
        }
      }
    } else if (state.stage === 'mastered') {
      if (correct) {
        // Mastered is the ceiling; it just keeps coming back on the long
        // interval so it doesn't go stale.
        state.consecutiveCorrect = 0
        state.consecutiveIncorrect = 0
        state.intervalDays = MAX_INTERVAL_DAYS
        state.dueAt = addDays(today, MAX_INTERVAL_DAYS)
      } else {
        state.stage = 'review'
        state.intervalDays = 1
        state.dueAt = addDays(today, 1)
        state.consecutiveCorrect = 0
        // The miss that cost mastery is also the first strike toward review's
        // two-miss demotion — one more now sends it back to a learning slot.
        state.consecutiveIncorrect = 1
      }
    } else {
      const interval = state.intervalDays ?? 1

      if (correct) {
        state.consecutiveIncorrect = 0
        state.consecutiveCorrect += 1

        if (state.consecutiveCorrect >= REVIEW_ADVANCE_THRESHOLD) {
          state.consecutiveCorrect = 0

          if (interval >= MAX_INTERVAL_DAYS) {
            // Nowhere left to extend the interval to, so the bump becomes
            // mastery instead.
            state.stage = 'mastered'
            state.intervalDays = MAX_INTERVAL_DAYS
          } else {
            state.intervalDays = nextInterval(interval)
          }
        } else {
          state.intervalDays = interval
        }

        state.dueAt = addDays(today, state.intervalDays ?? 1)
      } else {
        state.consecutiveCorrect = 0
        state.consecutiveIncorrect += 1

        if (state.consecutiveIncorrect >= REVIEW_DEMOTION_THRESHOLD) {
          // Out of review entirely: it waits here, unscheduled, until a
          // learning slot opens and slotRefill re-seats it at learning_heavy.
          state.consecutiveIncorrect = 0
          state.needsRelearning = true
          state.relearningQueuedAt = now
          state.intervalDays = null
          state.dueAt = null
          refill = true
          bumpRelearningToFront(userVerse.userId, userVerse.verseId)
        } else {
          state.intervalDays = 1
          state.dueAt = addDays(today, 1)
        }
      }
    }

    userVerses.saveProgress(userVerse.id, state)

    // A graduation empties a slot; a demotion adds a claimant for one. Either
    // way the queue may now be able to move.
    const slotsFilled = refill ? refillSlots(userVerse.userId) : []

    return {
      userVerse: userVerses.findById(userVerse.id)!,
      graduated,
      slotsFilled,
    }
  },
)
