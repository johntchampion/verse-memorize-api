import type { Stage } from './stage'

export type SessionQueue = 'review' | 'learning'

/** Holds no text or blanks: those are regenerated per read, so a translation
    switch is picked up immediately. Identity, order and stage are pinned. */
export interface PlannedExercise {
  id: string
  userVerseId: string
  queue: SessionQueue
  /** Repetition index within the day; feeds the exercise seed. */
  instance: number
  /** 0-based, fixed once assigned. */
  position: number
  /** Null for rows planned before the stage was pinned; they fall back to live. */
  stage: Stage | null
  completed: boolean
  /** Null while outstanding, and for anything answered before this was recorded
      — which is why the day's total counts trues, not not-falses. */
  correct: boolean | null
}
