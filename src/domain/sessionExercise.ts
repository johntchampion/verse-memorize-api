import type { SessionExerciseRow } from '../db/rows'
import type { Stage } from './stage'

/** Which queue a planned exercise was drawn from, so the client can label it. */
export type SessionQueue = 'review' | 'learning'

/**
 * One slot in a day's session: what to practice, at what difficulty, where in
 * the order, and whether it has been answered yet.
 *
 * Deliberately holds no verse text or blanks — those are regenerated on every
 * read, so a translation switch is picked up immediately. What is pinned is
 * everything that decides the exercise: identity, order, and the stage, so a
 * verse that graduates or changes tier mid-session doesn't rewrite the
 * repetitions still queued behind it.
 */
export interface PlannedExercise {
  id: string
  userVerseId: string
  queue: SessionQueue
  /** Repetition index within the day; feeds the exercise seed. */
  instance: number
  /** 0-based, fixed once assigned. */
  position: number
  /**
   * The verse's stage when the day was planned — the difficulty this exercise
   * holds for the rest of the day. Null only for rows planned before the stage
   * was pinned; those fall back to the verse's live stage.
   */
  stage: Stage | null
  completed: boolean
  /**
   * How it was answered, or null while outstanding. Also null for anything
   * answered before this was recorded, which is why the day's correct total
   * counts trues rather than subtracting falses.
   */
  correct: boolean | null
}

export function toPlannedExercise(row: SessionExerciseRow): PlannedExercise {
  return {
    id: row.id,
    userVerseId: row.user_verse_id,
    queue: row.queue,
    instance: row.instance,
    position: row.position,
    stage: row.stage,
    completed: row.completed_at !== null,
    correct: row.correct === null ? null : row.correct === 1,
  }
}
