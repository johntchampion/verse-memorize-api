import { db } from '../db/client'
import { DEFAULT_TRANSLATION } from '../data/verses'
import type { PlannedExercise } from '../domain/sessionExercise'
import { isLearningStage, isReviewStage } from '../domain/stage'
import * as planned from '../repositories/sessionExerciseRepository'
import type { NewPlanItem } from '../repositories/sessionExerciseRepository'
import * as userVerses from '../repositories/userVerseRepository'
import { renderExercise, type SessionExercise } from './SessionExercise'

/** Repeating a verse within one session is deliberate; 2-3 is the range. */
export const EXERCISES_PER_LEARNING_VERSE = 3

/**
 * The day's work is settled the first time the day is touched and nothing after
 * adds to or removes from it — which is what lets a client that quit resume
 * into the list it left.
 */
export class DailySession {
  constructor(
    private readonly userId: string,
    private readonly date: string,
  ) {}

  /** A day whose desired set is empty writes nothing, so it is planned again
      next call rather than frozen empty. */
  ensurePlan(): PlannedExercise[] {
    return ensurePlanTransaction(this.userId, this.date)
  }

  exercises(translation: string = DEFAULT_TRANSLATION): SessionExercise[] {
    const plan = this.ensurePlan()
    const byId = new Map(
      userVerses.allForUser(this.userId).map((verse) => [verse.id, verse]),
    )

    const session: SessionExercise[] = []
    for (const item of plan) {
      const verse = byId.get(item.userVerseId)
      if (!verse) continue // Verse deleted out from under the plan.
      const exercise = renderExercise({
        verse,
        translation,
        // Null only for a day planned before stages were pinned; those rows
        // keep the old live-stage behavior until the day rolls over.
        stage: item.stage ?? verse.stage,
        queue: item.queue,
        instance: item.instance,
        completed: item.completed,
        correct: item.correct,
      })
      if (exercise) session.push(exercise)
    }
    return session
  }

  /** False when the verse has nothing left today — the normal case for extra
      practice after the session. */
  completeNextForVerse(
    userVerseId: string,
    now: string,
    correct: boolean,
  ): boolean {
    return planned.completeNext(
      this.userId,
      this.date,
      userVerseId,
      now,
      correct,
    )
  }

  prunePastDays(): void {
    planned.pruneBefore(this.userId, this.date)
  }
}

/** Never touches the verse bank: verse_id is translation-independent, so a plan
    built while reading one translation is valid for every other. */
function desiredItems(userId: string, today: string): NewPlanItem[] {
  const runs: NewPlanItem[][] = []

  for (const verse of userVerses.allForUser(userId)) {
    if (isReviewStage(verse.stage)) {
      // The same predicate the progression rules use, so a verse is never
      // served an exercise that can't move its schedule. A null dueAt means
      // unscheduled — a relearner sits out until a slot picks it up.
      if (!verse.isDue(today)) continue
      runs.push([
        {
          userVerseId: verse.id,
          queue: 'review',
          instance: 0,
          stage: verse.stage,
        },
      ])
      continue
    }

    if (isLearningStage(verse.stage) && verse.slot !== null) {
      runs.push(
        Array.from({ length: EXERCISES_PER_LEARNING_VERSE }, (_, instance) => ({
          userVerseId: verse.id,
          queue: 'learning' as const,
          instance,
          // Pinned, not read again at render time: all three repetitions are
          // the ones planned this morning, however the verse moves after.
          stage: verse.stage,
        })),
      )
    }
  }

  return interleave(runs)
}

/** Round-robin by verse, so a user never drills the same verse back to back. */
function interleave(runs: NewPlanItem[][]): NewPlanItem[] {
  const items: NewPlanItem[] = []
  const longest = Math.max(0, ...runs.map((run) => run.length))
  for (let i = 0; i < longest; i += 1) {
    for (const run of runs) {
      if (i < run.length) items.push(run[i])
    }
  }
  return items
}

const ensurePlanTransaction = db.transaction(
  (userId: string, today: string): PlannedExercise[] => {
    const existing = planned.forDay(userId, today)
    if (existing.length > 0) return existing

    const items = desiredItems(userId, today)
    if (items.length === 0) return existing

    planned.create(userId, today, items)
    return planned.forDay(userId, today)
  },
)
