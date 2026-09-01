/**
 * How one answered exercise moves a verse.
 *
 * Everything here is pure: given a verse's current progress and an answer, it
 * returns the progress that should replace it. No database, no clock, no
 * refill. `today` and `now` are passed in precisely so these rules can be
 * exercised on any date without waiting for one — see tests/progression.test.ts.
 *
 * Three regimes, one per stage family:
 *   - learning tiers advance on same-day answer streaks, capped at one tier
 *     change per verse per day, and graduate off the top;
 *   - review walks an interval ladder and, on repeated misses, drops out of
 *     scheduling entirely to wait for a learning slot;
 *   - mastered is the ceiling, and a single miss costs it.
 *
 * Side effects the caller must perform are reported in the Transition rather
 * than done here, which is what keeps these functions testable in isolation.
 */
import { addDays } from '../lib/dates'
import {
  isLearningStage,
  nextLearningStage,
  previousLearningStage,
} from './stage'
import type { VerseProgress } from './userVerse'

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
  return (
    INTERVAL_PROGRESSION.find((days) => days > current) ?? MAX_INTERVAL_DAYS
  )
}

/**
 * The result of one attempt: the progress to save, plus the follow-up work the
 * caller owns because it reaches outside this module.
 */
export interface Transition {
  next: VerseProgress
  /** This attempt graduated the verse out of learning_heavy. */
  graduated: boolean
  /** A slot opened or a claimant appeared, so refill should run. */
  needsRefill: boolean
  /** The verse just dropped into relearning and wants the front of the queue. */
  bumpRelearning: boolean
}

/**
 * One tier change per verse per day, and never one of each: an upgrade today
 * rules out a downgrade today, and vice versa.
 */
function tierChangeSpentToday(progress: VerseProgress, today: string): boolean {
  return (
    progress.lastUpgradeDate === today || progress.lastDowngradeDate === today
  )
}

function advanceLearning(
  progress: VerseProgress,
  correct: boolean,
  today: string,
  now: string,
): Transition {
  const next = { ...progress }
  const spent = tierChangeSpentToday(progress, today)

  if (!correct) {
    // Unlike the correct-streak, this one is allowed to span days.
    next.consecutiveIncorrect += 1
    next.consecutiveCorrect = 0
    next.streakDate = null

    if (next.consecutiveIncorrect >= TIER_DOWNGRADE_THRESHOLD) {
      // Spent either way: after a blocked downgrade a fresh pair of misses is
      // needed to trigger one again.
      next.consecutiveIncorrect = 0

      // Null at learning_light, the floor — two misses there change nothing.
      const demoted = previousLearningStage(progress.stage)
      if (demoted && !spent) {
        next.stage = demoted
        next.lastDowngradeDate = today
      }
    }
    return { next, graduated: false, needsRefill: false, bumpRelearning: false }
  }

  // The three-in-a-row has to land inside one calendar day, so a run carried
  // over from yesterday starts again at one.
  const carried =
    progress.streakDate === today ? progress.consecutiveCorrect : 0
  next.consecutiveCorrect = carried + 1
  next.consecutiveIncorrect = 0
  next.streakDate = today

  if (next.consecutiveCorrect < TIER_ADVANCE_THRESHOLD) {
    return { next, graduated: false, needsRefill: false, bumpRelearning: false }
  }

  // Whether or not the upgrade lands, the run is spent. A blocked upgrade
  // leaves the extra correct answers as plain practice.
  next.consecutiveCorrect = 0
  next.streakDate = null

  if (spent) {
    return { next, graduated: false, needsRefill: false, bumpRelearning: false }
  }

  next.lastUpgradeDate = today
  const promoted = nextLearningStage(progress.stage)

  if (promoted) {
    next.stage = promoted
    return { next, graduated: false, needsRefill: false, bumpRelearning: false }
  }

  // Top of the ladder, so the upgrade graduates instead: empty the slot, stamp
  // the graduation timestamp, and open at the bottom of the interval ladder.
  next.stage = 'review'
  next.slot = null
  next.graduatedAt = now
  next.intervalDays = 1
  next.dueAt = addDays(today, 1)
  return { next, graduated: true, needsRefill: true, bumpRelearning: false }
}

function advanceMastered(
  progress: VerseProgress,
  correct: boolean,
  today: string,
): Transition {
  const next = { ...progress }

  if (correct) {
    // Mastered is the ceiling; it just keeps coming back on the long interval
    // so it doesn't go stale.
    next.consecutiveCorrect = 0
    next.consecutiveIncorrect = 0
    next.intervalDays = MAX_INTERVAL_DAYS
    next.dueAt = addDays(today, MAX_INTERVAL_DAYS)
  } else {
    next.stage = 'review'
    next.intervalDays = 1
    next.dueAt = addDays(today, 1)
    next.consecutiveCorrect = 0
    // The miss that cost mastery is also the first strike toward review's
    // two-miss demotion — one more now sends it back to a learning slot.
    next.consecutiveIncorrect = 1
  }

  return { next, graduated: false, needsRefill: false, bumpRelearning: false }
}

function advanceReview(
  progress: VerseProgress,
  correct: boolean,
  today: string,
  now: string,
): Transition {
  const next = { ...progress }
  const interval = progress.intervalDays ?? 1

  if (correct) {
    next.consecutiveIncorrect = 0
    next.consecutiveCorrect += 1

    if (next.consecutiveCorrect >= REVIEW_ADVANCE_THRESHOLD) {
      next.consecutiveCorrect = 0

      if (interval >= MAX_INTERVAL_DAYS) {
        // Nowhere left to extend the interval to, so the bump becomes mastery
        // instead.
        next.stage = 'mastered'
        next.intervalDays = MAX_INTERVAL_DAYS
      } else {
        next.intervalDays = nextInterval(interval)
      }
    } else {
      next.intervalDays = interval
    }

    next.dueAt = addDays(today, next.intervalDays ?? 1)
    return { next, graduated: false, needsRefill: false, bumpRelearning: false }
  }

  next.consecutiveCorrect = 0
  next.consecutiveIncorrect += 1

  if (next.consecutiveIncorrect < REVIEW_DEMOTION_THRESHOLD) {
    next.intervalDays = 1
    next.dueAt = addDays(today, 1)
    return { next, graduated: false, needsRefill: false, bumpRelearning: false }
  }

  // Out of review entirely: it waits here, unscheduled, until a learning slot
  // opens and slotRefill re-seats it at learning_heavy.
  next.consecutiveIncorrect = 0
  next.needsRelearning = true
  next.relearningQueuedAt = now
  next.intervalDays = null
  next.dueAt = null
  return { next, graduated: false, needsRefill: true, bumpRelearning: true }
}

/** Dispatches to the regime the verse is currently in. */
export function advance(
  progress: VerseProgress,
  correct: boolean,
  today: string,
  now: string,
): Transition {
  if (isLearningStage(progress.stage)) {
    return advanceLearning(progress, correct, today, now)
  }
  if (progress.stage === 'mastered') {
    return advanceMastered(progress, correct, today)
  }
  return advanceReview(progress, correct, today, now)
}

export { advanceLearning, advanceMastered, advanceReview }
