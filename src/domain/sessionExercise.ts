import type { SessionExerciseRow } from '../db/rows'

/** Which queue a planned exercise was drawn from, so the client can label it. */
export type SessionQueue = 'review' | 'learning'

/**
 * One slot in a day's session: what to practice and where in the order, plus
 * whether it has been answered yet.
 *
 * Deliberately holds no verse text, stage or blanks. The exercise itself is
 * regenerated on every read from the verse's current state, so a verse that
 * upgrades a tier mid-session gets harder repetitions and a translation switch
 * is picked up immediately — only the identity and the order are pinned.
 */
export interface PlannedExercise {
  id: string
  userVerseId: string
  queue: SessionQueue
  /** Repetition index within the day; feeds the exercise seed. */
  instance: number
  /** 0-based, fixed once assigned. */
  position: number
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
    completed: row.completed_at !== null,
    correct: row.correct === null ? null : row.correct === 1,
  }
}
