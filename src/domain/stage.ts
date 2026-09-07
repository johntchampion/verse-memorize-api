/**
 * Learning tiers are held in a slot and advance on same-day answer streaks;
 * review and mastered are unslotted and advance along an interval ladder.
 */
import type { ExerciseType } from '../db/rows'

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

export function isReviewStage(stage: Stage): boolean {
  return stage === 'review' || stage === 'mastered'
}

/** Null at the top of the ladder, which is the signal to graduate. */
export function nextLearningStage(stage: Stage): Stage | null {
  const tier = (LEARNING_STAGES as readonly Stage[]).indexOf(stage)
  if (tier === -1 || tier === LEARNING_STAGES.length - 1) return null
  return LEARNING_STAGES[tier + 1]
}

/** Null at the floor: learning_light has nowhere to fall to. */
export function previousLearningStage(stage: Stage): Stage | null {
  const tier = (LEARNING_STAGES as readonly Stage[]).indexOf(stage)
  if (tier <= 0) return null
  return LEARNING_STAGES[tier - 1]
}

/** The three learning tiers collapse into `active`: the browse list shows
    whether a verse is being worked on, not how hard the drill is. */
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

/** `density` is the fraction of words blanked; tiles vs. typing follows it. */
export const STAGE_RULES: Record<
  Stage,
  { density: number; type: ExerciseType }
> = {
  learning_light: { density: 0.18, type: 'tile_fill_blank' },
  learning_medium: { density: 0.5, type: 'tile_fill_blank' },
  learning_heavy: { density: 0.8, type: 'tile_fill_blank' },
  review: { density: 1, type: 'tile_fill_blank' },
  mastered: { density: 1, type: 'type_fill_blank' },
}
