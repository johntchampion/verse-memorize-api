import * as userVerses from '../db/userVerseRepository'
import { DEFAULT_TRANSLATION, getVerse } from '../data/verses'
import { todayInTimezone } from '../lib/dates'
import { isLearningStage, isReviewStage } from '../domain/stage'
import { buildExercise, type Exercise } from './exerciseBuilder'

/**
 * Exercise instances generated per learning verse per session. 2-3 is the
 * intended range — repeating a verse within one session is deliberate.
 */
export const EXERCISES_PER_LEARNING_VERSE = 3

export interface SessionExercise extends Exercise {
  stage: string
  /** Which queue the item came from, so the client can label it. */
  queue: 'review' | 'learning'
}

/**
 * Builds today's ordered exercise queue for a user.
 *
 * Review items are due-dated; learning items repeat 2-3x each. The two queues
 * are interleaved round-robin *by verse* so the user never grinds one verse
 * back to back.
 */
export function buildTodaySession(
  userId: string,
  timezone: string,
  translation: string = DEFAULT_TRANSLATION,
): SessionExercise[] {
  const today = todayInTimezone(timezone)

  // Each active verse contributes its own run of exercises; the runs are
  // drained round-robin below so no verse is drilled back to back.
  const runs: SessionExercise[][] = []

  for (const progress of userVerses.allForUser(userId)) {
    const verse = getVerse(progress.verseId, translation)
    if (!verse) continue // Verse pulled from the bank; skip rather than 500.

    if (isReviewStage(progress.stage)) {
      // A null dueAt means unscheduled — a verse queued for relearning sits
      // out of the rotation until a slot picks it up.
      if (!progress.dueAt || progress.dueAt > today) continue
      runs.push([
        {
          ...buildExercise(verse, progress.id, progress.stage),
          stage: progress.stage,
          queue: 'review',
        },
      ])
      continue
    }

    if (isLearningStage(progress.stage) && progress.slot !== null) {
      runs.push(
        Array.from({ length: EXERCISES_PER_LEARNING_VERSE }, (_, instance) => ({
          ...buildExercise(verse, progress.id, progress.stage, instance),
          stage: progress.stage,
          queue: 'learning' as const,
        })),
      )
    }
  }

  const queue: SessionExercise[] = []
  const longestRun = Math.max(0, ...runs.map((run) => run.length))
  for (let i = 0; i < longestRun; i += 1) {
    for (const run of runs) {
      if (i < run.length) queue.push(run[i])
    }
  }

  return queue
}
