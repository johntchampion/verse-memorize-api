/**
 * Classifying what an attempt moved, for the completion screen's recap.
 * Pure, like progression.ts: the caller owns the writing.
 */
import { isLearningStage, LEARNING_STAGES, type Stage } from './stage'
import type { Transition } from './progression'
import type { UserVerse } from '../models/UserVerse'

export type SessionEventKind =
  | 'tier_up'
  | 'tier_down'
  | 'graduated'
  | 'mastered'
  | 'lost_mastery'
  /** Out of review and straight back into a slot, because one was free. */
  | 'demoted_to_learning'
  /** Slipped twice in review with no slot free: unscheduled, waiting. */
  | 'relearning_queued'
  | 'slot_filled'
  | 'slot_returned'

export interface NewSessionEvent {
  kind: SessionEventKind
  userVerseId: string
  verseId: string
  stageFrom: Stage | null
  stageTo: Stage | null
  slot: number | null
}

/**
 * How one attempt moved its verse, or null when it moved nothing.
 *
 * `after` is the row once the whole transaction has run, refill included, which
 * is what makes the first branch necessary: a review verse that fails twice
 * with a free slot is re-seated at heavy in the same breath, so by the time we
 * look, `needsRelearning` has already been cleared again. Only when no slot was
 * free does the verse sit there flagged, and that case is invisible to a stage
 * comparison because the stage never changed.
 */
export function attemptEventKind(
  from: Stage,
  after: UserVerse,
  transition: Transition,
): SessionEventKind | null {
  const to = after.stage

  if (from === 'review' && to === 'learning_heavy') return 'demoted_to_learning'
  if (after.needsRelearning) return 'relearning_queued'
  if (from === to) return null

  if (isLearningStage(from) && isLearningStage(to)) {
    const tiers = LEARNING_STAGES as readonly Stage[]
    return tiers.indexOf(to) > tiers.indexOf(from) ? 'tier_up' : 'tier_down'
  }

  // The transition already knows which of the two ways into review this was;
  // it is more reliable than inferring it from the stage the verse came from.
  if (to === 'review')
    return transition.graduated ? 'graduated' : 'lost_mastery'
  if (to === 'mastered') return 'mastered'

  return null
}

/**
 * A slot that just filled. A row carrying a `graduatedAt` has been through
 * learning before — it is a verse coming back, not a new one arriving.
 */
export function slotEventKind(row: UserVerse): SessionEventKind {
  return row.graduatedAt !== null ? 'slot_returned' : 'slot_filled'
}

/** The event an attempt produced, ready to record, or null if it moved nothing. */
export function attemptEvent(
  from: Stage,
  after: UserVerse,
  transition: Transition,
): NewSessionEvent | null {
  const kind = attemptEventKind(from, after, transition)
  if (!kind) return null
  return {
    kind,
    userVerseId: after.id,
    verseId: after.verseId,
    stageFrom: from,
    stageTo: after.stage,
    slot: after.slot,
  }
}

/** The event a slot refill produced, ready to record. */
export function slotEvent(row: UserVerse): NewSessionEvent {
  return {
    kind: slotEventKind(row),
    userVerseId: row.id,
    verseId: row.verseId,
    stageFrom: null,
    stageTo: null,
    slot: row.slot,
  }
}
