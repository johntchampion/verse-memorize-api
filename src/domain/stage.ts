/**
 * The stage a verse occupies, and every question the app asks about one.
 *
 * A verse moves through three learning tiers, graduates to `review`, and may
 * reach `mastered`. Those are two different regimes: learning tiers are held in
 * a slot and advance on same-day answer streaks, while review and mastered are
 * unslotted and advance along an interval ladder.
 *
 * This module imports nothing. That is deliberate — stage questions are asked
 * from the routes, the services and the exercise builder alike, and a leaf
 * module lets all of them share one answer instead of re-deriving it.
 */

export type Stage =
  | 'learning_light'
  | 'learning_medium'
  | 'learning_heavy'
  | 'review'
  | 'mastered'

/** The learning tiers, easiest first. Index order *is* the progression. */
export const LEARNING_STAGES = [
  'learning_light',
  'learning_medium',
  'learning_heavy',
] as const satisfies readonly Stage[]

export function isLearningStage(stage: Stage): boolean {
  return (LEARNING_STAGES as readonly Stage[]).includes(stage)
}

/** Stages that surface in the review queue. */
export function isReviewStage(stage: Stage): boolean {
  return stage === 'review' || stage === 'mastered'
}

/**
 * The next tier up, or null at the top of the ladder. A null return is the
 * signal to graduate: there is no learning stage after `learning_heavy`.
 */
export function nextLearningStage(stage: Stage): Stage | null {
  const tier = (LEARNING_STAGES as readonly Stage[]).indexOf(stage)
  if (tier === -1 || tier === LEARNING_STAGES.length - 1) return null
  return LEARNING_STAGES[tier + 1]
}

/**
 * The next tier down, or null at the floor. `learning_light` has nowhere to
 * fall to, so misses there change nothing.
 */
export function previousLearningStage(stage: Stage): Stage | null {
  const tier = (LEARNING_STAGES as readonly Stage[]).indexOf(stage)
  if (tier <= 0) return null
  return LEARNING_STAGES[tier - 1]
}

/**
 * Browse-screen status for a verse. Every verse is viewable — "not started"
 * just means the user has no progress against it yet. The three learning tiers
 * collapse into one `active` status because the browse list shows whether a
 * verse is being worked on, not how hard the drill currently is.
 */
export type VerseStatus = 'not_started' | 'active' | 'review' | 'mastered'

export function browseStatusFor(stage: Stage | undefined): VerseStatus {
  switch (stage) {
    case undefined:
      return 'not_started'
    case 'learning_light':
    case 'learning_medium':
    case 'learning_heavy':
      return 'active'
    case 'mastered':
      return 'mastered'
    case 'review':
      return 'review'
  }
}
