/**
 * Unit tests for the progression rules.
 *
 * These call the pure functions directly — no HTTP, no database, no fake
 * timers — which is what lets them assert things the integration tests can only
 * approach indirectly: multi-day streak behavior, the interval ladder end to
 * end, and every branch of the tier-change cap.
 */
import { describe, expect, it } from 'vitest'
import {
  INTERVAL_PROGRESSION,
  MAX_INTERVAL_DAYS,
  REVIEW_ADVANCE_THRESHOLD,
  REVIEW_DEMOTION_THRESHOLD,
  TIER_ADVANCE_THRESHOLD,
  TIER_DOWNGRADE_THRESHOLD,
  advance,
} from '../src/domain/progression'
import type { Stage } from '../src/domain/stage'
import type { VerseProgress } from '../src/domain/userVerse'

const TODAY = '2026-03-10'
const YESTERDAY = '2026-03-09'
const NOW = '2026-03-10T12:00:00.000Z'

function progress(overrides: Partial<VerseProgress> = {}): VerseProgress {
  return {
    stage: 'learning_light',
    consecutiveCorrect: 0,
    consecutiveIncorrect: 0,
    streakDate: null,
    intervalDays: null,
    dueAt: null,
    lastUpgradeDate: null,
    lastDowngradeDate: null,
    needsRelearning: false,
    relearningQueuedAt: null,
    slot: 1,
    graduatedAt: null,
    ...overrides,
  }
}

/** Answers `correct` repeatedly, threading each result into the next call. */
function answerRepeatedly(
  start: VerseProgress,
  correct: boolean,
  times: number,
  today = TODAY,
) {
  let current = start
  let last = advance(current, correct, today, NOW)
  for (let i = 1; i < times; i += 1) {
    current = last.next
    last = advance(current, correct, today, NOW)
  }
  return last
}

/**
 * Answers a scheduled verse each time it comes due, walking `today` forward to
 * the next due date between answers.
 *
 * Review progress accrues once per due date, so an interval ladder can only be
 * climbed across days — passing the same `today` three times is what a user
 * drilling one verse three times in an afternoon looks like, and it must not
 * work.
 */
function answerOnSchedule(
  start: VerseProgress,
  correct: boolean,
  times: number,
) {
  let current = start
  let today = current.dueAt ?? TODAY
  let last = advance(current, correct, today, NOW)
  for (let i = 1; i < times; i += 1) {
    current = last.next
    today = current.dueAt ?? today
    last = advance(current, correct, today, NOW)
  }
  return last
}

/** A verse in review, due today, on the given rung of the ladder. */
function dueReview(
  intervalDays: number,
  overrides: Partial<VerseProgress> = {},
) {
  return progress({
    stage: 'review',
    slot: null,
    intervalDays,
    dueAt: TODAY,
    ...overrides,
  })
}

