import { describe, expect, it } from 'vitest'
import { attemptEventKind, slotEventKind } from '../src/domain/sessionEvent'
import type { Transition } from '../src/domain/progression'
import type { UserVerse } from '../src/domain/userVerse'
import type { Stage } from '../src/domain/stage'

/**
 * The classifier is pure, so every branch is reachable here — including the
 * ones that need a state the HTTP surface can only be walked into with a lot of
 * setup, like a review verse demoted straight back into a slot that happened to
 * be free.
 */

function verse(overrides: Partial<UserVerse> = {}): UserVerse {
  return {
    id: 'uv-1',
    userId: 'user-1',
    verseId: 'john-3-16',
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
    activatedAt: '2026-01-01T00:00:00.000Z',
    graduatedAt: null,
    ...overrides,
  }
}

function transition(overrides: Partial<Transition> = {}): Transition {
  return {
    next: {} as Transition['next'],
    graduated: false,
    needsRefill: false,
    bumpRelearning: false,
    ...overrides,
  }
}

function kindFor(
  from: Stage,
  after: Partial<UserVerse>,
  t: Partial<Transition> = {},
) {
  return attemptEventKind(from, verse(after), transition(t))
}

describe('attemptEventKind', () => {
  it('reports nothing when the verse did not move', () => {
    expect(kindFor('learning_light', { stage: 'learning_light' })).toBeNull()
  })

  it('names a climb and a slip between learning tiers', () => {
    expect(kindFor('learning_light', { stage: 'learning_medium' })).toBe(
      'tier_up',
    )
    expect(kindFor('learning_heavy', { stage: 'learning_medium' })).toBe(
      'tier_down',
    )
  })

  it('distinguishes graduating into review from falling into it', () => {
    expect(
      kindFor(
        'learning_heavy',
        { stage: 'review', slot: null, graduatedAt: '2026-01-02T00:00:00Z' },
        { graduated: true },
      ),
    ).toBe('graduated')

    expect(kindFor('mastered', { stage: 'review', slot: null })).toBe(
      'lost_mastery',
    )
  })

  it('reports mastery', () => {
    expect(kindFor('review', { stage: 'mastered', slot: null })).toBe(
      'mastered',
    )
  })

  it('reports a park for relearning, which no stage comparison could see', () => {
    // The verse stayed in review; only the flag moved.
    expect(
      kindFor('review', {
        stage: 'review',
        slot: null,
        needsRelearning: true,
      }),
    ).toBe('relearning_queued')
  })

  it('reports a demotion re-seated into a free slot exactly once', () => {
    // The refill runs in the same transaction, so needsRelearning is already
    // back to false by the time the row is read. Reported as the demotion it
    // is, not as a park plus a slot fill.
    expect(
      kindFor('review', {
        stage: 'learning_heavy',
        slot: 2,
        needsRelearning: false,
        graduatedAt: '2026-01-01T00:00:00Z',
      }),
    ).toBe('demoted_to_learning')
  })
})

describe('slotEventKind', () => {
  it('tells a returning verse from a new one by its graduation stamp', () => {
    expect(slotEventKind(verse({ graduatedAt: null }))).toBe('slot_filled')
    expect(slotEventKind(verse({ graduatedAt: '2026-01-01T00:00:00Z' }))).toBe(
      'slot_returned',
    )
  })
})
