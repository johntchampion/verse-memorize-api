import { randomUUID } from 'node:crypto'
import { db, type ExerciseType, type UserVerseRow } from '../db/client'
import {
  isLearningStage,
  nextLearningStage,
  previousLearningStage,
  type Stage,
} from '../domain/stage'
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
  userVerse: UserVerseRow
  /** True when this attempt graduated the verse out of learning_heavy. */
  graduated: boolean
  /** Rows slotted by the refill this attempt triggered — new or relearning. */
  slotsFilled: UserVerseRow[]
}

/** The subset of a user_verse row this machine rewrites. */
type State = Pick<
  UserVerseRow,
  | 'stage'
  | 'consecutive_correct'
  | 'consecutive_incorrect'
  | 'streak_date'
  | 'interval_days'
  | 'due_at'
  | 'last_upgrade_date'
  | 'last_downgrade_date'
  | 'needs_relearning'
  | 'relearning_queued_at'
  | 'slot'
  | 'graduated_at'
>

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
    userVerse: UserVerseRow,
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

    const s: State = {
      stage: userVerse.stage,
      consecutive_correct: userVerse.consecutive_correct,
      consecutive_incorrect: userVerse.consecutive_incorrect,
      streak_date: userVerse.streak_date,
      interval_days: userVerse.interval_days,
      due_at: userVerse.due_at,
      last_upgrade_date: userVerse.last_upgrade_date,
      last_downgrade_date: userVerse.last_downgrade_date,
      needs_relearning: userVerse.needs_relearning,
      relearning_queued_at: userVerse.relearning_queued_at,
      slot: userVerse.slot,
      graduated_at: userVerse.graduated_at,
    }

    let graduated = false
    let refill = false

    if (isLearningStage(s.stage)) {
      // One tier change per verse per day, and never one of each: an upgrade
      // today rules out a downgrade today, and vice versa.
      const tierChangedToday =
        s.last_upgrade_date === today || s.last_downgrade_date === today

      if (correct) {
        // The three-in-a-row has to land inside one calendar day, so a run
        // carried over from yesterday starts again at one.
        const carried = s.streak_date === today ? s.consecutive_correct : 0
        s.consecutive_correct = carried + 1
        s.consecutive_incorrect = 0
        s.streak_date = today

        if (s.consecutive_correct >= TIER_ADVANCE_THRESHOLD) {
          // Whether or not the upgrade lands, the run is spent. A blocked
          // upgrade leaves the extra correct answers as plain practice.
          s.consecutive_correct = 0
          s.streak_date = null

          if (!tierChangedToday) {
            const promoted = nextLearningStage(s.stage)
            s.last_upgrade_date = today

            if (promoted) {
              s.stage = promoted
            } else {
              // Top of the ladder, so the upgrade graduates instead: empty the
              // slot, stamp the graduation timestamp, and open at the bottom of
              // the interval ladder.
              s.stage = 'review'
              s.slot = null
              s.graduated_at = now
              s.interval_days = 1
              s.due_at = addDays(today, 1)
              graduated = true
              refill = true
            }
          }
        }
      } else {
        // Unlike the correct-streak, this one is allowed to span days.
        s.consecutive_incorrect += 1
        s.consecutive_correct = 0
        s.streak_date = null

        if (s.consecutive_incorrect >= TIER_DOWNGRADE_THRESHOLD) {
          // Spent either way: after a blocked downgrade a fresh pair of misses
          // is needed to trigger one again.
          s.consecutive_incorrect = 0

          // Null at learning_light, the floor — two misses there change nothing.
          const demoted = previousLearningStage(s.stage)
          if (demoted && !tierChangedToday) {
            s.stage = demoted
            s.last_downgrade_date = today
          }
        }
      }
    } else if (s.stage === 'mastered') {
      if (correct) {
        // Mastered is the ceiling; it just keeps coming back on the long
        // interval so it doesn't go stale.
        s.consecutive_correct = 0
        s.consecutive_incorrect = 0
        s.interval_days = MAX_INTERVAL_DAYS
        s.due_at = addDays(today, MAX_INTERVAL_DAYS)
      } else {
        s.stage = 'review'
        s.interval_days = 1
        s.due_at = addDays(today, 1)
        s.consecutive_correct = 0
        // The miss that cost mastery is also the first strike toward review's
        // two-miss demotion — one more now sends it back to a learning slot.
        s.consecutive_incorrect = 1
      }
    } else {
      const interval = s.interval_days ?? 1

      if (correct) {
        s.consecutive_incorrect = 0
        s.consecutive_correct += 1

        if (s.consecutive_correct >= REVIEW_ADVANCE_THRESHOLD) {
          s.consecutive_correct = 0

          if (interval >= MAX_INTERVAL_DAYS) {
            // Nowhere left to extend the interval to, so the bump becomes
            // mastery instead.
            s.stage = 'mastered'
            s.interval_days = MAX_INTERVAL_DAYS
          } else {
            s.interval_days = nextInterval(interval)
          }
        } else {
          s.interval_days = interval
        }

        s.due_at = addDays(today, s.interval_days ?? 1)
      } else {
        s.consecutive_correct = 0
        s.consecutive_incorrect += 1

        if (s.consecutive_incorrect >= REVIEW_DEMOTION_THRESHOLD) {
          // Out of review entirely: it waits here, unscheduled, until a
          // learning slot opens and slotRefill re-seats it at learning_heavy.
          s.consecutive_incorrect = 0
          s.needs_relearning = 1
          s.relearning_queued_at = now
          s.interval_days = null
          s.due_at = null
          refill = true
          bumpRelearningToFront(userVerse.user_id, userVerse.verse_id)
        } else {
          s.interval_days = 1
          s.due_at = addDays(today, 1)
        }
      }
    }

    db.prepare(
      `UPDATE user_verse
          SET stage = ?,
              consecutive_correct = ?,
              consecutive_incorrect = ?,
              streak_date = ?,
              interval_days = ?,
              due_at = ?,
              last_upgrade_date = ?,
              last_downgrade_date = ?,
              needs_relearning = ?,
              relearning_queued_at = ?,
              slot = ?,
              graduated_at = ?
        WHERE id = ?`,
    ).run(
      s.stage,
      s.consecutive_correct,
      s.consecutive_incorrect,
      s.streak_date,
      s.interval_days,
      s.due_at,
      s.last_upgrade_date,
      s.last_downgrade_date,
      s.needs_relearning,
      s.relearning_queued_at,
      s.slot,
      s.graduated_at,
      userVerse.id,
    )

    // A graduation empties a slot; a demotion adds a claimant for one. Either
    // way the queue may now be able to move.
    const slotsFilled = refill ? refillSlots(userVerse.user_id) : []

    return {
      userVerse: db
        .prepare('SELECT * FROM user_verse WHERE id = ?')
        .get(userVerse.id) as UserVerseRow,
      graduated,
      slotsFilled,
    }
  },
)
