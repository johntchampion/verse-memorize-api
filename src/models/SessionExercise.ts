import type { UserVerseRow } from '../db/rows'
import { getVerse } from '../data/verses'
import type { SessionQueue } from '../domain/sessionExercise'
import type { Stage } from '../domain/stage'
import { buildExercise, type Exercise } from '../services/exerciseBuilder'
import type { UserVerse } from './UserVerse'

export interface SessionExercise extends Exercise {
  /** What the exercise was built at, which may no longer be `userVerse`'s stage. */
  stage: Stage
  queue: SessionQueue
  completed: boolean
  correct: boolean | null
  userVerse: UserVerseRow
}

export interface RenderRequest {
  verse: UserVerse
  translation: string
  stage: Stage
  queue: SessionQueue
  instance: number
  completed: boolean
  correct: boolean | null
}

/**
 * The day's session passes the stage pinned when the day was planned, a drill
 * passes the verse's live one; blanks regenerate from `verseId:stage:instance`.
 * `userVerse` carries progress as it stands *now* regardless, so a client sees a
 * graduation immediately without the queued repetitions changing difficulty.
 * Null when the verse has left the bank: skip rather than 500.
 */
export function renderExercise({
  verse,
  translation,
  stage,
  queue,
  instance,
  completed,
  correct,
}: RenderRequest): SessionExercise | null {
  const text = getVerse(verse.verseId, translation)
  if (!text) return null

  return {
    ...buildExercise(text, verse.id, stage, instance),
    stage,
    queue,
    completed,
    correct,
    userVerse: verse.toLegacyBody(),
  }
}