describe('learning tiers', () => {
  it(`advances a tier after ${TIER_ADVANCE_THRESHOLD} correct in one day`, () => {
    const result = answerRepeatedly(
      progress({ stage: 'learning_light' }),
      true,
      TIER_ADVANCE_THRESHOLD,
    )

    expect(result.next.stage).toBe('learning_medium')
    expect(result.next.lastUpgradeDate).toBe(TODAY)
    // The run is spent by the upgrade.
    expect(result.next.consecutiveCorrect).toBe(0)
    expect(result.next.streakDate).toBeNull()
  })

  it('does not carry a correct run across a day boundary', () => {
    // Two correct yesterday, one correct today: the run restarts, so this is
    // the first of today rather than the third overall.
    const carried = progress({
      stage: 'learning_light',
      consecutiveCorrect: TIER_ADVANCE_THRESHOLD - 1,
      streakDate: YESTERDAY,
    })

    const result = advance(carried, true, TODAY, NOW)

    expect(result.next.consecutiveCorrect).toBe(1)
    expect(result.next.stage).toBe('learning_light')
    expect(result.next.streakDate).toBe(TODAY)
  })

  it('caps tier changes at one per day, spending the run either way', () => {
    const alreadyUpgraded = progress({
      stage: 'learning_medium',
      lastUpgradeDate: TODAY,
    })

    const result = answerRepeatedly(
      alreadyUpgraded,
      true,
      TIER_ADVANCE_THRESHOLD,
    )

    expect(result.next.stage).toBe('learning_medium')
    // Spent, not banked — the extra correct answers are plain practice.
    expect(result.next.consecutiveCorrect).toBe(0)
  })

  it('blocks a downgrade on a day that already saw an upgrade', () => {
    const upgradedToday = progress({
      stage: 'learning_medium',
      lastUpgradeDate: TODAY,
    })

    const result = answerRepeatedly(
      upgradedToday,
      false,
      TIER_DOWNGRADE_THRESHOLD,
    )

    expect(result.next.stage).toBe('learning_medium')
    expect(result.next.lastDowngradeDate).toBeNull()
  })

  it(`drops a tier after ${TIER_DOWNGRADE_THRESHOLD} misses`, () => {
    const result = answerRepeatedly(
      progress({ stage: 'learning_heavy' }),
      false,
      TIER_DOWNGRADE_THRESHOLD,
    )

    expect(result.next.stage).toBe('learning_medium')
    expect(result.next.lastDowngradeDate).toBe(TODAY)
  })

  it('lets an incorrect run span days, unlike a correct one', () => {
    const startedYesterday = progress({
      stage: 'learning_heavy',
      consecutiveIncorrect: TIER_DOWNGRADE_THRESHOLD - 1,
    })

    const result = advance(startedYesterday, false, TODAY, NOW)

    expect(result.next.stage).toBe('learning_medium')
  })

  it('treats learning_light as the floor', () => {
    const result = answerRepeatedly(
      progress({ stage: 'learning_light' }),
      false,
      TIER_DOWNGRADE_THRESHOLD,
    )

    expect(result.next.stage).toBe('learning_light')
    expect(result.next.lastDowngradeDate).toBeNull()
  })

  it('graduates off the top of the ladder into review', () => {
    const result = answerRepeatedly(
      progress({ stage: 'learning_heavy', slot: 2 }),
      true,
      TIER_ADVANCE_THRESHOLD,
    )

    expect(result.graduated).toBe(true)
    expect(result.needsRefill).toBe(true)
    expect(result.next.stage).toBe('review')
    // The slot is freed and the interval ladder opens at its bottom rung.
    expect(result.next.slot).toBeNull()
    expect(result.next.graduatedAt).toBe(NOW)
    expect(result.next.intervalDays).toBe(1)
    expect(result.next.dueAt).toBe('2026-03-11')
  })
})

describe('review', () => {
  it(`steps the interval up after ${REVIEW_ADVANCE_THRESHOLD} correct due dates`, () => {
    // Due 03-10 on a one-day interval, so the three answers land on 03-10,
    // 03-11 and 03-12, and the new three-day interval runs from there.
    const result = answerOnSchedule(
      dueReview(1),
      true,
      REVIEW_ADVANCE_THRESHOLD,
    )

    expect(result.next.stage).toBe('review')
    expect(result.next.intervalDays).toBe(3)
    expect(result.next.dueAt).toBe('2026-03-15')
  })

  it('holds the interval steady on a correct answer below the threshold', () => {
    const result = advance(dueReview(7), true, TODAY, NOW)

    expect(result.next.intervalDays).toBe(7)
    expect(result.next.dueAt).toBe('2026-03-17')
  })

  it('climbs the whole ladder and then converts the bump into mastery', () => {
    let current = dueReview(1)
    const seen: (number | null)[] = []

    // Each group of correct answers is one rung, one answer per due date.
    for (let rung = 0; rung < 5; rung += 1) {
      current = answerOnSchedule(current, true, REVIEW_ADVANCE_THRESHOLD).next
      seen.push(current.intervalDays)
    }

    expect(seen).toEqual([3, 7, 14, 30, MAX_INTERVAL_DAYS])
    expect(current.stage).toBe('mastered')
  })

  it('resets to a one-day interval on a single miss', () => {
    const result = advance(dueReview(30), false, TODAY, NOW)

    expect(result.next.intervalDays).toBe(1)
    expect(result.next.dueAt).toBe('2026-03-11')
    expect(result.needsRefill).toBe(false)
  })

  it(`drops out of scheduling after ${REVIEW_DEMOTION_THRESHOLD} missed due dates`, () => {
    const result = answerOnSchedule(
      dueReview(7),
      false,
      REVIEW_DEMOTION_THRESHOLD,
    )

    expect(result.next.needsRelearning).toBe(true)
    expect(result.next.relearningQueuedAt).toBe(NOW)
    // Unscheduled: it waits for a learning slot rather than a due date.
    expect(result.next.intervalDays).toBeNull()
    expect(result.next.dueAt).toBeNull()
    expect(result.needsRefill).toBe(true)
    expect(result.bumpRelearning).toBe(true)
  })
})

