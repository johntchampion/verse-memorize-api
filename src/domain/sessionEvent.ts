/**
 * What moved, said once, so every reader says the same thing about it.
 *
 * The completion screen recaps a session: which verses climbed a tier, which
 * graduated, which slipped, and which took a newly empty slot. That recap used
 * to be assembled in the client by comparing the stage it had cached against
 * the one an attempt came back with. Two things were wrong with that. It could
 * only remember the current sitting, so a session resumed after a quit lost
 * everything earned before it; and the cached stage went stale the moment a
 * verse upgraded, because the same verse is drilled three times a day and the
 * two remaining repetitions still held the old value, re-reporting a move that
 * had already happened.
 *
 * So the classification happens here instead, against the row as it actually
 * stands, and the result is recorded. Pure, like progression.ts: the caller
 * owns the writing.
 */
import { LEARNING_STAGES, type Stage } from './stage'
import type { Transition } from './progression'
import type { UserVerse } from './userVerse'

export type SessionEventKind =
  /** Climbed or slipped a learning tier. */
  | 'tier_up'
  | 'tier_down'
  /** Off the top of the learning ladder and into review. */
  | 'graduated'
  /** Review's ceiling, reached and lost. */
  | 'mastered'
  | 'lost_mastery'
  /** Out of review and straight back into a slot, because one was free. */
  | 'demoted_to_learning'
  /** Slipped twice in review with no slot free: unscheduled, waiting. */
  | 'relearning_queued'
  /** A slot filled from the queue — a verse arriving, or one coming back. */
  | 'slot_filled'
  | 'slot_returned'

/** What a caller hands the repository to record. */
export interface NewSessionEvent {
  kind: SessionEventKind
  userVerseId: string
  verseId: string
  stageFrom: Stage | null
  stageTo: Stage | null
  slot: number | null
}

function isLearningTier(stage: Stage): boolean {
  return (LEARNING_STAGES as readonly Stage[]).includes(stage)
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

  if (isLearningTier(from) && isLearningTier(to)) {
    const climbed =
      (LEARNING_STAGES as readonly Stage[]).indexOf(to) >
      (LEARNING_STAGES as readonly Stage[]).indexOf(from)
    return climbed ? 'tier_up' : 'tier_down'
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