describe('one counted answer per due date', () => {
  it('ignores extra repetitions of a review on the same day', () => {
    const first = advance(dueReview(1), true, TODAY, NOW)
    const second = advance(first.next, true, TODAY, NOW)
    const third = advance(second.next, true, TODAY, NOW)

    // Three exercises, one day's worth of progress.
    expect(first.next.consecutiveCorrect).toBe(1)
    expect(third.next).toEqual(first.next)
  })

  it(`cannot turn a one-day interval into ${INTERVAL_PROGRESSION[1]} days by drilling`, () => {
    // The scenario the rule exists for: a verse on a one-day interval owes
    // three separate days before it steps up, however many times it is
    // practised in any one of them.
    let current = dueReview(1)
    for (let i = 0; i < REVIEW_ADVANCE_THRESHOLD * 3; i += 1) {
      current = advance(current, true, TODAY, NOW).next
    }

    expect(current.intervalDays).toBe(1)
    expect(current.consecutiveCorrect).toBe(1)
    expect(current.dueAt).toBe('2026-03-11')
  })

  it('does not stack misses within a day either', () => {
    const result = answerRepeatedly(
      dueReview(7),
      false,
      REVIEW_DEMOTION_THRESHOLD,
    )

    expect(result.next.needsRelearning).toBe(false)
    expect(result.next.consecutiveIncorrect).toBe(1)
    expect(result.bumpRelearning).toBe(false)
  })

  it('ignores an answer for a verse that is not due yet', () => {
    const notYet = dueReview(7, { dueAt: '2026-03-20' })

    const result = advance(notYet, true, TODAY, NOW)

    expect(result.next).toEqual(notYet)
  })

  it('ignores an answer for a verse parked in relearning', () => {
    const parked = progress({
      stage: 'review',
      slot: null,
      needsRelearning: true,
      intervalDays: null,
      dueAt: null,
    })

    const result = advance(parked, false, TODAY, NOW)

    expect(result.next).toEqual(parked)
    expect(result.bumpRelearning).toBe(false)
  })

  it('leaves a verse that graduated today alone for the rest of it', () => {
    // Graduation sets due_at to tomorrow, so the learning repetitions still
    // queued behind it today must not buy review credit.
    const graduated = answerRepeatedly(
      progress({ stage: 'learning_heavy', slot: 2 }),
      true,
      TIER_ADVANCE_THRESHOLD,
    )

    const leftover = advance(graduated.next, true, TODAY, NOW)

    expect(leftover.next).toEqual(graduated.next)
    expect(leftover.next.consecutiveCorrect).toBe(0)
  })

  it('still counts an overdue review', () => {
    // Late is not the same as unscheduled: the due date has passed, so the
    // answer counts and the next one is measured from today.
    const overdue = dueReview(3, { dueAt: '2026-03-01' })

    const result = advance(overdue, true, TODAY, NOW)

    expect(result.next.consecutiveCorrect).toBe(1)
    expect(result.next.dueAt).toBe('2026-03-13')
  })

  it('ignores extra repetitions of a mastered verse on the same day', () => {
    const mastered = dueReview(MAX_INTERVAL_DAYS, { stage: 'mastered' })

    const first = advance(mastered, true, TODAY, NOW)
    const second = advance(first.next, false, TODAY, NOW)

    // Even a miss is inert once the day's review has been counted.
    expect(second.next).toEqual(first.next)
    expect(second.next.stage).toBe('mastered')
  })
})

describe('mastered', () => {
  it('stays mastered on a correct answer, on the long interval', () => {
    const result = advance(
      dueReview(MAX_INTERVAL_DAYS, { stage: 'mastered' }),
      true,
      TODAY,
      NOW,
    )

    expect(result.next.stage).toBe('mastered')
    expect(result.next.intervalDays).toBe(MAX_INTERVAL_DAYS)
    expect(result.next.dueAt).toBe('2026-04-09')
  })

  it('loses mastery on a single miss, carrying one strike into review', () => {
    const result = advance(
      dueReview(MAX_INTERVAL_DAYS, { stage: 'mastered' }),
      false,
      TODAY,
      NOW,
    )

    expect(result.next.stage).toBe('review')
    expect(result.next.intervalDays).toBe(1)
    // The miss that cost mastery is also the first strike toward review's
    // two-miss demotion, so one more sends it to relearning — on the next due
    // date, not later the same afternoon.
    expect(result.next.consecutiveIncorrect).toBe(1)

    const secondMiss = advance(result.next, false, '2026-03-11', NOW)
    expect(secondMiss.next.needsRelearning).toBe(true)
  })
})

describe('purity', () => {
  it('does not mutate the progress it is given', () => {
    const before = progress({ stage: 'learning_light' })
    const snapshot = { ...before }

    advance(before, true, TODAY, NOW)

    expect(before).toEqual(snapshot)
  })

  it.each<Stage>([
    'learning_light',
    'learning_medium',
    'learning_heavy',
    'review',
    'mastered',
  ])('returns a transition for stage %s', (stage) => {
    const result = advance(progress({ stage }), true, TODAY, NOW)
    expect(result.next).toBeDefined()
  })
})
